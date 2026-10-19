import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }
type Config = { name: string; entry: number; exit: number }
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT').split(',').map(s => s.trim()).filter(Boolean)
const MONTHS = Math.max(24, Number(process.env.MONTHS ?? 24))
const COSTS = [15, 20, 25]
const INTERVAL = '1h'
const CACHE = path.join(process.cwd(), '.backtest-cache-discovery')

function monthsBetween(start: number, end: number) {
  const out: string[] = []
  const d = new Date(start); d.setUTCDate(1); d.setUTCHours(0,0,0,0)
  const e = new Date(end); e.setUTCDate(1); e.setUTCHours(0,0,0,0)
  while (d < e) { out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0')); d.setUTCMonth(d.getUTCMonth()+1) }
  return out
}
async function loadMonth(symbol: string, month: string): Promise<Candle[]> {
  const file = path.join(CACHE, symbol + '-' + INTERVAL + '-' + month + '.zip')
  try { await fs.access(file) } catch {
    const url = 'https://data.binance.vision/data/spot/monthly/klines/' + symbol + '/' + INTERVAL + '/' + symbol + '-' + INTERVAL + '-' + month + '.zip'
    const res = await fetch(url)
    if (res.status === 404) return []
    if (!res.ok) throw new Error('Binance HTTP ' + res.status + ': ' + url)
    await fs.mkdir(CACHE, {recursive:true}); await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
  }
  const dir = path.join(CACHE, 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  await fs.mkdir(dir,{recursive:true})
  try {
    await exec('unzip',['-oq',file,'-d',dir])
    const csv = (await fs.readdir(dir)).find(x=>x.endsWith('.csv'))
    if (!csv) throw new Error('CSV missing in ' + file)
    const lines = (await fs.readFile(path.join(dir,csv),'utf8')).trim().split(/\r?\n/)
    const offset = lines[0]?.toLowerCase().includes('open time') ? 1 : 0
    const rows: Candle[] = []
    for (let i=offset;i<lines.length;i++) {
      const a=lines[i].split(','); if(a.length<6) continue
      const raw=Number(a[0]), time=raw>1e14?Math.floor(raw/1000):raw
      const [open,high,low,close,volume]=a.slice(1,6).map(Number)
      if ([time,open,high,low,close,volume].every(Number.isFinite)&&open>0&&high>0&&low>0&&close>0) rows.push({time,open,high,low,close,volume})
    }
    return rows
  } finally { await fs.rm(dir,{recursive:true,force:true}) }
}
async function load(symbol: string,start:number,end:number) {
  const all=(await Promise.all(monthsBetween(start,end).map(m=>loadMonth(symbol,m)))).flat()
  const map=new Map<number,Candle>()
  for(const c of all) if(c.time>=start-100*3600000&&c.time<end) map.set(c.time,c)
  return [...map.values()].sort((a,b)=>a.time-b.time)
}
function high(c:Candle[],i:number,n:number){let v=-Infinity;for(let j=i-n;j<i;j++)v=Math.max(v,c[j].high);return v}
function low(c:Candle[],i:number,n:number){let v=Infinity;for(let j=i-n;j<i;j++)v=Math.min(v,c[j].low);return v}

type SimResult={equity:number[]; trades:number; wins:number; endLiquidations:number}
function simulateSleeve(c:Candle[],start:number,end:number,config:Config,costBps:number):SimResult {
  const fee=costBps/10000
  let cash=0.25, qty=0, entryPrice=0, entryTime=0, trades=0,wins=0,endLiquidations=0
  const equity:number[]=[]
  const first=Math.max(config.entry,config.exit)
  const inWindow=c.filter(x=>x.time>=start&&x.time<end)
  if(!inWindow.length) throw new Error('No candles in test window')
  const byTime=new Map(c.map((x,i)=>[x.time,i]))
  for(const bar of inWindow){
    const i=byTime.get(bar.time)!
    const next=c[i+1]
    const holding=qty>0
    if(!holding && i>=first && bar.close>high(c,i,config.entry) && next && next.time<end){
      entryPrice=next.open; entryTime=next.time
      qty=(cash*(1-fee))/entryPrice
      cash=0
    } else if(holding && i>=first && bar.close<low(c,i,config.exit) && next && next.time<end && next.time>entryTime){
      const proceeds=qty*next.open*(1-fee)
      if(proceeds>0) wins += proceeds > 0.25 ? 1 : 0
      cash=proceeds; qty=0; entryPrice=0; entryTime=0; trades++
    }
    equity.push(cash+qty*bar.close)
  }
  if(qty>0){
    const last=inWindow[inWindow.length-1]
    cash=qty*last.close*(1-fee); qty=0; trades++; endLiquidations++
    equity[equity.length-1]=cash
  }
  return {equity,trades,wins,endLiquidations}
}
function metrics(curve:number[],trades:number,wins:number,endLiquidations:number){
  let peak=curve[0]??0.25, maxDD=0
  for(const e of curve){peak=Math.max(peak,e);if(peak>0)maxDD=Math.max(maxDD,(peak-e)/peak)}
  return {initialCapital:1,finalEquity:curve.at(-1)??1,returnPct:((curve.at(-1)??1)-1)*100,maxDrawdownPct:maxDD*100,observations:curve.length,trades,winRate:trades?wins/trades:null,forcedEndLiquidations:endLiquidations}
}
async function main(){
  const now=new Date(), end=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1), start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-MONTHS,1)
  const data=new Map<string,Candle[]>(), coverage:any[]=[]
  for(const s of SYMBOLS){
    const c=await load(s,start,end), actual=c.filter(x=>x.time>=start&&x.time<end)
    const expected=(end-start)/3600000, times=new Set(actual.map(x=>x.time)); let missing=0
    for(let t=start;t<end;t+=3600000) if(!times.has(t)) missing++
    coverage.push({symbol:s,expected,actual:actual.length,missingHours:missing})
    if(actual.length<expected*.98||missing>expected*.02) throw new Error('Coverage failure '+s+': actual='+actual.length+' missing='+missing)
    data.set(s,c)
  }
  const folds=[['2025-10-01','2026-01-01'],['2026-01-01','2026-04-01'],['2026-04-01','2026-07-01'],['2026-07-01','2026-10-01']]
  const configs:Config[]=[{name:'donchian_20_10',entry:20,exit:10},{name:'donchian_55_20',entry:55,exit:20}]
  const strategies:any[]=[]
  for(const config of configs){
    const foldResults:any[]=[]
    for(let fi=0;fi<folds.length;fi++){
      const [a,b]=folds[fi], fs=Date.parse(a+'T00:00:00Z'), fe=Date.parse(b+'T00:00:00Z')
      const sensitivity:any[]=[]
      for(const cost of COSTS){
        const sleeves:SimResult[]=[]
        for(const s of SYMBOLS) sleeves.push(simulateSleeve(data.get(s)!,fs,fe,config,cost))
        const length=Math.min(...sleeves.map(x=>x.equity.length)), curve:number[]=[]
        for(let i=0;i<length;i++) curve.push(sleeves.reduce((sum,x)=>sum+x.equity[i],0))
        const trades=sleeves.reduce((n,x)=>n+x.trades,0), wins=sleeves.reduce((n,x)=>n+x.wins,0), forced=sleeves.reduce((n,x)=>n+x.endLiquidations,0)
        sensitivity.push({roundTripCostBps:cost,...metrics(curve,trades,wins,forced),perSymbol:SYMBOLS.map((symbol,i)=>({symbol,finalSleeveEquity:sleeves[i].equity.at(-1),trades:sleeves[i].trades,forcedEndLiquidations:sleeves[i].endLiquidations}))})
      }
      foldResults.push({fold:fi+1,testStart:a,testEnd:b,portfolio:sensitivity[0],costSensitivity:sensitivity})
      console.log('[portfolio] '+config.name+' fold '+(fi+1)+' return='+sensitivity[0].returnPct.toFixed(2)+'% maxDD='+sensitivity[0].maxDrawdownPct.toFixed(2)+'%')
    }
    strategies.push({ ...config,folds:foldResults,positiveOosFolds:foldResults.filter(f=>f.portfolio.returnPct>0).length,methodology:'Finite-capital spot portfolio, four equal 25% independent sleeves, no leverage. Each sleeve buys only with its own cash, charges half the round-trip cost on entry and half on exit, marks equity hourly and liquidates remaining exposure at the last in-window close with exit cost. Fixed parameters; chronological OOS quarters.'})
  }
  const report={reportName:'radar-crypto-donchian-portfolio-1h',generatedAt:new Date().toISOString(),startingPortfolioCapital:1,productionUntouched:true,notDeployable:true,coverage,methodology:{interval:'1h',symbols:SYMBOLS,folds,costsBpsRoundTrip:COSTS,allocation:'25% initial equity per symbol sleeve; idle cash remains in sleeve; no leverage or cross-sleeve borrowing.',metrics:'Hourly marked-to-market aggregate equity, return, max drawdown, trade count, and cost sensitivity. End-of-fold open positions liquidated at final in-window close and charged exit cost.',limitations:'Equal-sleeve portfolio proxy; ignores taxes, partial fills, spread variation, latency, exchange outages and market impact. Historical results are not a promise of future returns.'},strategies}
  await fs.mkdir('reports',{recursive:true}); await fs.writeFile('reports/backtest-donchian-portfolio-1h.json',JSON.stringify(report,null,2)+'\n')
  console.log('[portfolio] report saved: reports/backtest-donchian-portfolio-1h.json')
}
main().catch(e=>{console.error('[portfolio] fatal:',e);process.exit(1)})
