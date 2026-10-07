import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type Candle={openTime:number;open:number;high:number;low:number;close:number;volume:number}
const SYMBOLS=(process.env.SYMBOLS??'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s=>s.trim()).filter(Boolean)
const MONTHS=Math.max(6,Number(process.env.MONTHS??24)), INTERVAL='1h'
const DATA_DIR=path.join(process.cwd(),'.backtest-cache-discovery'), REPORT_DIR=path.join(process.cwd(),'reports')
const COST=(10+5)/10000

function monthKeys(a:Date,b:Date){const out:string[]=[];const d=new Date(Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),1));const e=new Date(Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),1));while(d<=e){out.push(d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0'));d.setUTCMonth(d.getUTCMonth()+1)}return out}

async function download(symbol:string,m:string){
  const file=path.join(DATA_DIR,symbol+'-'+INTERVAL+'-'+m+'.zip')
  try{await fs.access(file);return file}catch{}
  const url='https://data.binance.vision/data/spot/monthly/klines/'+symbol+'/'+INTERVAL+'/'+symbol+'-'+INTERVAL+'-'+m+'.zip'
  const res=await fetch(url)
  if(res.status===404){console.warn('[discovery] 404 '+symbol+' '+m);return null}
  if(!res.ok)throw new Error('Binance archive '+res.status+': '+url)
  await fs.mkdir(DATA_DIR,{recursive:true})
  await fs.writeFile(file,Buffer.from(await res.arrayBuffer()))
  return file
}

async function unzip(file:string){
  const dir=path.join(DATA_DIR,'tmp-'+Date.now()+'-'+Math.random().toString(36).slice(2))
  await fs.mkdir(dir,{recursive:true})
  await exec('unzip',['-oq',file,'-d',dir])
  const name=(await fs.readdir(dir)).find(x=>x.endsWith('.csv'))
  if(!name)throw new Error('No CSV in '+file)
  const lines=(await fs.readFile(path.join(dir,name),'utf8')).trim().split(/\r?\n/)
  const start=lines[0]?.toLowerCase().includes('open time')?1:0
  const out:Candle[]=[]
  for(let i=start;i<lines.length;i++){
    const r=lines[i].split(',')
    if(r.length<6)continue
    const rawT=Number(r[0]), t=rawT>1e14?Math.floor(rawT/1000):rawT
    const [o,h,l,c,v]=r.slice(1,6).map(Number)
    if([t,o,h,l,c,v].every(Number.isFinite))out.push({openTime:t,open:o,high:h,low:l,close:c,volume:v})
  }
  await fs.rm(dir,{recursive:true,force:true})
  return out
}

async function load(symbol:string,start:number,end:number){
  const months=monthKeys(new Date(start),new Date(end)),out:Candle[]=[],
    loadedMonths:string[]=[],missingMonths:string[]=[]
  for(const m of months){
    const f=await download(symbol,m)
    if(!f){missingMonths.push(m);continue}
    const rows=await unzip(f)
    if(rows.length)loadedMonths.push(m)
    out.push(...rows)
  }
  const filtered=out.filter(c=>c.openTime>=start&&c.openTime<=end).sort((a,b)=>a.openTime-b.openTime)
  return{candles:filtered,requestedMonths:months,loadedMonths,missingMonths}
}

function emaSeries(a:number[],n:number){
  const out:(number|null)[]=Array(a.length).fill(null)
  if(a.length<n)return out
  let x=a.slice(0,n).reduce((p,q)=>p+q,0)/n
  out[n-1]=x
  const k=2/(n+1)
  for(let i=n;i<a.length;i++){x=a[i]*k+x*(1-k);out[i]=x}
  return out
}

function smaSeries(a:number[],n:number){
  const out:(number|null)[]=Array(a.length).fill(null)
  let sum=0
  for(let i=0;i<a.length;i++){
    sum+=a[i]
    if(i>=n)sum-=a[i-n]
    if(i>=n-1)out[i]=sum/n
  }
  return out
}

function rsiSeries(a:number[],n=14){
  const out:(number|null)[]=Array(a.length).fill(null)
  if(a.length<=n)return out
  let g=0,l=0
  for(let i=1;i<=n;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}
  let ag=g/n,al=l/n
  const value=()=>al===0?(ag===0?50:100):100-100/(1+ag/al)
  out[n]=value()
  for(let i=n+1;i<a.length;i++){
    const d=a[i]-a[i-1]
    ag=(ag*(n-1)+Math.max(d,0))/n
    al=(al*(n-1)+Math.max(-d,0))/n
    out[i]=value()
  }
  return out
}

function atrSeries(c:Candle[],n=14){
  const tr=(number[])[] // placeholder for type inference
  void tr
  const x:number[] = Array(c.length).fill(0)
  for(let i=1;i<c.length;i++)x[i]=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close))
  return smaSeries(x,n)
}

