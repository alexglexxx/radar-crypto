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
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(24)
    if(data) setHistory(data.reverse())
  }
  async function loadNews(){
    try{
      const r = await fetch('/api/news?symbol='+selected+'&t='+Date.now())
      const j = await r.json()
      setNews(j.news||[])
    }catch{}
  }

  const sel = signals.find((x:any)=>x.symbol===selected)

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:900, margin:'0 auto'}}>
        <h1 style={{fontSize:18, fontWeight:900}}>RADAR CRYPTO • EN VIVO</h1>
        <div style={{fontSize:9, color:'#888', marginBottom:10}}>Tocá una moneda abajo para ver su gráfica y noticias</div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:8, marginBottom:12}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #222', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}><div><div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div><div style={{fontSize:11, color:'#888'}}>${Number(s.price).toLocaleString()}</div></div><div style={{width:30,height:30, borderRadius:15, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:11, background:s.score>=70?'#22c55e':s.score>=45?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div></div>
              <div style={{fontSize:9, marginTop:6, fontWeight:700, padding:'3px', borderRadius:5, textAlign:'center', background:s.status==='COMPRAR'?'#052e16':'#1a1a1a', color:s.status==='COMPRAR'?'#4ade80':'#666'}}>{s.status}</div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 0.8fr', gap:8}}>
          {/* GRAFICA EXPLICADA */}
          <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
              <div style={{fontSize:11, fontWeight:700}}>📊 SCORE DE {selected} EN EL TIEMPO</div>
              <div style={{fontSize:8, background:'#052e16', color:'#4ade80', padding:'2px 6px', borderRadius:10}}>Cada barra = 15 min</div>
            </div>

            {/* Leyenda */}
            <div style={{display:'flex', gap:8, fontSize:8, marginBottom:8}}>
              <span style={{display:'flex', alignItems:'center', gap:3}}><span style={{width:8,height:8, background:'#ef4444', display:'inline-block', borderRadius:2}}></span> 0-44 NO COMPRAR</span>
              <span style={{display:'flex', alignItems:'center', gap:3}}><span style={{width:8,height:8, background:'#eab308', display:'inline-block', borderRadius:2}}></span> 45-69 ESPERAR</span>
              <span style={{display:'flex', alignItems:'center, gap:3'}}><span style={{width:8,height:8, background:'#22c55e', display:'inline-block', borderRadius:2}}></span> 70-100 COMPRAR</span>
            </div>

            {/* Grafica con eje Y */}
            <div style={{display:'flex', gap:6}}>
              <div style={{display:'flex', flexDirection:'column', justifyContent:'space-between', fontSize:8, color:'#555', height:120, padding:'2px 0'}}>
                <span>100</span><span>75</span><span>50</span><span>25</span><span>0</span>
              </div>
              <div style={{flex:1, display:'flex', alignItems:'flex-end', gap:3, height:120, borderLeft:'1px solid #333', borderBottom:'1px solid #333', padding:4, position:'relative'}}>
                {/* Linea 70 */}
                <div style={{position:'absolute', top:'30%', left:0, right:0, height:1, background:'#22c55e', opacity:0.3, borderTop:'1px dashed #22c55e'}}></div>
                {history.map((h:any,i:number)=>{
                  const isHigh = h.score>=70
                  return (
                    <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', height:'100%'}}>
                      <div style={{fontSize:7, color:isHigh?'#22c55e':'#555', fontWeight:isHigh?700:400, marginBottom:2}}>{h.score}</div>
                      <div style={{width:'100%', height:h.score+'%', background:isHigh?'#22c55e':h.score>=45?'#eab308':'#444', borderRadius:'3px 3px 0 0', minHeight:3, border: isHigh?'1px solid #4ade80':''}}></div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Eje X horas */}
            <div style={{display:'flex', gap:3, marginLeft:20, marginTop:4}}>
              {history.map((h:any,i:number)=>{
                if(i % 5!==0) return <div key={i} style={{flex:1}}></div>
                const d = new Date(h.created_at)
                return <div key={i} style={{flex:1, fontSize:7, color:'#666', textAlign:'center'}}>{d.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}</div>
              })}
            </div>

            <div style={{marginTop:10, background:'#000', border:'1px solid #222', borderRadius:8, padding:8}}>
              <div style={{fontSize:10, color:'#22c55e', fontWeight:700}}>¿QUE ME DICE ESTA GRAFICA?</div>
              <div style={{fontSize:10, color:'#aaa', marginTop:4, lineHeight:'14px'}}>
                {sel?.score>=70
               ? `Ahora score ${sel.score} VERDE = momento bueno. La gráfica si va subiendo (barras cada vez más altas) confirma que sigue subiendo. Si ves muchas barras verdes arriba de la linea punteada, es tendencia fuerte para COMPRAR.`
                : sel?.score>=45
               ? `Ahora score ${sel.score} AMARILLO = esperar. Si la gráfica empieza a hacer barras verdes que cruzan la linea de 70, ahí será momento de comprar.`
                : `Ahora score ${sel.score} ROJO = no comprar. Espera a que las barras suban y se pongan verdes.`}
              </div>
              <div style={{fontSize:9, color:'#555', marginTop:6}}>Linea punteada verde = 70 = zona de compra • {history.length} lecturas • Ultima: {sel? new Date(sel.created_at).toLocaleTimeString('es-MX'):''}</div>
            </div>

            {sel && (
              <div style={{marginTop:8, display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6}}>
                <div style={{background:'#111', padding:6, borderRadius:6, textAlign:'center', border:'1px solid #222'}}><div style={{fontSize:7, color:'#888'}}>AHORA</div><div style={{fontSize:12, fontWeight:800}}>${Number(sel.price).toFixed(0)}</div></div>
                <div style={{background:'#1a0a0a', padding:6, borderRadius:6, textAlign:'center', border:'1px solid #331'}}><div style={{fontSize:7, color:'#ef4444'}}>STOP LOSS -3%</div><div style={{fontSize:11, fontWeight:700}}>${(Number(sel.price)*0.97).toFixed(0)}</div></div>
                <div style={{background:'#052e16', padding:6, borderRadius:6, textAlign:'center', border:'1px solid #14532d'}}><div style={{fontSize:7, color:'#4ade80'}}>VENDE +5%</div><div style={{fontSize:11, fontWeight:700}}>${(Number(sel.price)*1.05).toFixed(0)}</div></div>
              </div>
            )}
          </div>

          <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
            <div style={{fontSize:11, fontWeight:700, marginBottom:8}}>📰 NOTICIAS REALES {selected}</div>
            <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:380, overflowY:'auto'}}>
              {news.map((n:any,i:number)=>(
                <a key={i} href={n.url} target="_blank" style={{textDecoration:'none', background:'#000', border:'1px solid #222', borderRadius:8, padding:8, display:'block'}}>
                  <div style={{fontSize:11, fontWeight:700, color:'#fff', lineHeight:'13px'}}>{n.title}</div>
                  <div style={{fontSize:8, color:'#22c55e', marginTop:4}}>Leer en CoinTelegraph ↗</div>
                </a>
              ))}
              {news.length===0 && <div style={{fontSize:10, color:'#555'}}>Cargando noticias de {selected}...</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
