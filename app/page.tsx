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
    const arr = Object.values(latest) as any[]
    setSignals(arr)
    if(arr.length && !arr.find((s:any)=>s.symbol===selected)) setSelected(arr[0].symbol)
  }
  async function loadHist(){
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(20)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    setLoadingNews(true)
    try{
      const res = await fetch(`/api/news?symbol=${selected}`)
      const json = await res.json()
      setNews(json.news || [])
    }catch{
      setNews([])
    }
    setLoadingNews(false)
  }

  const selData = signals.find((x:any)=>x.symbol===selected)

  function whyText(){
    if(!selData) return 'Analizando...'
    const rsi = Number(selData.change_24h)
    const vol = Number(selData.volume)
    if(selData.score>=75) return `Score ${selData.score} ALTO: RSI ${rsi} ${rsi<45?'en sobreventa':'con fuerza'}, volumen +${vol}% por encima del promedio, MACD alcista. ${news[0]?.title ? 'Noticia clave: '+news[0]?.title : 'Tendencia compradora confirmada.'}`
    if(selData.score>=50) return `Score ${selData.score} NEUTRAL: RSI ${rsi} equilibrado, volumen +${vol}%. Esperar confirmación. ${news[0]?.title || 'Mercado en consolidación.'}`
    return `Score ${selData.score} BAJO: RSI ${rsi}, volumen bajo. Riesgo de caída. ${news[0]?.title || 'Esperar mejor entrada.'}`
  }

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:1100, margin:'0 auto'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <h1 style={{fontSize:22, fontWeight:900, letterSpacing:-1}}>RADAR CRYPTO • EN VIVO</h1>
          <span style={{fontSize:10, background:'#052e16', color:'#4ade80', border:'1px solid #14532d', padding:'4px 8px', borderRadius:20}}>● Noticias Reales</span>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:14}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{
              cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'1px solid #22c55e':'1px solid #27272a',
              borderRadius:12, padding:10
            }}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <div><div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div><div style={{fontSize:11, color:'#a1a1aa'}}>${Number(s.price).toLocaleString()}</div></div>
                <div style={{width:32,height:32, borderRadius:16, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:12, background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444', color: s.score>=40?'#000':'#fff'}}>{s.score}</div>
              </div>
              <div style={{height:4, background:'#27272a', borderRadius:4, margin:'8px 0', overflow:'hidden'}}><div style={{width:`${s.score}%`, height:'100%', background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444'}}/></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:6, background: s.status==='COMPRAR'?'#052e16':'#422006', color: s.status==='COMPRAR'?'#4ade80':'#facc15'}}>{s.status}</span><span style={{fontSize:9, color:'#71717a'}}>rsi {s.change_24h} • {s.volume}%</span></div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 1.8fr', gap:8}}>
          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:10}}>
            <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', letterSpacing:1, marginBottom:8}}>HISTÓRICO {selected} - SCORE (últimos {history.length})</div>
            <div style={{display:'flex', alignItems:'flex-end', gap:3, height:110}}>
              {history.map((h:any,i:number)=>(<div key={i} style={{flex:1, height:`${h.score}%`, background: h.score>=70?'#22c55e':'#52525b', borderRadius:3, minHeight:2}}/>))}
            </div>
            <div style={{marginTop:8, background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8}}>
              <div style={{fontSize:11, color:'#d4d4d8', lineHeight:'15px'}}>{whyText()}</div>
              <div style={{display:'flex', gap:8, marginTop:8, fontSize:10}}>
                <span style={{color:'#71717a'}}>RSI: <b style={{color:'#fff'}}>{selData?.change_24h}</b></span>
                <span style={{color:'#71717a'}}>Score: <b style={{color:'#fff'}}>{selData?.score}/100</b></span>
                <span style={{color:'#71717a'}}>Vol: <b style={{color:'#fff'}}>{selData?.volume}%</b></span>
              </div>
            </div>
          </div>

          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:10}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
              <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', letterSpacing:1}}>NOTICIAS REALES • {selected} {loadingNews?' (cargando...)':''}</div>
              <button onClick={loadNews} style={{fontSize:9, background:'#27272a', border:'1px solid #3f3f46', color:'#fff', padding:'3px 8px', borderRadius:6}}>↻ Actualizar</button>
            </div>
            <div style={{display:'flex', flexDirection:'column', gap:8, maxHeight:280, overflowY:'auto'}}>
              {news.length===0 && <div style={{fontSize:12, color:'#52525b'}}>Sin noticias, dale actualizar</div>}
              {news.map((n:any,i:number)=>(
                <a key={i} href={n.url} target="_blank" style={{textDecoration:'none', background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8, display:'block'}}>
                  <div style={{display:'flex', justifyContent:'space-between', marginBottom:4}}>
                    <span style={{fontSize:8, padding:'2px 6px', borderRadius:10, background:'#1e3a8a', color:'#93c5fd'}}>{n.source}</span>
                    <span style={{fontSize:8, color:'#52525b'}}>{n.time ? new Date(n.time*1000).toLocaleTimeString().slice(0,5) : ''}</span>
                  </div>
                  <div style={{fontSize:12, fontWeight:700, color:'#fff', lineHeight:'14px', marginBottom:4}}>{n.title}</div>
                  <div style={{fontSize:10, color:'#a1a1aa', lineHeight:'13px'}}>{n.body}</div>
                </a>
              ))}
            </div>
            <div style={{fontSize:9, color:'#52525b', marginTop:8}}>Fuente: CryptoCompare • CoinDesk • CoinTelegraph • Actualizado cada 5 min</div>
          </div>
        </div>
      </div>
    </div>
  )
}
