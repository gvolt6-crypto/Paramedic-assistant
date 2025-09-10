import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Share, Alert, Platform } from "react-native";
import Voice from "@react-native-voice/voice";

/**
 * 🚑 Paramedic Assistant — Standalone (Android APK via EAS)
 * - Always-on mic (press & hold to talk or tap start/stop)
 * - Auto-timestamps; vitals/meds parsing; quick MARK buttons
 * - Drip calculators (gtt/min, mL/hr, mcg/kg/min → mL/hr)
 * - Local protocol Q&A (paste text) with citations-like snippets
 * - Export summary (share)
 * NOTE: Mic works because this APK includes @react-native-voice/voice + RECORD_AUDIO.
 */

const now = () => Date.now();
function fmtClock(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/* -------------------- SIMPLE PARSERS -------------------- */
function parseBP(text) {
  const t = text.toLowerCase();
  const numOver = t.match(/(\d{2,3})\s*(?:\/|\bover\b)\s*(\d{2,3})/);
  if (numOver) return `${numOver[1]}/${numOver[2]}`;
  return null;
}
function parseUtterance(utterance, at) {
  const foundVitals = [], foundMeds = [];
  const t = utterance.toLowerCase();

  if (/\b(bp|blood pressure)\b/.test(t)) {
    const bp = parseBP(utterance);
    if (bp) foundVitals.push({ kind: "BP", value: bp, at });
  }
  const hr = t.match(/\b(heart rate|hr|pulse)\b[^\d]*(\d{2,3})/);
  if (hr) foundVitals.push({ kind: "HR", value: hr[2], at });

  const rr = t.match(/\b(resp(iratory)? rate|rr|resps?)\b[^\d]*(\d{1,2})/);
  if (rr) foundVitals.push({ kind: "RR", value: rr[2] || rr[3] || rr[1], at });

  const spo = t.match(/\b(spo2|sat(s|uration)?|oxygen\s+saturation)\b[^\d]*(\d{2,3})/);
  if (spo) foundVitals.push({ kind: "SpO2", value: `${spo[3]}%`, at });

  const tmp = t.match(/\b(temp(erature)?)\b[^\d]*(\d{2,3}(?:\.\d+)?)\s*(c|f)?/);
  if (tmp) {
    const unit = tmp[4] ? tmp[4].toUpperCase() : (Number(tmp[3]) > 45 ? "F" : "C");
    foundVitals.push({ kind: "Temp", value: `${tmp[3]} ${unit}`, at });
  }

  const gcs = t.match(/\bgcs\b[^\d]*(\d{1,2})/);
  if (gcs) foundVitals.push({ kind: "GCS", value: gcs[1], at });

  const et = t.match(/\b(etco2|end\s*tidal)\b[^\d]*(\d{2,3})/);
  if (et) foundVitals.push({ kind: "EtCO2", value: et[2] || et[1], at });

  const glu = t.match(/\b(glucose|cbg|dextro)\b[^\d]*(\d{2,3})/);
  if (glu) foundVitals.push({ kind: "Glucose", value: glu[2] || glu[1], at });

  const medRegex = new RegExp(String.raw`\b(give|administer|push|start(ed)?|bolus|begin)\b[^a-zA-Z0-9%]*(?:of\s+)?([a-zA-Z][a-zA-Z\- ]{1,40}?)[,\s]+(\d+(?:\.\d+)?)\s*(mcg|mg|g|units|ml|l)\b(?:\s*(?:per)?\s*(kg))?(?:\s*/\s*(min|hr))?(?:\s*(iv|im|io|po|pr|sq|nebulized|inhaled))?`,"i");
  const m = utterance.match(medRegex);
  if (m) {
    const rawDrug = m[3], rawDose = m[4], unit = m[5], perKg = m[6], perTime = m[7], route = m[8];
    const drug = rawDrug.trim();
    const dose = `${rawDose} ${unit}${perKg ? "/kg" : ""}`;
    const rate = perTime ? `${rawDose} ${unit}${perKg ? "/kg" : ""}/${perTime}` : undefined;
    foundMeds.push({ drug, dose, route: route ? route.toUpperCase() : undefined, rate, at });
  }

  return { foundVitals, foundMeds };
}

/* -------------------- CALCULATORS -------------------- */
function calcGttPerMin(totalmL, minutes, gttFactor) {
  if (!totalmL || !minutes || !gttFactor) return null;
  return Math.round((totalmL * gttFactor) / minutes);
}
function calcMlPerHour(doseMgPerHr, concMgPerMl) {
  if (!doseMgPerHr || !concMgPerMl) return null;
  return +(doseMgPerHr / concMgPerMl).toFixed(2);
}
function calcWeightBasedInfusion(mcgPerKgMin, kg, concMgPerMl) {
  if (!mcgPerKgMin || !kg || !concMgPerMl) return null;
  const mgPerKgMin = mcgPerKgMin / 1000.0;
  const mgPerHr = mgPerKgMin * kg * 60.0;
  return +(mgPerHr / concMgPerMl).toFixed(2);
}

/* -------------------- LOCAL TF–IDF -------------------- */
function tok(s){ return s.toLowerCase().split(/[^a-z0-9.%:/-]+/).filter(Boolean); }
function splitDoc(doc, targetSize=900){
  const paras = doc.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
  const chunks=[]; let buf=[]; let i=0;
  const flush = () => { const text = buf.join("\n\n"); chunks.push({ id:`c${i++}`, text, hint: guessHint(text) }); buf=[]; };
  for(const p of paras){ if(buf.join("\n\n").length + p.length > targetSize && buf.length) flush(); buf.push(p); }
  if(buf.length) flush(); return chunks;
}
function guessHint(text){ const lines=text.split(/\n/).map(l=>l.trim()); const caps=lines.find(l=>l.length>=5 && l===l.toUpperCase()); return caps||undefined; }
function buildIndex(chunks){
  const tf=new Map(), df=new Map(), N=chunks.length;
  for(const ch of chunks){ const terms=tok(ch.text); const m=new Map(); for(const t of terms) m.set(t,(m.get(t)||0)+1); tf.set(ch.id,m); const seen=new Set(terms); for(const t of seen) df.set(t,(df.get(t)||0)+1); }
  const idf=new Map(); for(const [t,n] of df) idf.set(t, Math.log((N+1)/(n+0.5))+1); return { tf, idf };
}
function vec(text,idf){ const v=new Map(); for(const t of tok(text)) v.set(t,(v.get(t)||0)+1); for(const [t,w] of v) v.set(t, w*(idf.get(t)||0)); return v; }
function cosine(a,b){ let dot=0,na=0,nb=0; for(const[,va] of a) na+=va*va; for(const[,vb] of b) nb+=vb*vb; const small=a.size<=b.size?a:b, large=a.size<=b.size?b:a; for(const[t,v] of small){ const u=large.get(t); if(u) dot+=v*u; } const denom=Math.sqrt(na)*Math.sqrt(nb)||1; return dot/denom; }
function bestSents(text, query, max=3){ const sents=text.replace(/\n+/g," ").split(/(?<=[.!?])\s+/).filter(Boolean); const q=tok(query); const score=s=>{const h=s.toLowerCase();let sc=0;for(const w of q) if(h.includes(w)) sc++;return sc;}; return sents.map(s=>({s,sc:score(s)})).filter(x=>x.sc>0).sort((a,b)=>b.sc-a.sc).slice(0,max).map(x=>x.s); }

/* -------------------- APP -------------------- */
export default function App(){
  const [session,setSession]=useState(false);
  const [events,setEvents]=useState([]); // { text, at, kind }
  const [vitals,setVitals]=useState([]); // { kind, value, at }
  const [meds,setMeds]=useState([]);     // { drug, dose, route?, rate?, at }
  const [utter,setUtter]=useState("");

  // mic state
  const [listening,setListening]=useState(false);
  const partialRef = useRef("");

  // calculators
  const [calcA,setCalcA]=useState({ totalmL:"", minutes:"", gtt:"" });
  const [calcB,setCalcB]=useState({ mgHr:"", conc:"" });
  const [calcC,setCalcC]=useState({ mcgKgMin:"", kg:"", conc:"" });

  // protocols Q&A
  const [protoText,setProtoText]=useState("");
  const [query,setQuery]=useState("");
  const [chunks,setChunks]=useState([]);
  const [index,setIndex]=useState(null);

  useEffect(()=>{
    Voice.onSpeechStart = () => setListening(true);
    Voice.onSpeechEnd   = () => setListening(false);
    Voice.onSpeechError = (e) => { setListening(false); Alert.alert("Mic error", String(e?.error?.message || e)); };
    Voice.onSpeechResults = (e) => {
      const text = e.value?.[0];
      if (!text) return;
      // commit final result
      commitUtterance(text);
    };
    Voice.onSpeechPartialResults = (e) => {
      const text = e.value?.[0];
      if (text) partialRef.current = text;
    };
    return () => { Voice.destroy().then(Voice.removeAllListeners); };
  },[]);

  async function startListening(){
    try{
      if (Platform.OS === "android") {
        // start in default locale; you can pass "en-US" if needed
        await Voice.start("en-US");
      }
    }catch(e){
      Alert.alert("Mic start failed", String(e));
    }
  }
  async function stopListening(){
    try{ await Voice.stop(); }catch(e){}
  }

  function commitUtterance(text){
    const at = now();
    setEvents(p=>[{ text, at, kind: "utterance" }, ...p]);
    const { foundVitals, foundMeds } = parseUtterance(text, at);
    if (foundVitals?.length) setVitals(p=>[...foundVitals, ...p]);
    if (foundMeds?.length) setMeds(p=>[...foundMeds, ...p]);
  }

  function manualAdd(){
    const t = utter.trim(); if(!t) return;
    commitUtterance(t); setUtter("");
  }

  function mark(label){ setEvents(p=>[{ text: label, at: now(), kind: "mark" }, ...p]); }

  // calculators
  const gtt = useMemo(()=>calcGttPerMin(+calcA.totalmL,+calcA.minutes,+calcA.gtt),[calcA]);
  const mlhr= useMemo(()=>calcMlPerHour(+calcB.mgHr,+calcB.conc),[calcB]);
  const mlinf=useMemo(()=>calcWeightBasedInfusion(+calcC.mcgKgMin,+calcC.kg,+calcC.conc),[calcC]);

  // protocols index
  useEffect(()=>{
    if(!protoText.trim()){ setChunks([]); setIndex(null); return; }
    const c = splitDoc(protoText); setChunks(c); setIndex(buildIndex(c));
  },[protoText]);

  const answers = useMemo(()=>{
    if(!index || !query.trim() || !chunks.length) return [];
    const qv = vec(query, index.idf);
    return chunks.map(ch=>({ ch, score: cosine(qv, vec(ch.text,index.idf)) }))
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5)
      .map(({ch,score})=>({ hint: ch.hint, score, sentences: bestSents(ch.text, query, 3), chunk: ch.text }));
  },[index, query, chunks]);

  const summary = useMemo(()=>{
    const lines = [];
    lines.push("=== Run Summary ===","");
    if (vitals.length){ lines.push("Vitals:"); [...vitals].reverse().forEach(v=>lines.push(`  [${fmtClock(v.at)}] ${v.kind}: ${v.value}`)); lines.push(""); }
    if (meds.length){ lines.push("Medications:"); [...meds].reverse().forEach(m=>{ const extras=[m.route,m.rate].filter(Boolean).join(" · "); lines.push(`  [${fmtClock(m.at)}] ${m.drug} – ${m.dose}${extras?` (${extras})`:""}`); }); lines.push(""); }
    if (events.length){ lines.push("Timeline:"); [...events].reverse().forEach(e=>lines.push(`  [${fmtClock(e.at)}] ${e.kind?.toUpperCase?.()||"EVT"}: ${e.text}`)); }
    lines.push("", "(Verify with local protocols / medical control)");
    return lines.join("\n");
  },[vitals, meds, events]);

  async function exportSummary(){ try{ await Share.share({ message: summary }); }catch{} }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.h1}>Paramedic Assistant</Text>

      {/* LIVE CALL */}
      <View style={styles.card}>
        <Text style={styles.h2}>Live Call</Text>
        <Text style={styles.muted}>Use mic or type. Everything is auto time-stamped.</Text>

        <View style={styles.row}>
          {!session ? (
            <Pressable style={[styles.btn, styles.primary]} onPress={()=>setSession(true)}><Text style={styles.btnText}>Start</Text></Pressable>
          ) : (
            <Pressable style={[styles.btn, styles.danger]} onPress={()=>setSession(false)}><Text style={styles.btnText}>Stop</Text></Pressable>
          )}
          <Pressable style={[styles.btn, styles.ghost]} onPress={exportSummary}><Text style={styles.btnText}>Export Summary</Text></Pressable>
        </View>

        <View style={styles.rowWrap}>
          {!listening ? (
            <Pressable style={[styles.pill, styles.pillBlue]} onPress={startListening}><Text style={styles.pillText}>🎤 Start</Text></Pressable>
          ) : (
            <Pressable style={[styles.pill, styles.pillRed]} onPress={stopListening}><Text style={styles.pillText}>■ Stop</Text></Pressable>
          )}
          <Pressable style={[styles.pill, styles.pillBlue]} onPress={()=>mark("ROSC")}><Text style={styles.pillText}>ROSC</Text></Pressable>
          <Pressable style={[styles.pill, styles.pillBlue]} onPress={()=>mark("Shock delivered")}><Text style={styles.pillText}>Shock</Text></Pressable>
          <Pressable style={[styles.pill, styles.pillBlue]} onPress={()=>mark("Epinephrine administered")}><Text style={styles.pillText}>Epi given</Text></Pressable>
          <Pressable style={[styles.pill, styles.pillBlue]} onPress={()=>mark("On scene")}><Text style={styles.pillText}>Arrive</Text></Pressable>
          <Pressable style={[styles.pill, styles.pillBlue]} onPress={()=>mark("Depart scene")}><Text style={styles.pillText}>Depart</Text></Pressable>
        </View>

        <TextInput style={styles.input} placeholder="Or type: BP 120/80, HR 92, give 4 mg ondansetron IV" value={utter} onChangeText={setUtter}/>
        <Pressable style={[styles.btn, styles.secondary]} onPress={manualAdd}><Text style={styles.btnText}>Add Utterance</Text></Pressable>

        <Text style={styles.h3}>Timeline</Text>
        {events.slice(0, 20).map((e, i) => <Text key={i} style={styles.li}>• [{fmtClock(e.at)}] {e.kind?.toUpperCase?.()||"EVT"}: {e.text}</Text>)}
        {!events.length && <Text style={styles.muted}>No events yet.</Text>}
      </View>

      {/* CALCULATORS */}
      <View style={styles.card}>
        <Text style={styles.h2}>Calculators</Text>
        <Text style={styles.muted}>Double-check with local protocols.</Text>

        <Text style={styles.h3}>Drip — gtt/min</Text>
        <View style={styles.rowWrap}>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="Total mL" value={calcA.totalmL} onChangeText={(v)=>setCalcA({...calcA,totalmL:v})}/>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="Minutes"  value={calcA.minutes}  onChangeText={(v)=>setCalcA({...calcA,minutes:v})}/>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="gtt factor" value={calcA.gtt} onChangeText={(v)=>setCalcA({...calcA,gtt:v})}/>
        </View>
        {gtt!=null ? <Text style={styles.result}>= {gtt} gtt/min</Text> : null}

        <Text style={styles.h3}>mL/hr from mg/hr</Text>
        <View style={styles.rowWrap}>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="mg/hr" value={calcB.mgHr} onChangeText={(v)=>setCalcB({...calcB,mgHr:v})}/>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="Conc mg/mL" value={calcB.conc} onChangeText={(v)=>setCalcB({...calcB,conc:v})}/>
        </View>
        {mlhr!=null ? <Text style={styles.result}>= {mlhr} mL/hr</Text> : null}

        <Text style={styles.h3}>mcg/kg/min → mL/hr</Text>
        <View style={styles.rowWrap}>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="mcg/kg/min" value={calcC.mcgKgMin} onChangeText={(v)=>setCalcC({...calcC,mcgKgMin:v})}/>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="Weight kg" value={calcC.kg} onChangeText={(v)=>setCalcC({...calcC,kg:v})}/>
          <TextInput style={styles.inputSmall} keyboardType="numeric" placeholder="Conc mg/mL" value={calcC.conc} onChangeText={(v)=>setCalcC({...calcC,conc:v})}/>
        </View>
        {mlinf!=null ? <Text style={styles.result}>= {mlinf} mL/hr</Text> : null}
      </View>

      {/* PROTOCOL Q&A (paste text) */}
      <View style={styles.card}>
        <Text style={styles.h2}>Protocols Q&A (Local)</Text>
        <Text style={styles.muted}>Paste protocol text below, then ask. Shows top matches with snippets.</Text>

        <TextInput style={[styles.input,{minHeight:120}]} placeholder="Paste protocol text here…" value={protoText} onChangeText={setProtoText} multiline/>
        <TextInput style={styles.input} placeholder="Ask: 'STEMI aspirin dose' or 'Epi 1:1000 anaphylaxis adult'" value={query} onChangeText={setQuery}/>

        {answers.length ? (
          <View>
            <Text style={styles.h3}>Answer</Text>
            <Text style={styles.li}>{answers.flatMap(a=>a.sentences).slice(0,3).join(" ")}</Text>
            <Text style={styles.h3}>Citations</Text>
            {answers.map((a,i)=>(
              <Text key={i} style={styles.li}>• [{i+1}] {a.hint?`${a.hint} — `:""}{a.sentences.length?a.sentences.join(" "):a.chunk.slice(0,160)+"…"} (score {a.score.toFixed(2)})</Text>
            ))}
          </View>
        ) : <Text style={styles.muted}>No matches yet.</Text>}
      </View>

      <View style={{height:64}}/>
      <Text style={styles.muted}>⚠️ Field aid only. Verify with local protocols. Protect PHI.</Text>
    </ScrollView>
  );
}

