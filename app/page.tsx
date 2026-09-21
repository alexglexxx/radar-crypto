"use client"
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const MOCK = [
 {symbol:'BTC', price: 68234.21, score: 78, action:'COMPRAR', reason:{rsi:34, macd:'alcista', vol:'+32%'}},
 {symbol:'ETH', price: 3456.12, score: 45, action:'MANTENER', reason:{rsi:56, macd:'neutral', vol:'+5%'}},
 {symbol:'SOL', price: 178.90, score: 82, action:'COMPRAR', reason:{rsi:28, macd:'alcista', vol:'+41%'}},
]

export default function Page(){
 const [signals,setSignals]=useState<any[]>(MOCK)
 useEffect(()=>{
  async function load(){
   const {data}=await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(5)
   if(data && data.length>0){ console.log('Signals de Supabase', data) }
  }
  load()
 },[])
 return (
  <div style={{padding:24, maxWidth:1100, margin:'0 auto'}}>
   <h1 style={{fontSize:32, letterSpacing:-1}}>● RADAR CRYPTO</h1>
   <p style={{opacity:0.6}}>Tu radar inteligente, no adivina, analiza. Conectado a Supabase.</p>
   <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))', gap:16, marginTop:24}}>
    {signals.map(s=>(
     <div key={s.symbol} style={{border:'1px solid #222', borderRadius:16, padding:16, background:'#111'}}>
      <div style={{display:'flex', justifyContent:'space-between'}}><b>{s.symbol}</b><span style={{color: s.action==='COMPRAR'?'#10b981':'#f59e0b'}}>{s.action}</span></div>
      <div style={{fontSize:28, margin:'8px 0'}}>${s.price}</div>
      <div>Score: {s.score}/100</div>
      <div style={{height:6, background:'#222', borderRadius:10, marginTop:8}}><div style={{width:`${s.score}%`, height:'100%', background:'#10b981', borderRadius:10}} /></div>
      <pre style={{fontSize:11, opacity:0.5, marginTop:8}}>{JSON.stringify(s.reason,null,2)}</pre>
     </div>
    ))}
   </div>
  </div>
 )
}
