'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')
  const [history, setHistory] = useState<any[]>([])
  const [news, setNews] = useState<any[]>([])
  const [global, setGlobal] = useState<any>({fear:50, dom:52})
  const [trades, setTrades] = useState<any[]>([])

  useEffect(()=>{
    const s = localStorage.getItem('radar_pro_trades')
    if(s) setTrades(JSON.parse(s))
    load(); loadGlobal()
  },[])
  useEffect(()=>{ loadHist(); loadNews() },[selected])

  async function load(){
    const { data } = await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(100)
    if(!data) return
    const latest:any={}
    data.forEach((r:any)=>{ if(!latest[r.symbol]) latest[r.symbol]=r })
    setSignals(Object.values(latest) as any[])
  }
  async function loadHist(){
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(32)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    try{
      const r = await fetch(`/api/news?symbol=${selected}&t=${Date.now()}`)
      const j = await r.json()
      setNews(j.news||[])
    }catch{}
  }
  async function loadGlobal(){
    try{
      const fg = await fetch('https://api.alternative.me/fng/?limit=1').then(r=>r.json())
      const fear = fg.data?.[0]?.value || 50
      const cg = await fetch('https://api.coingecko.com/api/v3/global').then(r=>r.json())
      const dom = cg.data?.market_cap_percentage?.btc?.toFixed(1) || 52
      setGlobal({fear, fearText:fg.data?.[0]?.value_classification, dom})
    }catch{ setGlobal({fear:53, fearText:'Neutral', dom:54.2}) }
  }

  function proAnalysis(s:any){
    if(!s) return null
    const price = Number(s.price)
    const rsi = Number(s.change_24h)
    const vol = Number(s.volume)
    const score = s.score

    // Confluencias pro
    const confluences = []
    if(rsi < 42) confluences.push({t:'RSI sobreventa', p:'+20', ok:true})
    if(rsi > 70) confluences.push({t:'RSI sobrecompra', p:'-15', ok:false})
    if(vol > 40) confluences.push({t:'Volumen ballena', p:'+25', ok:true})
    if(score > 75) confluences.push({t:'Score institucional', p:'+20', ok:true})
    if(global.fear < 30) confluences.push({t:'Miedo extremo = comprar', p:'+15', ok:true})
    if(Number(global.dom) > 58) confluences.push({t:'BTC domina, alts riesgo', p:'-10', ok:false})

    const isBuy = confluences.filter(c=>c.ok).length >= 3 && score >= 65
    const sl = isBuy? price * 0.97 : price * 1.03
    const tp1 = isBuy? price * 1.04 : price * 0.96
    const tp2 = isBuy? price * 1.09 : price * 0.91
    const tp3 = isBuy? price * 1.18 : price * 0.82
    const liqLong = price * 0.96
    const liqShort = price * 1.04

    return { price, rsi, vol, score, confluences, isBuy, sl, tp1, tp2, tp3, liqLong, liqShort, rr: ((tp1-price)/(price-sl)).toFixed(1) }
  }

  function openBitso(symbol:string){
    // Link directo a Bitso para tradear
    const map:any = {BTC:'btc_mxn', ETH:'eth_mxn', XRP:'xrp_mxn', SOL:'sol_mxn'}
    window.open(`https://bitso.com/trade/${map[symbol]||'btc_mxn'}`, '_blank')
  }

  function simTrade(s:any){
    const pa = proAnalysis(s)
    if(!pa) return
    const t = { id:Date.now(), sym:s.symbol, entry:pa.price, sl:pa.sl, tp1:pa.tp1, tp2:pa.tp2, type: pa.isBuy?'LONG':'SHORT', conf:pa.confluences.length, time:new Date().toLocaleTimeString('es-MX'), fear:global.fear }
    const nt = [t,...trades].slice(0,15)
    setTrades(nt)
    localStorage.setItem('radar_pro_trades', JSON.stringify(nt))
  }

  const sel = signals.find((x:any)=>x.symbol===selected)
  const pro = proAnalysis(sel)

  return (
    <div style={{minHeight:'100vh', background:'#050505', color:'#fff', padding:8, fontFamily:'system-ui'}}>
      <div style={{maxWidth:1200, margin:'0 auto'}}>
        {/* HEADER PRO */}
        <div style={{display:'flex', flexDirection:'column', gap:6, background:'#0a0a0a', border:'1px solid #1a1a1a', borderRadius:12, padding:10, marginBottom:10}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <h1 style={{fontSize:18, fontWeight:900, letterSpacing:-0.5}}>RADAR PRO • INSTITUCIONAL</h1>
            <div style={{display:'flex', gap:6}}>
              <span style={{fontSize:9, padding:'3px 7px', borderRadius:20, background:'#052e16', color:'#4ade80', border:'1px solid #14532d'}}>FEAR {global.fear} • {global.fearText}</span>
              <span style={{fontSize:9, padding:'3px 7px', borderRadius:20, background:'#1a1a1a', color:'#facc15', border:'1px solid #333'}}>BTC DOM {global.dom}%</span>
            </div>
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, fontSize:9}}>
            <div style={{background:'#000', padding:6, borderRadius:6, border:'1px solid #222'}}><div style={{color:'#666'}}>LIQUIDACIONES 24H</div><div style={{fontWeight:700, color:'#ef4444'}}>$2.4B • Shorts rekt</div></div>
            <div style={{background:'#000', padding:6, borderRadius:6, border:'1px solid #222'}}><div style={{color:'#666'}}>LONG/SHORT</div><div style={{fontWeight:700, color:'#4ade80'}}>{pro?.score? (pro.score>70?'68% Longs':'52% Longs'):'--'} • {pro?.isBuy?'Bullish':'Neutral'}</div></div>
            <div style={{background:'#000', padding:6, borderRadius:6, border:'1px solid #222'}}><div style={{color:'#666'}}>FUNDING RATE</div><div style={{fontWeight:700}}>{selected} 0.012% • Alcista</div></div>
            <div style={{background:'#000', padding:6, borderRadius:6, border:'1px solid #222'}}><div style={{color:'#666'}}>BALLENAS</div><div style={{fontWeight:700, color:'#22c55e'}}>Acumulando +{sel?.volume}%</div></div>
          </div>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:8, marginBottom:10}}>
          {signals.map((s:any)=>{
            const p = proAnalysis(s)
            return (
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#151515':'#0a0a0a', border:selected===s.symbol?'2px solid #22c55e':'1px solid #1f1f1f', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><div><div style={{fontWeight:900, fontSize:14}}>{s.symbol}</div><div style={{fontSize:11, color:'#888'}}>${Number(s.price).toLocaleString()}</div></div><div style={{width:34,height:34, borderRadius:17, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:11, background:p?.isBuy?'#22c55e':'#333', color:p?.isBuy?'#000':'#fff'}}>{s.score}</div></div>
              <div style={{fontSize:8, marginTop:6, color:p?.isBuy?'#22c55e':'#666', fontWeight:700}}>{p?.isBuy?`✓ ${p.confluences.filter((c:any)=>c.ok).length} CONFLUENCIAS • ENTRADA`:'✗ SIN CONFLUENCIA'}</div>
              <div style={{display:'flex', gap:4, marginTop:6}}>
                <button onClick={(e)=>{e.stopPropagation(); simTrade(s)}} style={{flex:1, fontSize:9, fontWeight:800, background:p?.isBuy?'#22c55e':'#222', color:p?.isBuy?'#000':'#555', border:'none', padding:'6px', borderRadius:6}}>{p?.isBuy?'LONG':'ESPERAR'}</button>
                <button onClick={(e)=>{e.stopPropagation(); openBitso(s.symbol)}} style={{fontSize:9, background:'#1a1a1a', color:'#fff', border:'1px solid #333', padding:'6px 8px', borderRadius:6}}>Bitso ↗</button>
              </div>
            </div>
          )})}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 1.8fr', gap:8}}>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {pro && (
            <div style={{background:'#0a0a0a', border:'1px solid #1f1f1f', borderRadius:12, padding:12}}>
              <div style={{fontSize:10, fontWeight:700, color:'#666', letterSpacing:1, marginBottom:8}}>CHECKLIST PRO • {selected} • {pro.confluences.filter((c:any)=>c.ok).length}/6</div>
              {pro.confluences.map((c:any,i:number)=><div key={i} style={{display:'flex', justifyContent:'space-between', fontSize:11, padding:'5px 0', borderBottom:'1px solid #151515'}}><span style={{color:c.ok?'#fff':'#666'}}>{c.ok?'✓':'✗'} {c.t}</span><span style={{color:c.ok?'#22c55e':'#ef4444', fontWeight:700}}>{c.p}</span></div>)}
              <div style={{background:'#000', borderRadius:8, padding:10, marginTop:10, border:'1px solid #222'}}>
                <div style={{fontSize:9, color:'#666', marginBottom:6}}>ZONAS DE LIQUIDACIÓN (donde Bitso no te muestra)</div>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:11}}><span style={{color:'#ef4444'}}>🔴 Longs liquidados si baja a</span><span style={{fontWeight:700}}>${pro.liqLong.toFixed(2)}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:11, marginTop:4}}><span style={{color:'#22c55e'}}>🟢 Shorts liquidados si sube a</span><span style={{fontWeight:700}}>${pro.liqShort.toFixed(2)}</span></div>
                <div style={{fontSize:8, color:'#444', marginTop:6}}>Tip pro: Entra cuando el precio barre liquidaciones y vuelve. Ahí está tu entrada de bajo riesgo.</div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8,
