import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
type Candle = { time: number; open: number; high: number; low: number; close: number }
type Point = { time: number; equity: number }
const SYMBOLS = ['BTCUSDT', 'ETHUSDT']
const COSTS_BPS = [15, 20, 25]
const INTERVAL = '1d'
const CACHE = path.join(process.cwd(), '.research-cache-btc-eth')
const START = Date.UTC(2022, 0, 1)
const END = Date.UTC(2026, 9, 1)
const DAY = 86400000

async function loadSymbol(symbol: string): Promise<Candle[]> {
  const months: string[] = []
  const d = new Date(START); d.setUTCDate(1)
  const e = new Date(END); e.setUTCDate(1)
  while (d < e) { months.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0')); d.setUTCMonth(d.getUTCMonth()+1) }
  const out: Candle[] = []
  for (const month of months) {
    const file = path.join(CACHE, symbol + '-' + month + '.zip')
    try { await fs.access(file) } catch {
      const url = 'https://data.binance.vision/data/spot/monthly/klines/' + symbol + '/' + INTERVAL + '/' + symbol + '-' + INTERVAL + '-' + month + '.zip'
      const res = await fetch(url)
      if (res.status === 404) continue
      if (!res.ok) throw new Error('Binance HTTP ' + res.status + ': ' + url)
      await fs.mkdir(CACHE, {recursive:true}); await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
    }
    const dir = path.join(CACHE, 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.mkdir(dir,{recursive:true})
    try {
      await exec('unzip',['-oq',file,'-d',dir])
      const csv = (await fs.readdir(dir)).find(x=>x.endsWith('.csv'))
      if (!csv) throw new Error('CSV missing: '+file)
      const lines=(await fs.readFile(path.join(dir,csv),'utf8')).trim().split(/\r?\n/)
      const offset=lines[0]?.toLowerCase().includes('open time')?1:0
      for(let i=offset;i<lines.length;i++){
        const a=lines[i].split(','); if(a.length<6) continue
        const raw=Number(a[0]), time=raw>1e14?Math.floor(raw/1000):raw
        const [open,high,low,close]=a.slice(1,5).map(Number)
        if([time,open,high,low,close].every(Number.isFinite)&&open>0&&high>0&&low>0&&close>0&&time>=START&&time<END) out.push({time,open,high,low,close})
      }
    } finally { await fs.rm(dir,{recursive:true,force:true}) }
  }
  const map=new Map(out.map(c=>[c.time,c]))
  return [...map.values()].sort((a,b)=>a.time-b.time)
}
function sma(c:Candle[],i:number,n:number){let s=0;for(let j=i-n+1;j<=i;j++)s+=c[j].close;return s/n}
function std(c:Candle[],i:number,n:number,mean:number){let s=0;for(let j=i-n+1;j<=i;j++)s+=(c[j].close-mean)**2;return Math.sqrt(s/n)}
type Sim={curve:Point[];trades:number;exposure:number;final:number;returnPct:number;maxDDPct:number}
function summarize(curve:Point[],trades:number,exposure:number):Sim{
  let peak=curve[0]?.equity??1,dd=0
  for(const p of curve){peak=Math.max(peak,p.equity);if(peak>0)dd=Math.max(dd,(peak-p.equity)/peak)}
  const final=curve.at(-1)?.equity??1
  return {curve,trades,exposure:curve.length?exposure/curve.length:0,final,returnPct:(final-1)*100,maxDDPct:dd*100}
}
// Signals calculated at daily close and executed at the next daily open. Equity is marked at close.
function simulate(c:Candle[],start:number,end:number,costBps:number,kind:'trend'|'reversion'|'buy_hold'):Sim{
  const fee=costBps/10000
  let cash=1,qty=0,position=false,trades=0,exposure=0
  const curve:Point[]=[]
  for(let i=0;i<c.length;i++){
    const bar=c[i],next=c[i+1]
    if(bar.time<start||bar.time>=end) continue
    const ready=i>=200
    const mean20=i>=19?sma(c,i,20):0
    let desired=position
    if(kind==='buy_hold') desired=true
    else if(kind==='trend') desired=ready && bar.close>sma(c,i,200) && bar.close/sma(c,i-50,50)-1>0
    else if(kind==='reversion'){
      const sd=i>=19?std(c,i,20,mean20):0
      if(!position) desired=ready && bar.close>sma(c,i,200) && bar.close<mean20-2*sd
      else desired=!(bar.close< sma(c,i,200) || bar.close>=mean20)
    }
    curve.push({time:bar.time,equity:cash+qty*bar.close})
    exposure+=position?1:0
    if(!next||next.time>=end||next.time!==bar.time+DAY) continue
    if(!position&&desired){
      qty=(cash*(1-fee))/next.open; cash=0; position=true; trades++
    }else if(position&&!desired){
      cash=qty*next.open*(1-fee);qty=0;position=false
    }
  }
  if(position){
    const last=c.filter(x=>x.time>=start&&x.time<end).at(-1)
    if(last){cash=qty*last.close*(1-fee);qty=0;position=false; if(curve.length)curve[curve.length-1].equity=cash}
  }
  return summarize(curve,trades,exposure)
}
async function main(){
  const data=new Map<string,Candle[]>(),coverage:any[]=[]
  for(const symbol of SYMBOLS){
    const c=await loadSymbol(symbol), test=c.filter(x=>x.time>=Date.UTC(2023,9,1)&&x.time<END)
    const expected=(END-Date.UTC(2023,9,1))/DAY, times=new Set(test.map(x=>x.time))
    let missing=0;for(let t=Date.UTC(2023,9,1);t<END;t+=DAY)if(!times.has(t))missing++
    coverage.push({symbol,expected,actual:test.length,missingDays:missing})
    if(test.length<expected*.98||missing>expected*.02)throw new Error('Daily coverage failure '+symbol+' missing='+missing)
    data.set(symbol,c)
  }
  const folds=[['2023-10-01','2024-04-01'],['2024-04-01','2024-10-01'],['2024-10-01','2025-04-01'],['2025-04-01','2025-10-01'],['2025-10-01','2026-04-01'],['2026-04-01','2026-10-01']]
  const strategies:any[]=[]
  for(const kind of ['trend','reversion','buy_hold'] as const){
    const foldResults:any[]=[]
    for(let fi=0;fi<folds.length;fi++){
      const start=Date.parse(folds[fi][0]+'T00:00:00Z'),end=Date.parse(folds[fi][1]+'T00:00:00Z')
      const costs:any[]=[]
      for(const cost of COSTS_BPS){
        const sims=SYMBOLS.map(s=>simulate(data.get(s)!,start,end,cost,kind))
        const n=Math.min(...sims.map(x=>x.curve.length)),curve:Point[]=[]
        for(let i=0;i<n;i++)curve.push({time:sims[0].curve[i].time,equity:sims.reduce((a,x)=>a+x.curve[i].equity/SYMBOLS.length,0)})
        const m=summarize(curve,sims.reduce((a,x)=>a+x.trades,0),sims.reduce((a,x)=>a+x.exposure,0)/SYMBOLS.length)
        costs.push({roundTripCostBps:cost,returnPct:m.returnPct,maxDrawdownPct:m.maxDDPct,trades:m.trades,exposurePct:m.exposure*100,finalEquity:m.final,perSymbol:SYMBOLS.map((s,i)=>({symbol:s,returnPct:sims[i].returnPct,maxDrawdownPct:sims[i].maxDDPct,trades:sims[i].trades,exposurePct:sims[i].exposure*100}))})
      }
      foldResults.push({fold:fi+1,start:folds[fi][0],end:folds[fi][1],base:costs[0],costSensitivity:costs})
      console.log('[btc-eth] '+kind+' '+folds[fi][0]+' return='+costs[0].returnPct.toFixed(2)+'% DD='+costs[0].maxDrawdownPct.toFixed(2)+'% trades='+costs[0].trades)
    }
    strategies.push({name:kind,description:kind==='trend'?'Long only when close is above SMA200 and 50-day momentum is positive; signal close, next-open execution.':kind==='reversion'?'Long only in long-term uptrend when close is more than 2 rolling 20-day standard deviations below SMA20; exit at SMA20 or below SMA200.':'Equal-weight buy-and-hold benchmark, with entry cost at first executable open and liquidation cost at fold end.',folds:foldResults,positiveFolds:foldResults.filter(f=>f.base.returnPct>0).length})
  }
  const report={name:'BTC ETH daily regime vs reversion research',generatedAt:new Date().toISOString(),symbols:SYMBOLS,interval:INTERVAL,coverage,folds,productionUntouched:true,notApprovedForLiveTrading:true,methodology:{capital:'Each asset starts with 50% of portfolio equity, isolated sleeves, no leverage.',costs:'Round-trip cost sensitivity 15/20/25 bps, charged half on entry and half on exit.',execution:'Signals at daily close, fills at next daily open. No entry if next bar crosses fold boundary; open positions liquidated at final in-fold close.',validation:'Six fixed chronological six-month OOS folds; rules fixed in advance, no parameter optimization. Benchmark is equal-weight buy-and-hold.',limitations:'Does not include taxes, market impact, spread changes, outages, or intra-day drawdown. This is research, not a live trading recommendation.'},strategies}
  await fs.mkdir('reports',{recursive:true});await fs.writeFile('reports/btc-eth-daily-research.json',JSON.stringify(report,null,2)+'\n')
  console.log('[btc-eth] saved reports/btc-eth-daily-research.json')
}
main().catch(e=>{console.error('[btc-eth] fatal',e);process.exit(1)})
