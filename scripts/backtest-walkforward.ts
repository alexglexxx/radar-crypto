import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type Candle={openTime:number;open:number;high:number;low:number;close:number;volume:number}
type Obs={symbol:string;time:number;score:number;r4:number}
const SYMBOLS=(process.env.SYMBOLS??'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s=>s.trim()).filter(Boolean)
const MONTHS=Math.max(12,Number(process.env.MONTHS??24))
const INTERVAL='1h'
const COST=(10+5)/10000
const DATA_DIR=path.join(process.cwd(),'.backtest-cache-discovery')
const REPORT_DIR=path.join(process.cwd(),'reports')

function monthKeys(a:Date,b:Date){const out:string[]=[];const d=new Date(Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),1));const e=new Date(Date.UTC(b.getUTCFullYear(),b.getUTCMonth(),1));while(d<=e){out.push(d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0'));d.setUTCMonth(d.getUTCMonth()+1)}return out}
async function download(symbol:string,m:string){const file=path.join(DATA_DIR,symbol+'-'+INTERVAL+'-'+m+'.zip');try{await fs.access(file);return file}catch{}const url='https://data.binance.vision/data/spot/monthly/klines/'+symbol+'/'+INTERVAL+'/'+symbol+'-'+INTERVAL+'-'+m+'.zip';const res=await fetch(url);if(res.status===404)return null;if(!res.ok)throw new Error('Binance archive '+res.status+': '+url);await fs.mkdir(DATA_DIR,{recursive:true});await fs.writeFile(file,Buffer.from(await res.arrayBuffer()));return file}
async function unzip(file:string){const dir=path.join(DATA_DIR,'tmp-'+Date.now()+'-'+Math.random().toString(36).slice(2));await fs.mkdir(dir,{recursive:true});await exec('unzip',['-oq',file,'-d',dir]);const name=(await fs.readdir(dir)).find(x=>x.endsWith('.csv'));if(!name)throw new Error('No CSV in '+file);const lines=(await fs.readFile(path.join(dir,name),'utf8')).trim().split(/\r?\n/);const start=lines[0]?.toLowerCase().includes('open time')?1:0;const out:Candle[]=[];for(let i=start;i<lines.length;i++){const r=lines[i].split(',');if(r.length<6)continue;const rawT=Number(r[0]),t=rawT>1e14?Math.floor(rawT/1000):rawT;const[o,h,l,c,v]=r.slice(1,6).map(Number);if([t,o,h,l,c,v].every(Number.isFinite))out.push({openTime:t,open:o,high:h,low:l,close:c,volume:v})}await fs.rm(dir,{recursive:true,force:true});return out}
async function load(symbol:string,start:number,end:number){const out:Candle[]=[];for(const m of monthKeys(new Date(start),new Date(end))){const f=await download(symbol,m);if(f)out.push(...await unzip(f))}return out.filter(c=>c.openTime>=start&&c.openTime<=end).sort((a,b)=>a.openTime-b.openTime)}
function emaSeries(a:number[],n:number){const out:(number|null)[]=Array(a.length).fill(null);if(a.length<n)return out;let x=a.slice(0,n).reduce((p,q)=>p+q,0)/n;out[n-1]=x;const k=2/(n+1);for(let i=n;i<a.length;i++){x=a[i]*k+x*(1-k);out[i]=x}return out}
function smaSeries(a:number[],n:number){const out:(number|null)[]=Array(a.length).fill(null);let sum=0;for(let i=0;i<a.length;i++){sum+=a[i];if(i>=n)sum-=a[i-n];if(i>=n-1)out[i]=sum/n}return out}
function rsiSeries(a:number[],n=14){const out:(number|null)[]=Array(a.length).fill(null);if(a.length<=n)return out;let g=0,l=0;for(let i=1;i<=n;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}let ag=g/n,al=l/n;const value=()=>al===0?(ag===0?50:100):100-100/(1+ag/al);out[n]=value();for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(n-1)+Math.max(d,0))/n;al=(al*(n-1)+Math.max(-d,0))/n;out[i]=value()}return out}
function atrSeries(c:Candle[],n=14){const x:number[]=Array(c.length).fill(0);for(let i=1;i<c.length;i++)x[i]=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close));return smaSeries(x,n)}
function scoreAt(i:number,c:Candle[],e20:(number|null)[],e50:(number|null)[],e200:(number|null)[],rsi:(number|null)[],macdHist:(number|null)[],volRatio:(number|null)[],atr:(number|null)[]){let s=50;const e20i=e20[i],e50i=e50[i],e200i=e200[i];if(e20i!==null&&e50i!==null)s+=e20i>e50i?8:-8;if(e20i!==null&&e50i!==null){const trend=e20i/e50i-1;s+=trend>=.01?10:trend>=.003?5:trend<=-.01?-10:trend<=-.003?-5:0}const ret=(n:number)=>{const b=c[i-n]?.close;return b>0?c[i].close/b-1:0};s+=Math.max(-5,Math.min(5,ret(1)*500));s+=Math.max(-8,Math.min(8,ret(4)*200));s+=Math.max(-6,Math.min(6,ret(12)*100));s+=Math.max(-6,Math.min(6,ret(24)*50));const vr=volRatio[i];if(vr!==null)s+=vr>=2?10:vr>=1.3?7:vr>=1.05?3:vr<.7?-6:0;const mh=macdHist[i];if(mh!==null)s+=mh>0?5:-5;const ri=rsi[i];if(ri!==null)s+=ri>=52&&ri<=68?5:(ri>=45&&ri<=72?1:(ri>78?-6:ri<35?-5:0));const at=atr[i];if(at!==null&&e200i!==null&&e200i>0&&at/e200i>.08)s-=5;return Math.round(Math.max(0,Math.min(100,s)))}
function stats(x:Obs[],threshold:number){let wins=0,sum=0,profit=0,loss=0,trades=0;for(const o of x){if(o.score<threshold)continue;const r=o.r4-COST;trades++;sum+=r;if(r>0){wins++;profit+=r}else loss+=-r}return{threshold,trades,winRate:trades?wins/trades:null,expectancy:trades?sum/trades:null,profitFactor:loss>0?profit/loss:null,totalReturn:sum}}
function nonOverlapping(x:Obs[],threshold:number){const sorted=x.filter(o=>o.score>=threshold).sort((a,b)=>a.time-b.time);const chosen:Obs[]=[];let next=0;for(const o of sorted){if(o.time<next)continue;chosen.push(o);next=o.time+4*3600000}return stats(chosen,threshold)}
function fmt(v:number|null){return v===null?'N/A':(v*100).toFixed(3)+'%'}
async function main(){
 const now=new Date(),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)-1),start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-(MONTHS-1),1))
 const all:Obs[]=[];const coverage:any[]=[]
 for(const symbol of SYMBOLS){const c=await load(symbol,start.getTime(),end.getTime());const expected=Math.floor((end.getTime()-start.getTime())/3600000)+1;let gaps=0;for(let i=1;i<c.length;i++)if((c[i].openTime-c[i-1].openTime)/3600000>1.01)gaps++;coverage.push({symbol,expected,actual:c.length,gaps});if(c.length<expected*.9)throw new Error('Coverage failure '+symbol+' '+c.length+'/'+expected)
  const a=c.map(x=>x.close),v=c.map(x=>x.volume),e20=emaSeries(a,20),e50=emaSeries(a,50),e200=emaSeries(a,200),e12=emaSeries(a,12),e26=emaSeries(a,26),macd=a.map((_,i)=>e12[i]!==null&&e26[i]!==null?e12[i]! - e26[i]!:null);const mv=macd.filter((x):x is number=>x!==null),sv=emaSeries(mv,9),hist:(number|null)[]=Array(a.length).fill(null);let mi=0;for(let i=0;i<a.length;i++)if(macd[i]!==null){if(sv[mi]!==null)hist[i]=macd[i]! - sv[mi]!;mi++}const vs=smaSeries(v,20),vr=vs.map((x,i)=>x!==null&&x>0?v[i]/x:null),rsi=rsiSeries(a),atr=atrSeries(c,14)
  for(let i=220;i<c.length-24;i++)all.push({symbol,time:c[i].openTime,score:scoreAt(i,c,e20,e50,e200,rsi,hist,vr,atr),r4:c[i+4].close/c[i].close-1})
 }
 // Fold boundaries are fixed by calendar dates. Threshold selection is train-only.
 const folds=[
  ['2024-10-01','2025-01-01','2025-10-01','2026-01-01'],
  ['2025-01-01','2025-04-01','2026-01-01','2026-04-01'],
  ['2025-04-01','2025-07-01','2026-04-01','2026-07-01'],
  ['2025-07-01','2025-10-01','2026-07-01','2026-10-01']
 ]
 const thresholds=[60,65,70,75,80,85,90],results:any[]=[]
 for(let k=0;k<folds.length;k++){const [tr0,tr1,te0,te1]=folds[k];const train=all.filter(o=>o.time>=Date.parse(tr0+'T00:00:00Z')&&o.time<Date.parse(tr1+'T00:00:00Z'));const test=all.filter(o=>o.time>=Date.parse(te0+'T00:00:00Z')&&o.time<Date.parse(te1+'T00:00:00Z'));const trainStats=thresholds.map(t=>({...stats(train,t),t})).filter(s=>s.trades>=100).sort((a,b)=>{const e=(b.expectancy??-1e9)-(a.expectancy??-1e9);return e||((b.profitFactor??-1)-(a.profitFactor??-1))});const selected=trainStats[0]?.t??70;const oos=stats(test,selected),oosNonOverlap=nonOverlapping(test,selected);results.push({fold:k+1,train:tr0+'..'+tr1,test:te0+'..'+te1,selectedThreshold:selected,trainBest:trainStats[0]??null,test:oos,testNonOverlapping:oosNonOverlap,fixed70:stats(test,70),fixed80:stats(test,80)});console.log('[walkforward] fold '+(k+1)+' train best='+selected+' | OOS trades='+oos.trades+' win='+fmt(oos.winRate)+' exp='+fmt(oos.expectancy)+' | nonOverlap exp='+fmt(oosNonOverlap.expectancy))}
 const selected=results.map(r=>r.selectedThreshold),oos=results.map(r=>r.testNonOverlapping),positive=oos.filter((r:any)=>(r.expectancy??-1)<0===false).length
 const report={report_name:'radar-crypto-walkforward-1h',generated_at:new Date().toISOString(),production_untouched:true,methodology:{train_months:12,test_months:3,thresholds,cost_bps_round_trip:15,threshold_selection:'train-only; highest training expectancy with >=100 observations; OOS never used for selection.',event_study_caveat:'Signals overlap at 1h frequency. testNonOverlapping enforces a 4h cooldown/hold proxy and is the primary OOS diagnostic.',not_deployable:true},coverage,folds:results,summary:{folds:results.length,selectedThresholds:selected,oosNonOverlappingExpectancies:oos.map((r:any)=>r.expectancy),positiveOosFolds:positive}}
 await fs.mkdir(REPORT_DIR,{recursive:true});await fs.writeFile(path.join(REPORT_DIR,'backtest-walkforward-1h.json'),JSON.stringify(report,null,2)+'\n')
 console.log('[walkforward] positive non-overlap OOS folds='+positive+'/'+results.length)
}
main().catch(e=>{console.error('[walkforward] Error:',e);process.exit(1)})
