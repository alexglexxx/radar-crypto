'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')
  const [history, setHistory] = useState<any[]>([])
  const [news, setNews] = useState<any[]>([])

  useEffect(()=>{ load() },[])
  useEffect(()=>{ loadHist(); loadNews() },[selected])

  async function load(){
    const { data } = await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(80)
    if(!data) return
    const latest:any={}
    data.forEach((r:any)=>{ if(!latest[r.symbol]) latest[r.symbol]=r })
    setSignals(Object.values(latest) as any[])
  }
  async function loadHist(){
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(20)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    try{
      const r = await fetch(`/api/news?symbol=${selected}&t=${Date.now()}`)
      const j = await r.json()
      setNews(j.news||[])
    }catch{}
  }

  const sel = signals.find((x:any)=>x.symbol===selected)

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:900, margin:'0 auto'}}>
        <h1 style={{fontSize:20, fontWeight:900, marginBottom:4}}>RADAR CRYPTO • SIMPLE</h1>
        <div style={{fontSize:10, color:'#666', marginBottom:12, background:'#0a0a0a', padding:8, borderRadius:8, border:'1px solid #1a1a1a'}}>
          <b style={{color:'#22c55e'}}>COMO USAR EN 10 SEG:</b> 1) Busca verde con 70+ 2) Si dice COMPRAR, es buena 3) Dale al boton y te mando a Bitso
        </div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:8, marginBottom:12}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #27272a', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <div><div style={{fontWeight:900}}>{s.symbol}</div><div style={{fontSize:11, color:'#888'}}>${Number(s.price).toLocaleString()}</div></div>
                <div style={{width:32,height:32, borderRadius:16, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, background:s.score>=70?'#22c55e':s.score>=40?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div>
              </div>
              <div style={{fontSize:9, marginTop:8, fontWeight:800, padding:'4px', borderRadius:6, textAlign:'center', background:s.status==='COMPRAR'?'#052e16':'#1a1a1a', color:s.status==='COMPRAR'?'#4ade80':'#666'}}>{s.status}</div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>
          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
            <div style={{fontSize:10, color:'#888', marginBottom:8}}>GRAFICA - ULTIMAS 20 LECTURAS (cada 15 min)</div>
            <div style={{display:'flex', alignItems:'flex-end', gap:3, height:90, borderLeft:'1px solid #222', borderBottom:'1px solid #222', padding:4}}>
              {history.map((h:any,i:number)=>(
                <div key={i} style={{flex:1, height:`${h.score}%`, background:h.score>=70?'#22c55e':'#333', borderRadius:2}} />
              ))}
            </div>
            <div style={{fontSize:8, color:'#555', marginTop:4}}>Mas alta = mejor momento • Verde 70+ = COMPRAR</div>
            {sel && (
              <div style={{marginTop:12, background:'#000', borderRadius:8, padding:10, border:'1px solid #222'}}>
                <div style={{fontSize:11, fontWeight:700, color:sel.score>=70?'#22c55e':'#eab308'}}>{sel.score>=70?`SI COMPRAR ${selected}`:`ESPERAR ${selected}`}</div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginTop:10}}>
                  <div style={{background:'#111', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:8, color:'#888'}}>ENTRADA</div><div style={{fontSize:11, fontWeight:700}}>${Number(sel.price).toFixed(2)}</div></div>
                  <div style={{background:'#1a0a0a', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:8, color:'#ef4444'}}>SL -3%</div><div style={{fontSize:11, fontWeight:700}}>${(Number(sel.price)*0.97).toFixed(2)}</div></div>
                  <div style={{background:'#052e16', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:8, color:'#4ade80'}}>TP +5%</div><div style={{fontSize:11, fontWeight:700}}>${(Number(sel.price)*1.05).toFixed(2)}</div></div>
                </div>
                <a href={`https://bitso.com/trade/${selected.toLowerCase()}_mxn`} target="_blank" style={{display:'block', textAlign:'center', marginTop:10, background:sel.score>=70?'#22c55e':'#333', color:sel.score>=70?'#000':'#888', fontWeight:900, padding:'10px', borderRadius:8, textDecoration:'none', fontSize:12}}>IR A BITSO</a>
              </div>
            )}
          </div>

          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
            <div style={{fontSize:10, color:'#888', marginBottom:8}}>NOTICIAS REALES • {selected}</div>
            <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:300, overflowY:'auto'}}>
              {news.map((n:any,i:number)=>(
                <a key={i} href={n.url} target="_blank" style={{textDecoration:'none', background:'#000', border:'1px solid #222', borderRadius:8, padding:8, display:'block'}}>
                  <div style={{fontSize:11, fontWeight:700, color:'#fff'}}>{n.title}</div>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