function realizedVolSeries(a:number[],n=20){
  const out:(number|null)[]=Array(a.length).fill(null), r:number[] = Array(a.length).fill(0)
  for(let i=1;i<a.length;i++)r[i]=a[i-1]>0&&a[i]>0?Math.log(a[i]/a[i-1]):0
  for(let i=n;i<a.length;i++){
    let sum=0
    for(let j=i-n+1;j<=i;j++)sum+=r[j]
    const m=sum/n
    let ss=0
    for(let j=i-n+1;j<=i;j++)ss+=(r[j]-m)**2
    out[i]=Math.sqrt(ss/n)*Math.sqrt(n)
  }
  return out
}

function scoreAt(i:number,c:Candle[],e20:(number|null)[],e50:(number|null)[],e200:(number|null)[],rsi:(number|null)[],macdHist:(number|null)[],volRatio:(number|null)[],atr:(number|null)[],vol:(number|null)[]){
  let s=50
  const e20i=e20[i],e50i=e50[i],e200i=e200[i]
  if(e20i!==null&&e50i!==null)s+=e20i>e50i?8:-8
  if(e20i!==null&&e50i!==null){const trend=e20i/e50i-1;s+=trend>=.01?10:trend>=.003?5:trend<=-.01?-10:trend<=-.003?-5:0}
  const ret=(n:number)=>{const b=c[i-n]?.close;return b>0?c[i].close/b-1:0}
  s+=Math.max(-5,Math.min(5,ret(1)*500))
  s+=Math.max(-8,Math.min(8,ret(4)*200))
  s+=Math.max(-6,Math.min(6,ret(12)*100))
  s+=Math.max(-6,Math.min(6,ret(24)*50))
  const vr=volRatio[i]
  if(vr!==null)s+=vr>=2?10:vr>=1.3?7:vr>=1.05?3:vr<.7?-6:0
  const mh=macdHist[i]
  if(mh!==null)s+=mh>0?5:-5
  const ri=rsi[i]
  if(ri!==null)s+=ri>=52&&ri<=68?5:(ri>=45&&ri<=72?1:(ri>78?-6:ri<35?-5:0))
  const at=atr[i]
  if(at!==null&&e200i!==null&&e200i>0&&at/e200i>.08)s-=5
  void vol
  return Math.round(Math.max(0,Math.min(100,s)))
}

function mean(a:number[]){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null}

