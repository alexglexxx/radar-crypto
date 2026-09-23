'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')
  const [history, setHistory] = useState<any[]>([])
  const [news, setNews] = useState<any[]>([])
  const [loadingNews, setLoadingNews] = useState(false)

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
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(24)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    setLoadingNews(true)
    try{
      const res = await fetch(`/api/news?symbol=${selected}&t=${Date.now()}`)
      const json = await res.json()
      setNews(json.news || [])
    }catch{ setNews([]) }
    setLoadingNews(false)
  }

  const sel = signals.find((x:any)=>x.symbol===selected)

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:1100, margin:'0 auto'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <h1 style={{fontSize:22, fontWeight:900}}>RADAR CRYPTO • EN VIVO</h1>
          <span style={{fontSize:10, background:'#052e16', color:'#4ade80', border:'1px solid #14532d', padding:'4px 8px', borderRadius:20}}>● Noticias Reales por crypto</span>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:8, marginBottom:14}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #27272a', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><div><div style={{fontWeight:900, fontSize:14}}>{s.symbol}</div><div style={{fontSize:11, color:'#a1a1aa'}}>${Number(s.price).toLocaleString()}</div></div><div style={{width:36,height:36, borderRadius:18, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div></div>
              <div style={{height:4, background:'#27272a', borderRadius:4, margin:'8px 0'}}><div style={{width:`${s.score}%`, height:'100%', background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444'}}/></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:6, background:s.status==='COMPRAR'?'#052e16':'#422006', color:s.status==='COMPRAR'?'#4ade80':'#facc15'}}>{s.status}</span><span style={{fontSize:9, color:'#71717a'}}>rsi {s.change_24h} • {s.volume}%</span></div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 1.8fr', gap:8}}>
          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
            <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', marginBottom:6}}>HISTÓRICO {selected} - Últimas 24 lecturas (cada 15 min = 6 horas)</div>
            <div style={{fontSize:9, color:'#52525b', marginBottom:8}}>Eje X: hora real • Score 0-100</div>
            <div style={{display:'flex', alignItems:'flex-end', gap:4, height:130, borderLeft:'1px solid #27272a', borderBottom:'1px solid #27272a', padding:6}}>
              {history.map((h:any,i:number)=>{
                const label = new Date(h.created_at).toLocaleTimeString('es-MX',{hour:'2-digit', minute:'2-digit'})
                return (
                  <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3}}>
                    <div title={`Score ${h.score} a las ${label}`} style={{width:'100%', height:`${h.score}%`, background: h.score>=70?'#22c55e':'#52525b', borderRadius:3, minHeight:3}}/>
                    <div style={{fontSize:6, color:'#52525b', transform:'rotate(-45deg)', whiteSpace:'nowrap', marginTop:4}}>{label}</div>
                  </div>
                )
              })}
            </div>
            <div style={{marginTop:12, background:'#000', border:'1px solid #27272a', borderRadius:8, padding:10}}>
              <div style={{fontSize:10, color:'#22c55e', fontWeight:700, marginBottom:4}}>¿POR QUÉ {sel?.status} {selected} AHORA?</div>
              <div style={{fontSize:12, color:'#d4d4d8'}}>{sel?.score>=70? `Score ALTO ${sel?.score}: RSI ${sel?.change_24h} en compra, vol +${sel?.volume}%` : `Score ${sel?.score}: RSI ${sel?.change_24h}, vol ${sel?.volume}%`}</div>
              <div style={{fontSize:10, color:'#71717a', marginTop:6}}>{sel? new Date(sel.created_at).toLocaleString('es-MX') : '--'} • {history.length} puntos</div>
            </div>
          </div>

          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:12}}>
            <div style={{display:'flex', justifyContent:'space-between', marginBottom:10}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa'}}>NOTICIAS REALES • {selected} {loadingNews?'• cargando...':''}</div>
              <button onClick={loadNews} style={{fontSize:10, background:'#27272a', border:'1px solid #3f3f46', color:'#fff', padding:'4px 10px', borderRadius:6}}>↻ Actualizar</button>
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:8, maxHeight:360, overflowY:'auto'}}>
              {news.map((n:any,i:number)=>(
                <a key={i} href={n.url} target="_blank" rel="noopener" style={{textDecoration:'none', background:'#000', border:'1px solid #27272a', borderRadius:10, padding:10, display:'block'}}>
                  <div style={{display:'flex', justifyContent:'space-between', marginBottom:5}}>
                    <span style={{fontSize:8, padding:'2px 7px', borderRadius:10, background:i===0?'#052e16':'#1e293b', color:i===0?'#4ade80':'#93c5fd'}}>{n.source} {i===0?'• TOP':''}</span>
                    <span style={{fontSize:8, color:'#52525b'}}>{n.published? new Date(n.published).toLocaleDateString('es-MX') : ''}</span>
                  </div>
                  <div style={{fontSize:13, fontWeight:700, color:'#fff', marginBottom:5}}>{n.title}</div>
                  <div style={{fontSize:10, color:'#a1a1aa'}}>{n.body}</div>
                  <div style={{fontSize:9, color:'#22c55e', marginTop:6}}>→ Leer en {n.source} ↗</div>
                </a>
              ))}
            </div>
            <div style={{fontSize:9, color:'#52525b', marginTop:8}}>Cada crypto jala su propio RSS: /tag/{selected.toLowerCase()} • Links reales</div>
          </div>
        </div>
      </div>
    </div>
  )
}
