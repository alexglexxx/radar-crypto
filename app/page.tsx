'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')
  const [history, setHistory] = useState<any[]>([])
  const [news, setNews] = useState<any[]>([])
  const [trades, setTrades] = useState<any[]>([])

  useEffect(()=>{
    const saved = localStorage.getItem('radar_trades')
    if(saved) setTrades(JSON.parse(saved))
    load()
  },[])
  useEffect(()=>{ loadHist(); loadNews() },[selected])

  async function load(){
    const { data } = await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(80)
    if(!data) return
    const latest:any={}
    data.forEach((r:any)=>{ if(!latest[r.symbol]) latest[r.symbol]=r })
    setSignals(Object.values(latest) as any[])
  }
  async function loadHist(){
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(24)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    try{
      const res = await fetch(`/api/news?symbol=${selected}&t=${Date.now()}`)
      const json = await res.json()
      setNews(json.news || [])
    }catch{}
  }

  function calcTrade(s:any){
    if(!s) return null
    const price = Number(s.price)
    const score = s.score
    // Calculo trader: si score alto, target +5% / +10% / +15%, SL -3%
    const isBuy = score >= 65
    const sl = isBuy? price * 0.97 : price * 1.03
    const tp1 = isBuy? price * 1.05 : price * 0.95
    const tp2 = isBuy? price * 1.10 : price * 0.90
    const tp3 = isBuy? price * 1.18 : price * 0.82
    const rr = Math.abs((tp1 - price) / (price - sl)).toFixed(2)
    return { price, isBuy, sl, tp1, tp2, tp3, rr, score }
  }

  function buySim(s:any){
    const t = calcTrade(s)
    if(!t) return
    const trade = { id:Date.now(), symbol:s.symbol, type:'COMPRAR', entry:t.price, sl:t.sl, tp1:t.tp1, status:'ABIERTA', time:new Date().toLocaleString('es-MX') }
    const nt = [trade,...trades].slice(0,10)
    setTrades(nt)
    localStorage.setItem('radar_trades', JSON.stringify(nt))
    alert(`✅ Simulación COMPRA ${s.symbol} a $${t.price.toLocaleString()} | SL $${t.sl.toFixed(2)} | TP1 $${t.tp1.toFixed(2)}`)
  }

  const sel = signals.find((x:any)=>x.symbol===selected)
  const trade = calcTrade(sel)

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:10, fontFamily:'system-ui'}}>
      <div style={{maxWidth:1100, margin:'0 auto'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10}}>
          <h1 style={{fontSize:20, fontWeight:900}}>RADAR CRYPTO • TRADER</h1>
          <span style={{fontSize:9, background:'#052e16', color:'#4ade80', padding:'4px 8px', borderRadius:20, border:'1px solid #14532d'}}>● MODO OPERABLE</span>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:8, marginBottom:10}}>
          {signals.map((s:any)=>{
            const ct = calcTrade(s)
            return (
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #27272a', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><div><div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div><div style={{fontSize:10, color:'#a1a1aa'}}>${Number(s.price).toLocaleString()}</div></div><div style={{width:32,height:32, borderRadius:16, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:11, background:s.score>=70?'#22c55e':s.score>=40?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div></div>
              <div style={{fontSize:8, color:'#22c55e', marginTop:6, fontWeight:700}}>{ct?.isBuy?'↑ ENTRADA $'+ct.price.toFixed(0):'↓ ESPERAR'}</div>
              <div style={{display:'flex', gap:4, marginTop:6}}>
                <button onClick={(e)=>{e.stopPropagation(); buySim(s)}} style={{flex:1, fontSize:8, fontWeight:800, background:s.score>=70?'#22c55e':'#27272a', color:s.score>=70?'#000':'#71717a', border:'none', padding:'5px', borderRadius:6}}>COMPRAR</button>
              </div>
            </div>
          )})}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.1fr 1.9fr', gap:8}}>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', marginBottom:8}}>PLAN DE TRADING • {selected}</div>
              {trade && (
                <div>
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10}}>
                    <div style={{background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8}}><div style={{fontSize:8, color:'#71717a'}}>ENTRADA</div><div style={{fontSize:13, fontWeight:900}}>${trade.price.toLocaleString()}</div><div style={{fontSize:8, color:trade.isBuy?'#22c55e':'#ef4444'}}>{trade.isBuy?'COMPRAR AHORA':'NO ENTRAR'}</div></div>
                    <div style={{background:'#052e16', border:'1px solid #14532d', borderRadius:8, padding:8}}><div style={{fontSize:8, color:'#4ade80'}}>CONFIANZA</div><div style={{fontSize:13, fontWeight:900, color:'#4ade80'}}>{trade.score}%</div><div style={{fontSize:8, color:'#4ade80'}}>R/R {trade.rr}:1</div></div>
                  </div>
                  <div style={{background:'#000', borderRadius:8, padding:8, border:'1px solid #27272a'}}>
                    <div style={{display:'flex', justifyContent:'space-between', fontSize:10, marginBottom:6}}><span style={{color:'#ef4444'}}>🛑 Stop Loss (-3%)</span><span style={{fontWeight:700}}>${trade.sl.toFixed(2)}</span></div>
                    <div style={{display:'flex', justifyContent:'space-between', fontSize:10, marginBottom:6}}><span style={{color:'#22c55e'}}>🎯 TP1 (+5%)</span><span style={{fontWeight:700}}>${trade.tp1.toFixed(2)}</span></div>
                    <div style={{display:'flex', justifyContent:'space-between', fontSize:10, marginBottom:6}}><span style={{color:'#22c55e'}}>🎯 TP2 (+10%)</span><span style={{fontWeight:700}}>${trade.tp2.toFixed(2)}</span></div>
                    <div style={{display:'flex', justifyContent:'space-between', fontSize:10}}><span style={{color:'#22c55e'}}>🎯 TP3 (+18%)</span><span style={{fontWeight:700}}>${trade.tp3.toFixed(2)}</span></div>
                  </div>
                  <button onClick={()=>buySim(sel)} style={{width:'100%', marginTop:10, background:'#22c55e', color:'#000', fontWeight:900, fontSize:12, padding:'10px', borderRadius:8, border:'none'}}>SIMULAR COMPRA {selected} → $500 USD</button>
                  <div style={{fontSize:8, color:'#52525b', marginTop:6, textAlign:'center'}}>Calculado con score + volumen + RSI. No es consejo financiero.</div>
                </div>
              )}
            </div>

            <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:10}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', marginBottom:6}}>HISTÓRICO 6H - {selected}</div>
              <div style={{display:'flex', alignItems:'flex-end', gap:3, height:80}}>
                {history.map((h:any,i:number)=><div key={i} title={`${new Date(h.created_at).toLocaleTimeString()} Score ${h.score}`} style={{flex:1, height:`${h.score}%`, background:h.score>=70?'#22c55e':'#3f3f46', borderRadius:2, minHeight:2}}/>)}
              </div>
              <div style={{fontSize:8, color:'#52525b', marginTop:4}}>{history.length} velas • cada 15 min • {history[0]? new Date(history[0].created_at).toLocaleTimeString().slice(0,5):''} → {history[history.length-1]? new Date(history[history.length-1].created_at).toLocaleTimeString().slice(0,5):''}</div>
            </div>
          </div>

          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', marginBottom:8}}>MIS OPERACIONES SIMULADAS</div>
              {trades.length===0 && <div style={{fontSize:11, color:'#52525b'}}>Aún no has simulado ninguna compra. Dale COMPRAR en una crypto con score {'>'}70</div>}
              {trades.map((t:any)=><div key={t.id} style={{background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8, marginBottom:6, display:'flex', justifyContent:'space-between'}}><div><div style={{fontSize:11, fontWeight:700}}>{t.type} {t.symbol} • ${t.entry.toFixed(2)}</div><div style={{fontSize:9, color:'#71717a'}}>{t.time} • SL ${t.sl.toFixed(2)} • TP ${t.tp1.toFixed(2)}</div></div><div style={{fontSize:8, padding:'3px 6px', borderRadius:6, background:'#052e16', color:'#4ade80', height:'fit-content'}}>{t.status}</div></div>)}
            </div>

            <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', marginBottom:8}}>NOTICIAS REALES • {selected}</div>
              <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:220, overflowY:'auto'}}>
                {news.map((n:any,i:number)=><a key={i} href={n.url} target="_blank" style={{textDecoration:'none', background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8, display:'block'}}><div style={{fontSize:11, fontWeight:700, color:'#fff'}}>{n.title}</div><div style={{fontSize:9, color:'#a1a1aa', marginTop:3}}>{n.body?.slice(0,100)}...</div></a>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
