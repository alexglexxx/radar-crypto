'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

const NEWS: any = {
  BTC: { tag: 'Acumulación', text: 'RSI 40 sobreventa + MACD alcista. Ballenas acumulando, volumen +31%. Rebote técnico probable.' },
  ETH: { tag: 'Lateral', text: 'RSI 54 neutral, esperando Pectra. Volumen bajo 9%. Mantener hasta breakout.' },
  SOL: { tag: 'Alcista', text: 'Volumen +45%, TVL subiendo. Memecoins empujando. Tendencia alcista clara.' },
  XRP: { tag: 'Noticia positiva', text: 'Avance caso SEC + volumen +60%. RSI 72 en zona alta pero con fuerza compradora.' },
}

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [selected, setSelected] = useState('XRP')
  const [history, setHistory] = useState<any[]>([])

  useEffect(()=>{ load() },[])
  useEffect(()=>{ loadHist() },[selected])

  async function load(){
    const { data } = await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(80)
    if(!data) return
    const latest:any={}
    data.forEach((r:any)=>{ if(!latest[r.symbol]) latest[r.symbol]=r })
    const arr = Object.values(latest) as any[]
    setSignals(arr)
    if(arr.length) setSelected(arr[0].symbol)
  }
  async function loadHist(){
    const { data } = await supabase.from('signals').select('*').eq('symbol',selected).order('created_at',{ascending:false}).limit(20)
    if(data) setHistory(data.reverse())
  }

  return (
    <div style={{minHeight:'100vh', background:'#000', color:'#fff', padding:12, fontFamily:'system-ui'}}>
      <div style={{maxWidth:1100, margin:'0 auto'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
          <h1 style={{fontSize:22, fontWeight:900, letterSpacing:-1}}>RADAR CRYPTO • EN VIVO</h1>
          <span style={{fontSize:10, background:'#052e16', color:'#4ade80', border:'1px solid #14532d', padding:'4px 8px', borderRadius:20}}>● Conectado a Supabase</span>
        </div>

        {/* 4 EN PANTALLA */}
        <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:14}}>
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} style={{
              cursor:'pointer', background:selected===s.symbol?'#18181b':'#101010', border:selected===s.symbol?'1px solid #22c55e':'1px solid #27272a',
              borderRadius:12, padding:10
            }}>
              <div style={{display:'flex', justifyContent:'space-between'}}>
                <div>
                  <div style={{fontWeight:900, fontSize:13}}>{s.symbol}</div>
                  <div style={{fontSize:11, color:'#a1a1aa'}}>${Number(s.price).toLocaleString()}</div>
                </div>
                <div style={{width:32,height:32, borderRadius:16, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900, fontSize:12,
                  background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444', color: s.score>=40?'#000':'#fff'
                }}>{s.score}</div>
              </div>
              <div style={{height:4, background:'#27272a', borderRadius:4, margin:'8px 0', overflow:'hidden'}}>
                <div style={{width:`${s.score}%`, height:'100%', background: s.score>=70?'#22c55e': s.score>=40?'#eab308':'#ef4444'}}/>
              </div>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                <span style={{fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:6, background: s.status==='COMPRAR'?'#052e16':'#422006', color: s.status==='COMPRAR'?'#4ade80':'#facc15'}}>{s.status}</span>
                <span style={{fontSize:9, color:'#71717a'}}>rsi {s.change_24h} • {s.volume}%</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'2fr 1fr', gap:8}}>
          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:10}}>
            <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', letterSpacing:1, marginBottom:8}}>HISTÓRICO {selected} - SCORE (últimos {history.length}) • live cada 15m</div>
            <div style={{display:'flex', alignItems:'flex-end', gap:3, height:120}}>
              {history.map((h:any,i:number)=>(
                <div key={i} style={{flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', gap:2}}>
                  <div title={`${h.score}`} style={{height:`${h.score}%`, background:'#22c55e', borderRadius:3, minHeight:2}}/>
                  <div style={{fontSize:7, color:'#52525b', textAlign:'center'}}>{new Date(h.created_at).toLocaleTimeString().slice(0,5)}</div>
                </div>
              ))}
            </div>
            <div style={{display:'flex', gap:12, marginTop:8, fontSize:10, color:'#71717a'}}>
              <span>Score actual: <b style={{color:'#fff'}}>{history[history.length-1]?.score || '--'}/100</b></span>
              <span>Precio: <b style={{color:'#fff'}}>${Number(history[history.length-1]?.price || 0).toLocaleString()}</b></span>
            </div>
          </div>

          <div style={{background:'#101010', border:'1px solid #27272a', borderRadius:12, padding:10}}>
            <div style={{fontSize:10, fontWeight:700, color:'#a1a1aa', letterSpacing:1, marginBottom:8}}>¿POR QUÉ {selected}? • TENDENCIA</div>
            <div style={{display:'flex', gap:6, marginBottom:8}}>
              <span style={{fontSize:9, padding:'3px 8px', borderRadius:12, background:'#1e3a8a', color:'#93c5fd', border:'1px solid #1e40af'}}>{NEWS[selected]?.tag || 'Analizando'}</span>
            </div>
            <p style={{fontSize:12, lineHeight:'16px', color:'#d4d4d8', marginBottom:10}}>{NEWS[selected]?.text}</p>
            <div style={{background:'#000', border:'1px solid #27272a', borderRadius:8, padding:8, fontSize:11}}>
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:4}}><span style={{color:'#71717a'}}>RSI</span><span>{signals.find((x:any)=>x.symbol===selected)?.change_24h} → {Number(signals.find((x:any)=>x.symbol===selected)?.change_24h)<45?'sobreventa':'neutral'}</span></div>
              <div style={{display:'flex', justifyContent:'space-between', marginBottom:4}}><span style={{color:'#71717a'}}>MACD</span><span style={{color:'#4ade80'}}>alcista</span></div>
              <div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:'#71717a'}}>Volumen</span><span>+{signals.find((x:any)=>x.symbol===selected)?.volume}%</span></div>
            </div>
          </div>
        </div>

        <div style={{textAlign:'center', fontSize:9, color:'#52525b', marginTop:12}}>Radar Crypto v2.1 • 4 por pantalla sin Tailwind • histórico real de Supabase • actualizado cada 15m vía /api/cron</div>
      </div>
    </div>
  )
}
