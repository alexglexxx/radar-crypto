'use client'

import { useEffect, useState } from 'react'

type Item = { source:string; url:string; title:string; published_at:string|null; summary:string; why_it_matters:string; impact_direction:string; impact_intensity:string; impact_start:string; primary_window:string; persistence_window:string; affected_assets:string[]; relevance_score:number; confidence:number; market_confirmation:string }
type Briefing = { briefing_date:string; title:string; intro:string|null; market_read:string|null; risk_read:string|null; generated_at:string; model_version:string; item_count:number; items:Item[] }

const direction: Record<string,{icon:string,label:string}> = { positive:{icon:'↗',label:'Positivo'}, negative:{icon:'↘',label:'Negativo'}, mixed:{icon:'↕',label:'Mixto'}, neutral:{icon:'→',label:'Neutral'} }
const intensity: Record<string,string> = { critical:'CRÍTICO', high:'ALTO', medium:'MEDIO', low:'BAJO' }

export default function NewsIntelligence(){
  const [briefing,setBriefing]=useState<Briefing|null>(null)
  const [loading,setLoading]=useState(true)
  useEffect(()=>{ fetch('/api/daily-news').then(r=>r.json()).then(async()=>{
    const res=await fetch('/api/news-briefing'); const json=await res.json(); if(json.ok) setBriefing(json.briefing)
  }).catch(()=>{}).finally(()=>setLoading(false)) },[])

  return <section style={{marginTop:18,border:'1px solid #1e293b',borderRadius:20,background:'linear-gradient(145deg,#0d1317,#090c0f)',overflow:'hidden'}}>
    <div style={{padding:'16px 17px 13px',borderBottom:'1px solid #172027',display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}>
      <div><div style={{fontSize:10,fontWeight:900,letterSpacing:'.14em',color:'#34d399'}}>NEWS INTELLIGENCE</div><div style={{fontSize:21,fontWeight:950,letterSpacing:'-.04em',marginTop:3}}>CRYPTO DAILY</div></div>
      <div style={{textAlign:'right',fontSize:9,color:'#64748b'}}><div style={{color:'#94a3b8',fontWeight:800}}>BTC · ETH · SOL · XRP</div><div>1 briefing / día</div></div>
    </div>
    {loading ? <div style={{padding:22,color:'#64748b',fontSize:12}}>Preparando inteligencia…</div> : !briefing ? <div style={{padding:22,color:'#64748b',fontSize:12}}>Aún no hay briefing diario.</div> : <>
      <div style={{padding:'15px 17px 10px'}}><div style={{fontSize:13,lineHeight:1.55,color:'#cbd5e1'}}>{briefing.intro}</div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:12}}><div style={{background:'#10161a',borderRadius:12,padding:11}}><div style={{fontSize:8,color:'#64748b',fontWeight:900}}>LECTURA DEL MERCADO</div><div style={{fontSize:11,color:'#e2e8f0',lineHeight:1.45,marginTop:5}}>{briefing.market_read}</div></div><div style={{background:'#10161a',borderRadius:12,padding:11}}><div style={{fontSize:8,color:'#64748b',fontWeight:900}}>RIESGO / ATENCIÓN</div><div style={{fontSize:11,color:'#e2e8f0',lineHeight:1.45,marginTop:5}}>{briefing.risk_read}</div></div></div></div>
      <div style={{padding:'2px 17px 17px',display:'grid',gap:9}}>{briefing.items.map((item,i)=>{const d=direction[item.impact_direction]||direction.neutral; return <article key={item.url} style={{background:'#0a0f13',border:'1px solid #1a252d',borderRadius:15,padding:13}}>
        <div style={{display:'flex',gap:9,alignItems:'flex-start'}}><div style={{minWidth:25,height:25,borderRadius:8,background:item.impact_direction==='positive'?'rgba(52,211,153,.12)':item.impact_direction==='negative'?'rgba(251,113,133,.12)':'rgba(251,191,36,.10)',display:'grid',placeItems:'center',fontWeight:900,color:item.impact_direction==='positive'?'#34d399':item.impact_direction==='negative'?'#fb7185':'#fbbf24'}}>{i+1}</div><div style={{flex:1}}><div style={{display:'flex',justifyContent:'space-between',gap:8}}><a href={item.url} target="_blank" rel="noreferrer" style={{color:'#f8fafc',textDecoration:'none',fontWeight:900,fontSize:13,lineHeight:1.3}}>{item.title}</a><span style={{fontSize:9,color:'#64748b',whiteSpace:'nowrap'}}>{item.source}</span></div>
        <div style={{fontSize:11,color:'#cbd5e1',lineHeight:1.5,marginTop:7}}>{item.summary}</div><div style={{fontSize:10,color:'#94a3b8',lineHeight:1.45,marginTop:6}}><b style={{color:'#e2e8f0'}}>Por qué importa:</b> {item.why_it_matters}</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:5,marginTop:9}}><span style={{padding:'4px 7px',borderRadius:999,background:'#111a20',color:'#cbd5e1',fontSize:8,fontWeight:900}}>{d.icon} {d.label}</span><span style={{padding:'4px 7px',borderRadius:999,background:'#111a20',color:'#cbd5e1',fontSize:8,fontWeight:900}}>FUERZA {intensity[item.impact_intensity]||item.impact_intensity}</span><span style={{padding:'4px 7px',borderRadius:999,background:'#111a20',color:'#cbd5e1',fontSize:8,fontWeight:900}}>INICIO {item.impact_start}</span><span style={{padding:'4px 7px',borderRadius:999,background:'#111a20',color:'#cbd5e1',fontSize:8,fontWeight:900}}>VENTANA {item.primary_window}</span><span style={{padding:'4px 7px',borderRadius:999,background:'#111a20',color:'#cbd5e1',fontSize:8,fontWeight:900}}>{item.affected_assets.join(' · ')}</span></div>
        <div style={{marginTop:9,paddingTop:8,borderTop:'1px solid #172027',display:'flex',justifyContent:'space-between',fontSize:9,color:'#64748b'}}><span>Persistencia posible: <b style={{color:'#94a3b8'}}>{item.persistence_window}</b></span><span>Confianza {item.confidence}%</span></div>
        </div></div>
      </article>})}</div>
      <div style={{padding:'0 17px 14px',fontSize:8,color:'#475569'}}>Las ventanas de impacto son estimaciones de inteligencia, no predicciones de precio. El mercado debe confirmar la reacción.</div>
    </>}
  </section>
}
