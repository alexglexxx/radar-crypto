'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

const NEWS_MOCK: any = {
  BTC: { reason: 'RSI en 33 (sobreventa) + MACD alcista + ballenas acumulando. Tendencia: rebote técnico.', tag: 'Acumulación' },
  ETH: { reason: 'RSI neutral 49, volumen bajo. Esperando actualización Pectra. Tendencia lateral.', tag: 'Lateral' },
  SOL: { reason: 'Volumen +45% y TVL subiendo. Memecoins empujando red. Tendencia alcista.', tag: 'Alcista' },
  XRP: { reason: 'Noticia: Avance caso SEC. Volumen +60%. Tendencia alcista fuerte.', tag: 'Noticia positiva' },
}

export default function Page(){
  const [signals, setSignals] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [selected, setSelected] = useState('BTC')

  useEffect(()=>{
    load()
  },[])

  async function load(){
    const { data } = await supabase.from('signals').select('*').order('created_at', {ascending:false}).limit(100)
    if(!data) return
    // Agrupa por symbol y toma el ultimo
    const latest: any = {}
    data.forEach((r:any)=>{
      if(!latest[r.symbol]) latest[r.symbol] = r
    })
    setSignals(Object.values(latest))
    // Historico para grafica
    const hist = data.filter((r:any)=>r.symbol===selected).reverse().slice(-20).map((r:any,i:number)=>({ time: i, price: Number(r.price), score: r.score }))
    setHistory(hist)
    if(Object.values(latest).length>0 && !Object.values(latest).find((s:any)=>s.symbol===selected)){
      setSelected((Object.values(latest)[0] as any).symbol)
    }
  }

  useEffect(()=>{
    supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(100).then(({data})=>{
      if(!data) return
      const hist = data.filter((r:any)=>r.symbol===selected).reverse().slice(-20).map((r:any,i:number)=>({ time: new Date(r.created_at).toLocaleTimeString().slice(0,5), price: Number(r.price), score: r.score }))
      setHistory(hist)
    })
  },[selected])

  return (
    <div className="min-h-screen bg-black text-white p-3 font-sans">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-3">
          <h1 className="text-xl font-black tracking-tight">RADAR CRYPTO • EN VIVO</h1>
          <div className="text-[10px] bg-green-500/20 text-green-400 px-2 py-1 rounded-full border border-green-500/30">● Conectado a Supabase</div>
        </div>

        {/* GRID 4 EN UN PANTALLAZO - CUADROS PEQUEÑOS */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {signals.map((s:any)=>(
            <div key={s.symbol} onClick={()=>setSelected(s.symbol)} className={`cursor-pointer rounded-xl border p-3 transition-all ${selected===s.symbol ? 'border-green-500 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'} `}>
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-black text-sm">{s.symbol}</div>
                  <div className="text-[11px] text-zinc-400">${Number(s.price).toLocaleString(undefined,{maximumFractionDigits:2})}</div>
                </div>
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-black ${s.score>=70 ? 'bg-green-500 text-black' : s.score>=40 ? 'bg-yellow-500 text-black' : 'bg-red-500 text-white'}`}>{s.score}</div>
              </div>
              <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden mb-2">
                <div className={`h-full ${s.score>=70?'bg-green-500': s.score>=40?'bg-yellow-500':'bg-red-500'}`} style={{width:`${s.score}%`}}/>
              </div>
              <div className="flex justify-between items-center">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${s.status==='COMPRAR'?'bg-green-500/20 text-green-400':'bg-yellow-500/20 text-yellow-400'}`}>{s.status}</span>
                <span className="text-[10px] text-zinc-500">rsi {s.change_24h} • {s.volume}%</span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* GRAFICA HISTORICO */}
          <div className="lg:col-span-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xs font-bold tracking-widest text-zinc-400">HISTÓRICO {selected} - SCORE & PRECIO (últimos 20)</h2>
              <span className="text-[10px] text-zinc-500">live cada 15m</span>
            </div>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history}>
                  <XAxis dataKey="time" hide/>
                  <YAxis hide domain={['auto','auto']}/>
                  <Tooltip contentStyle={{background:'#18181b', border:'1px solid #27272a', fontSize:10}}/>
                  <Line type="monotone" dataKey="score" stroke="#22c55e" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="price" stroke="#3f3f46" strokeWidth={1} dot={false} strokeDasharray="3 3"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* SECCION NOTICIAS / POR QUE COMPRAR */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <h2 className="text-xs font-bold tracking-widest text-zinc-400 mb-3">¿POR QUÉ {selected}? • TENDENCIA</h2>
            <div className="space-y-3">
              <div className="flex gap-2">
                <span className="text-[10px] px-2 py-1 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 h-fit">{NEWS_MOCK[selected]?.tag || 'Analizando'}</span>
                <span className="text-[10px] px-2 py-1 rounded-full bg-zinc-800 text-zinc-400">{selected==='BTC'?'Vol +32%':'Vol alto'}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-zinc-300">
                {NEWS_MOCK[selected]?.reason || 'Analizando RSI, MACD y volumen para generar recomendación...'}
              </p>
              <div className="rounded-lg bg-black border border-zinc-800 p-2.5 text-[11px] space-y-1">
                <div className="flex justify-between"><span className="text-zinc-500">RSI</span><span className="text-white">{signals.find((x:any)=>x.symbol===selected)?.change_24h || '--'} {Number(signals.find((x:any)=>x.symbol===selected)?.change_24h) < 40 ? '→ sobreventa' : '→ neutral'}</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">MACD</span><span className="text-green-400">alcista</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Volumen 24h</span><span className="text-white">{signals.find((x:any)=>x.symbol===selected)?.volume || '--'}%</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Score Radar</span><span className="font-bold text-white">{signals.find((x:any)=>x.symbol===selected)?.score}/100</span></div>
              </div>
              <div className="text-[10px] text-zinc-500 pt-1">
                Fuente: Supabase + CoinGecko + Análisis técnico. No es consejo financiero.
              </div>
            </div>
          </div>
        </div>

        <div className="text-[10px] text-zinc-600 text-center mt-4">Radar Crypto v2 • 4 por pantalla • histórico live • actualizado cada 15 min vía /api/cron</div>
      </div>
    </div>
  )
}