async function main(){
  const now=new Date()
  const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)-1)
  const start=new Date(end)
  start.setUTCMonth(start.getUTCMonth()-(MONTHS-1))
  start.setUTCHours(0,0,0,0)
  const rows:any[]=[],coverage:any[]=[]

  for(const symbol of SYMBOLS){
    const loaded=await load(symbol,start.getTime(),end.getTime()),c=loaded.candles
    const expected=Math.max(0,Math.floor((end.getTime()-start.getTime())/3600000)+1)
    let gaps=0,maxGapHours=0
    for(let i=1;i<c.length;i++){const gap=(c[i].openTime-c[i-1].openTime)/3600000;if(gap>1.01){gaps++;maxGapHours=Math.max(maxGapHours,gap)}}
    const first=c[0]?.openTime??null,last=c[c.length-1]?.openTime??null
    coverage.push({symbol,requestedMonths:loaded.requestedMonths.length,loadedMonths:loaded.loadedMonths.length,missingMonths:loaded.missingMonths,expectedHourlyCandles:expected,actualCandles:c.length,coverageRatio:expected?c.length/expected:null,firstCandle:first?new Date(first).toISOString():null,lastCandle:last?new Date(last).toISOString():null,gaps,maxGapHours})
    console.log('[discovery] '+symbol+': '+c.length+' hourly candles | '+(first?new Date(first).toISOString():'N/A')+' -> '+(last?new Date(last).toISOString():'N/A')+' | months '+loaded.loadedMonths.length+'/'+loaded.requestedMonths.length+' | gaps='+gaps+' maxGapHours='+maxGapHours)
    if(c.length<Math.floor(expected*.9))throw new Error('[discovery] Coverage failure for '+symbol+': expected about '+expected+' hourly candles, got '+c.length+' ('+(c.length/expected*100).toFixed(1)+'%). Refusing to publish discovery results.')

    // Precompute all indicator series once. The previous implementation recalculated
    // the full history for every candle, making the screen O(n²) and exceeding CI's 20m limit.
    const a=c.map(x=>x.close),v=c.map(x=>x.volume)
    const e20=emaSeries(a,20),e50=emaSeries(a,50),e200=emaSeries(a,200),e12=emaSeries(a,12),e26=emaSeries(a,26)
    const macd:(number|null)[]=a.map((_,i)=>e12[i]!==null&&e26[i]!==null?e12[i]! - e26[i]!:null)
    const macdValues=macd.filter((x):x is number=>x!==null),sigValues=emaSeries(macdValues,9)
    const macdHist:(number|null)[]=Array(a.length).fill(null)
    let mi=0
    for(let i=0;i<a.length;i++)if(macd[i]!==null){const sig=sigValues[mi];if(sig!==null)macdHist[i]=macd[i]! - sig;mi++}
    const vs=smaSeries(v,20),atr=atrSeries(c,14),rsi=rsiSeries(a),rv=realizedVolSeries(a,20)
    const volRatio:(number|null)[]=vs.map((x,i)=>x!==null&&x>0?v[i]/x:null)
    for(let i=220;i<c.length-24;i++)rows.push({symbol,time:c[i].openTime,score:scoreAt(i,c,e20,e50,e200,rsi,macdHist,volRatio,atr,rv),r1:c[i+1].close/c[i].close-1,r4:c[i+4].close/c[i].close-1,r12:c[i+12].close/c[i].close-1,r24:c[i+24].close/c[i].close-1})
  }

  const defs=[[0,39,'0-39'],[40,49,'40-49'],[50,59,'50-59'],[60,69,'60-69'],[70,79,'70-79'],[80,100,'80-100']]
  const byScore=defs.map(([lo,hi,bucket])=>{const x=rows.filter(r=>r.score>=lo&&r.score<=hi),n=x.length;return{bucket,signals:n,winRate4h:n?x.filter(r=>r.r4>COST).length/n:null,avg1h:mean(x.map(r=>r.r1)),avg4hNet:mean(x.map(r=>r.r4-COST)),avg12h:mean(x.map(r=>r.r12)),avg24h:mean(x.map(r=>r.r24))}})
  const high=rows.filter(r=>r.score>=70),low=rows.filter(r=>r.score<50)
  const report={report_name:'radar-crypto-discovery-1h',generated_at:new Date().toISOString(),data:{requestedStart:start.toISOString(),requestedEnd:end.toISOString(),months:MONTHS,interval:'1h',symbols:SYMBOLS,total_observations:rows.length,coverage},methodology:{purpose:'Fast discovery screen for monotonic predictive structure, not a production backtest.',production_untouched:true,fee_bps:10,slippage_bps:5,score_note:'Candidate score reuses production indicator families with 1h-normalized horizons; it is research-only.'},by_score:byScore,comparison:{high_ge70:{signals:high.length,avg4hNet:mean(high.map(r=>r.r4-COST)),winRate4h:high.length?high.filter(r=>r.r4>COST).length/high.length:null},low_lt50:{signals:low.length,avg4hNet:mean(low.map(r=>r.r4-COST)),winRate4h:low.length?low.filter(r=>r.r4>COST).length/low.length:null}}}
  await fs.mkdir(REPORT_DIR,{recursive:true})
  await fs.writeFile(path.join(REPORT_DIR,'backtest-discovery-1h.json'),JSON.stringify(report,null,2)+'\n')
  await fs.writeFile(path.join(REPORT_DIR,'backtest-discovery-1h-by-score.csv'),['score_bucket,signals,win_rate_4h_net,avg_1h,avg_4h_net,avg_12h,avg_24h',...byScore.map(r=>[r.bucket,r.signals,r.winRate4h??'',r.avg1h??'',r.avg4hNet??'',r.avg12h??'',r.avg24h??''].join(','))].join('\n')+'\n')
  console.log('\n[discovery] SCORE SHAPE')
  for(const r of byScore)console.log(r.bucket+' n='+r.signals+' win4h_net='+(r.winRate4h===null?'N/A':(r.winRate4h*100).toFixed(1)+'%')+' avg4h_net='+(r.avg4hNet===null?'N/A':(r.avg4hNet*100).toFixed(3)+'%'))
  console.log('[discovery] high>=70 avg4h_net='+mean(high.map(r=>r.r4-COST))+' low<50 avg4h_net='+mean(low.map(r=>r.r4-COST)))
}
main().catch(e=>{console.error('[discovery] Error:',e);process.exit(1)})