/* -------------------- STYLES -------------------- */
const styles = StyleSheet.create({
  container: { flex:1, backgroundColor:"#0b1020" },
  h1: { color:"#fff", fontSize:22, fontWeight:"700", marginBottom:12 },
  h2: { color:"#fff", fontSize:18, fontWeight:"700", marginBottom:6 },
  h3: { color:"#fff", fontSize:15, fontWeight:"700", marginTop:12, marginBottom:6 },
  muted: { color:"#9aa5b1", fontSize:12, marginBottom:8 },
  card: { backgroundColor:"#111834", borderRadius:14, padding:12, marginBottom:14, borderWidth:1, borderColor:"#1f2a4d" },
  row: { flexDirection:"row", gap:8, alignItems:"center", marginBottom:8 },
  rowWrap: { flexDirection:"row", flexWrap:"wrap", gap:8, marginVertical:6 },
  input: { backgroundColor:"#0f162e", color:"#fff", borderRadius:10, padding:10, borderWidth:1, borderColor:"#263256", marginVertical:6 },
  inputSmall: { backgroundColor:"#0f162e", color:"#fff", borderRadius:10, padding:10, borderWidth:1, borderColor:"#263256", width:110 },
  li: { color:"#e6ebf2", marginBottom:4 },
  btn: { paddingVertical:10, paddingHorizontal:14, borderRadius:10, borderWidth:1, borderColor:"#2f3b66" },
  primary: { backgroundColor:"#2b6fff", borderColor:"#2b6fff" },
  secondary: { backgroundColor:"#00b894", borderColor:"#00b894" },
  danger: { backgroundColor:"#ff4d4f", borderColor:"#ff4d4f" },
  ghost: { backgroundColor:"transparent" },
  btnText: { color:"#fff", fontWeight:"700" },
  pill: { paddingVertical:8, paddingHorizontal:12, borderRadius:999, backgroundColor:"#22408a", borderWidth:1, borderColor:"#2f3b66" },
  pillBlue: { backgroundColor:"#22408a" },
  pillRed: { backgroundColor:"#8a2222", borderColor:"#7a1c1c" },
  pillText: { color:"#fff", fontWeight:"700" },
  result: { color:"#fff", fontWeight:"700", marginBottom:8, marginTop:-4 }
});
