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
        <div style={{fontSize:9, color:'#888', marginBottom:10}}>Toca una moneda para ver su grafica explicada</div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:8, marginBottom:12}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #222', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <div><div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div><div style={{fontSize:11, color:'#888'}}>${Number(s.price).toLocaleString()}</div></div>
                <div style={{width:30,height:30, borderRadius:15, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:11, background:s.score>=70?'#22c55e':s.score>=45?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div>
              </div>
              <div style={{fontSize:9, marginTop:6, fontWeight:700, padding:'3px', borderRadius:5, textAlign:'center', background:s.status==='COMPRAR'?'#052e16':'#1a1a1a', color:s.status==='COMPRAR'?'#4ade80':'#666'}}>{s.status}</div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 0.8fr', gap:8}}>
          <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
            <div style={{display:'flex', justifyContent:'space-between', marginBottom:8}}>
              <div style={{fontSize:11, fontWeight:700}}>GRAFICA SCORE {selected}</div>
              <div style={{fontSize:8, background:'#052e16', color:'#4ade80', padding:'2px 6px', borderRadius:10}}>Cada barra = 15 min</div>
            </div>

            <div style={{display:'flex', gap:6, fontSize:8, marginBottom:6}}>
              <span>🔴 0-44 NO</span>
              <span>🟡 45-69 ESPERA</span>
              <span>🟢 70-100 COMPRA</span>
            </div>

            <div style={{display:'flex', gap:6}}>
              <div style={{display:'flex', flexDirection:'column', justifyContent:'space-between', fontSize:8, color:'#555', height:120}}>
                <span>100</span><span>75</span><span>50</span><span>25</span><span>0</span>
              </div>
              <div style={{flex:1, display:'flex', alignItems:'flex-end', gap:3, height:120, borderLeft:'1px solid #333', borderBottom:'1px solid #333', padding:4, position:'relative'}}>
                <div style={{position:'absolute', top:'30%', left:0, right:0, height:1, background:'#22c55e', opacity:0.3}}></div>
                {history.map((h:any,i:number)=>(
                  <div key={i} style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', height:'100%'}}>
                    <div style={{fontSize:7, color:h.score>=70?'#22c55e':'#555', marginBottom:2}}>{h.score}</div>
                    <div style={{width:'100%', height:(h.score||0)+'%', background:h.score>=70?'#22c55e':h.score>=45?'#eab308':'#444', borderRadius:2, minHeight:3}}></div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{display:'flex', gap:3, marginLeft:18, marginTop:4}}>
              {history.map((h:any,i:number)=>{
                if(i % 6!==0) return <div key={i} style={{flex:1}}></div>
                const d = new Date(h.created_at)
                return <div key={i} style={{flex:1, fontSize:7, color:'#666', textAlign:'center'}}>{d.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}</div>
              })}
            </div>

            {sel && (
              <div style={{marginTop:10, background:'#000', border:'1px solid #222', borderRadius:8, padding:8}}>
                <div style={{fontSize:10, color:'#22c55e', fontWeight:700}}>QUE SIGNIFICA?</div>
                <div style={{fontSize:10, color:'#aaa', marginTop:4}}>
                  {sel.score>=70? 'Score '+sel.score+' VERDE = buen momento. Barras verdes arriba de linea = tendencia fuerte COMPRAR.' : sel.score>=45? 'Score '+sel.score+' AMARILLO = esperar. Cuando barras crucen linea verde de 70, comprar.' : 'Score '+sel.score+' ROJO = no comprar.'}
                </div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginTop:8}}>
                  <div style={{background:'#111', padding:5, borderRadius:5, textAlign:'center'}}><div style={{fontSize:7, color:'#888'}}>ENTRADA</div><div style={{fontSize:10, fontWeight:700}}>${Number(sel.price).toFixed(2)}</div></div>
                  <div style={{background:'#1a0a0a', padding:5, borderRadius:5, textAlign:'center'}}><div style={{fontSize:7, color:'#ef4444'}}>SL -3%</div><div style={{fontSize:10, fontWeight:700}}>${(Number(sel.price)*0.97).toFixed(2)}</div></div>
                  <div style={{background:'#052e16', padding:5, borderRadius:5, textAlign:'center'}}><div style={{fontSize:7, color:'#4ade80'}}>TP +5%</div><div style={{fontSize:10, fontWeight:700}}>${(Number(sel.price)*1.05).toFixed(2)}</div></div>
                </div>
              </div>
            )}
          </div>

          <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
            <div style={{fontSize:11, fontWeight:700, marginBottom:8}}>NOTICIAS {selected}</div>
            <div style={{display:'flex', flexDirection:'column', gap:6, maxHeight:380, overflowY:'auto'}}>
              {news.map((n:any,i:number)=>(
                <a key={i} href={n.url} target="_blank" style={{textDecoration:'none', background:'#000', border:'1px solid #222', borderRadius:8, padding:8, display:'block'}}>
                  <div style={{fontSize:11, fontWeight:700, color:'#fff'}}>{n.title}</div>
                  <div style={{fontSize:8, color:'#22c55e', marginTop:3}}>Leer ↗</div>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
