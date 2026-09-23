'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')
  const [history, setHistory] = useState<any[]>([])

  useEffect(()=>{ load() },[])
  useEffect(()=>{ loadHist() },[selected])

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

  const sel = signals.find((x:any)=>x.symbol===selected)
  const prices = history.map((h:any)=>Number(h.price))
  const minP = prices.length? Math.min(...prices) : 0
  const maxP = prices.length? Math.max(...prices) : 1
  const range = maxP - minP || 1

  // ASISTENTE EN VIVO - LOGICA DIRECTA
  let asist:any = null
  if(sel){
    const sc = Number(sel.score)
    const first = history.length>0? history[0].score : sc
    const last = history.length>0? history[history.length-1].score : sc
    const sube = last >= first
    const pr = Number(sel.price)
    const ent = pr.toFixed(2)
    const sl = (pr*0.97).toFixed(2)
    const tp = (pr*1.05).toFixed(2)

    if(sc >= 80 && sube){
      asist = { t:`${selected} EXPLOSIVO`, c:'#22c55e', qh:'PREPARA ENTRADA AHORA', pq:`Score ${sc} subiendo de ${first} a ${last}. Precio + volumen alineados. Patron pro.`, paso:`Entrada $${ent}\nSL $${sl} -3%\nTP $${tp} +5%\nSolo 10% capital`, mente:'No corras. Si no da entrada en 10 min, vendra otro taxi.' }
    } else if(sc >= 70){
      asist = { t:`${selected} FUERTE PERO PLANO`, c:'#eab308', qh:'ESPERA CONFIRMACION', pq:`Score ${sc} bueno pero plano. Ya subio y duda. Si compras aqui te quedas atrapado arriba.`, paso:`No compres aun\nEspera 2-3 barras\nSi sube a 85+ entras\nSi baja a 60 se cancela`, mente:'Aqui el novato pierde por FOMO. Tu esperas. La paciencia paga.' }
    } else if(sc >= 45){
      asist = { t:`${selected} EN AMARILLO`, c:'#eab308', qh:'NO TOQUES NADA', pq:`Score ${sc} tierra de nadie. Ni sube ni baja. Como ETH 50 de tu foto. No hay operacion.`, paso:`Cierra Bitso\nAlarma en 75+\nMira otras 3 monedas`, mente:'En amarillo, hacer nada ES hacer algo bien.' }
    } else {
      asist = { t:`${selected} NO SE TOCA`, c:'#ef4444', qh:'PROTEGE TU CAPITAL', pq:`Score ${sc} bajo = cuchillo cayendo. Comprar barato te sale mas barato manana.`, paso:`Revisa si te saco SL\nQuedate fuera\nAnota por que bajo`, mente:'La mejor operacion a veces es no operar.' }
    }
  }

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:980, margin:'0 auto'}}>
        <h1 style={{fontSize:18, fontWeight:900}}>RADAR CRYPTO EN VIVO</h1>
        <div style={{fontSize:9, color:'#888', marginBottom:10}}>4 monedas, 1 asistente. Sin ruido.</div>

        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:12}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'2px solid #22c55e':'1px solid #222', borderRadius:12, padding:10}}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <div><div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div><div style={{fontSize:11, color:'#888'}}>${Number(s.price).toLocaleString()}</div></div>
                <div style={{width:30, height:30, borderRadius:15, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:11, background:s.score>=70?'#22c55e':s.score>=45?'#eab308':'#ef4444', color:'#000'}}>{s.score}</div>
              </div>
              <div style={{fontSize:9, marginTop:6, fontWeight:700, padding:'3px', borderRadius:5, textAlign:'center', background:s.status==='COMPRAR'?'#052e16':'#1a1a1a', color:s.status==='COMPRAR'?'#4ade80':'#666'}}>{s.status}</div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1.2fr 0.9fr', gap:8}}>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
              <div style={{fontSize:11, fontWeight:700, marginBottom:6}}>SCORE {selected}</div>
              <div style={{display:'flex', gap:6}}>
                <div style={{display:'flex', flexDirection:'column', justifyContent:'space-between', fontSize:8, color:'#555', height:80}}><span>100</span><span>50</span><span>0</span></div>
                <div style={{flex:1, display:'flex', alignItems:'flex-end', gap:3, height:80, borderLeft:'1px solid #333', borderBottom:'1px solid #333', padding:4, position:'relative'}}>
                  <div style={{position:'absolute', top:'30%', left:0, right:0, height:1, background:'#22c55e', opacity:0.3}}></div>
                  {history.map((h:any,i:number)=>(<div key={i} style={{flex:1, height:(h.score||0)+'%', background:h.score>=70?'#22c55e':'#444', borderRadius:2, minHeight:3}}></div>))}
                </div>
              </div>
            </div>

            <div style={{background:'#101010', border:'1px solid #222', borderRadius:12, padding:12}}>
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontSize:11, fontWeight:700}}>PRECIO {selected} 6H</div>
                <div style={{fontSize:8, background:'#111', color:'#aaa', padding:'2px 6px', borderRadius:10, border:'1px solid #333'}}>{minP.toFixed(2)} - {maxP.toFixed(2)}</div>
              </div>
              <div style={{display:'flex', gap:6}}>
                <div style={{display:'flex', flexDirection:'column', justifyContent:'space-between', fontSize:8, color:'#555', height:90, textAlign:'right'}}><span>{maxP.toFixed(0)}</span><span>{minP.toFixed(0)}</span></div>
                <div style={{flex:1, position:'relative', height:90, borderLeft:'1px solid #333', borderBottom:'1px solid #333'[STRIPPED 33 bytes]"100%" height="100%" style={{overflow:'visible'}}>
                    <polyline fill="none" stroke="#22c55e" strokeWidth={2} points={history.map((h:any,i:number)=>{ const x=(i/(history.length-1||1))*100; const y=100-((Number(h.price)-minP)/range*90+5); return x+'%,'+y+'%' }).join(' ')} />
                  </svg>
                </div>
              </div>
              {sel && (
                <div style={{marginTop:10, background:'#000', border:'1px solid #222', borderRadius:8, padding:10}}>
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6}}>
                    <div style={{background:'#111', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:7, color:'#888'}}>ENTRADA</div><div style={{fontSize:10, fontWeight:700}}>${Number(sel.price).toFixed(2)}</div></div>
                    <div style={{background:'#1a0a0a', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:7, color:'#ef4444'}}>SL -3%</div><div style={{fontSize:10, fontWeight:700}}>${(Number(sel.price)*0.97).toFixed(2)}</div></div>
                    <div style={{background:'#052e16', padding:6, borderRadius:6, textAlign:'center'}}><div style={{fontSize:7, color:'#4ade80'}}>TP +5%</div><div style={{fontSize:10, fontWeight:700}}>${(Number(sel.price)*1.05).toFixed(2)}</div></div>
                  </div>
                  <a href={'https://bitso.com/trade/'+selected.toLowerCase()+'_mxn'} target="_blank" style={{display:'block', textAlign:'center', marginTop:10, background:'#22c55e', color:'#000', fontWeight:900, padding:'12px', borderRadius:10, textDecoration:'none', fontSize:13}}>IR A BITSO</a>
                </div>
              )}
            </div>
          </div>

          <div style={{background:'#0f0f0f', border:'1px solid #222', borderRadius:12, overflow:'hidden'}}>
            {asist && (
              <div>
                <div style={{background:asist.c, color:'#000', padding:10, fontWeight:900, fontSize:11}}>{asist.t}</div>
                <div style={{padding:12, display:'flex', flexDirection:'column', gap:12}}>
                  <div><div style={{fontSize:9, color:asist.c, fontWeight:800}}>QUE HACER AHORA</div><div style={{fontSize:13, fontWeight:800, marginTop:4}}>{asist.qh}</div></div>
                  <div style={{background:'#000', border:'1px solid #222', borderRadius:8, padding:10}}><div style={{fontSize:9, color:'#888', fontWeight:700}}>POR QUE</div><div style={{fontSize:11, color:'#ccc', marginTop:6, lineHeight:1.4}}>{asist.pq}</div></div>
                  <div style={{background:'#111', border:'1px solid #333', borderRadius:8, padding:10}}><div style={{fontSize:9, color:'#4ade80', fontWeight:700}}>PASO A PASO</div><div style={{fontSize:11, color:'#fff', marginTop:6, lineHeight:1.5, whiteSpace:'pre-wrap'}}>{asist.paso}</div></div>
                  <div style={{background:'#1a1a0a', border:'1px dashed #444', borderRadius:8, padding:10}}><div style={{fontSize:9, color:'#eab308', fontWeight:700}}>MENTE DE PRO</div><div style={{fontSize:11, color:'#aaa', marginTop:6, fontStyle:'italic'}}>{asist.mente}</div></div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}p
