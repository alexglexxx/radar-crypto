'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)

type Signal = {
  symbol: string
  price: number
  score: number
  change_24h: number | null
  volume: number | null
  status: string
  created_at: string
}

const statusMeta: Record<string, { label: string; tone: string; bg: string }> = {
  'SETUP LONG': { label: 'SETUP LONG', tone: '#34d399', bg: 'rgba(52,211,153,.12)' },
  VIGILAR: { label: 'VIGILAR', tone: '#fbbf24', bg: 'rgba(251,191,36,.12)' },
  NEUTRAL: { label: 'NEUTRAL', tone: '#94a3b8', bg: 'rgba(148,163,184,.10)' },
  EVITAR: { label: 'EVITAR', tone: '#fb7185', bg: 'rgba(251,113,133,.12)' },
}

function fmtPrice(value: number) {
  if (!Number.isFinite(value)) return '—'
  return value >= 1000
    ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function scoreColor(score: number) {
  if (score >= 75) return '#34d399'
  if (score >= 60) return '#fbbf24'
  if (score >= 45) return '#94a3b8'
  return '#fb7185'
}

function MiniSpark({ values }: { values: number[] }) {
  if (values.length < 2) return <div style={{ height: 72 }} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100
    const y = 64 - ((v - min) / range) * 52
    return `${x},${y}`
  }).join(' ')
  const rising = values[values.length - 1] >= values[0]
  const stroke = rising ? '#34d399' : '#fb7185'
  return (
    <svg viewBox="0 0 100 70" preserveAspectRatio="none" width="100%" height="72" aria-label="price history">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default function Page() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [selected, setSelected] = useState('BTCUSDT')
  const [history, setHistory] = useState<Signal[]>([])
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  async function loadSignals() {
    const { data } = await supabase
      .from('signals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(120)

    if (!data) return
    const latest: Record<string, Signal> = {}
    data.forEach((row: Signal) => {
      if (!latest[row.symbol]) latest[row.symbol] = row
    })
    const rows = Object.values(latest)
    setSignals(rows)
    if (!rows.some((row) => row.symbol === selected) && rows[0]) setSelected(rows[0].symbol)
    setUpdatedAt(rows[0]?.created_at ?? null)
    setLoading(false)
  }

  async function loadHistory(symbol: string) {
    const { data } = await supabase
      .from('signals')
      .select('*')
      .eq('symbol', symbol)
      .order('created_at', { ascending: false })
      .limit(24)
    if (data) setHistory(data.reverse())
  }

  useEffect(() => {
    loadSignals()
    const timer = window.setInterval(loadSignals, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    loadHistory(selected)
  }, [selected])

  const current = signals.find((row) => row.symbol === selected) ?? signals[0]
  const score = Number(current?.score ?? 0)
  const meta = statusMeta[current?.status] ?? statusMeta.NEUTRAL
  const previousScore = history.length > 1 ? Number(history[history.length - 2]?.score ?? score) : score
  const scoreDelta = score - previousScore
  const priceValues = useMemo(() => history.map((row) => Number(row.price)).filter(Number.isFinite), [history])

  const freshness = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <main style={{ minHeight: '100vh', background: '#07090b', color: '#f8fafc', fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '18px 14px 40px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 11, height: 11, borderRadius: 999, background: '#34d399', boxShadow: '0 0 16px rgba(52,211,153,.65)' }} />
              <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-.04em' }}>RADAR</div>
              <div style={{ fontSize: 20, fontWeight: 500, color: '#64748b', letterSpacing: '-.04em' }}>CRYPTO</div>
            </div>
            <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>MERCADO EN VIVO · 15M</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 10, color: '#64748b' }}>
            <div style={{ color: '#34d399', fontWeight: 800 }}>● LIVE</div>
            <div>actualizado {freshness}</div>
          </div>
        </header>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8, marginBottom: 14 }}>
          {signals.map((row) => {
            const active = row.symbol === selected
            const color = scoreColor(Number(row.score))
            return (
              <button key={row.symbol} onClick={() => setSelected(row.symbol)} style={{ textAlign: 'left', border: active ? `1px solid ${color}` : '1px solid #1e293b', background: active ? '#10161a' : '#0c1014', color: '#fff', borderRadius: 14, padding: 11, cursor: 'pointer', boxShadow: active ? `0 0 0 1px ${color}22` : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 850, fontSize: 12 }}>{row.symbol.replace('USDT', '')}</span>
                  <span style={{ color, fontWeight: 900, fontSize: 15 }}>{row.score}</span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>${fmtPrice(Number(row.price))}</div>
              </button>
            )
          })}
        </section>

        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>Cargando radar…</div>
        ) : current ? (
          <>
            <section style={{ display: 'grid', gridTemplateColumns: '1.45fr .8fr', gap: 12, marginBottom: 12 }}>
              <div style={{ background: 'linear-gradient(145deg,#10161a,#090c0f)', border: '1px solid #1e293b', borderRadius: 20, padding: 18, overflow: 'hidden', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, letterSpacing: '.12em' }}>SEÑAL TÉCNICA</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 5 }}>
                      <span style={{ fontSize: 25, fontWeight: 900 }}>{current.symbol.replace('USDT', '')}</span>
                      <span style={{ color: '#94a3b8', fontSize: 12 }}>USDT</span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-.04em', marginTop: 4 }}>${fmtPrice(Number(current.price))}</div>
                    <div style={{ marginTop: 7, color: current.change_24h == null ? '#64748b' : current.change_24h >= 0 ? '#34d399' : '#fb7185', fontWeight: 800, fontSize: 12 }}>
                      {current.change_24h == null ? '24H —' : `24H ${current.change_24h >= 0 ? '+' : ''}${Number(current.change_24h).toFixed(2)}%`}
                    </div>
                  </div>
                  <div style={{ minWidth: 130, textAlign: 'center' }}>
                    <div style={{ width: 116, height: 116, margin: '0 auto', borderRadius: 999, display: 'grid', placeItems: 'center', background: `conic-gradient(${scoreColor(score)} ${score * 3.6}deg,#172027 0deg)`, boxShadow: `0 0 35px ${scoreColor(score)}18` }}>
                      <div style={{ width: 91, height: 91, borderRadius: 999, background: '#090c0f', display: 'grid', placeItems: 'center' }}>
                        <div><div style={{ fontSize: 31, fontWeight: 950, lineHeight: 1 }}>{score}</div><div style={{ color: '#64748b', fontSize: 9, marginTop: 4 }}>SCORE</div></div>
                      </div>
                    </div>
                    <div style={{ marginTop: 9, display: 'inline-block', padding: '6px 10px', borderRadius: 999, background: meta.bg, color: meta.tone, fontWeight: 900, fontSize: 10, letterSpacing: '.05em' }}>{meta.label}</div>
                  </div>
                </div>
                <div style={{ marginTop: 18, borderTop: '1px solid #172027', paddingTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', fontSize: 9, marginBottom: 3 }}><span>ÚLTIMAS 6H</span><span>{scoreDelta === 0 ? 'score estable' : `score ${scoreDelta > 0 ? '+' : ''}${scoreDelta} en última lectura`}</span></div>
                  <MiniSpark values={priceValues} />
                </div>
              </div>

              <div style={{ background: '#0c1014', border: '1px solid #1e293b', borderRadius: 20, padding: 16 }}>
                <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, letterSpacing: '.12em' }}>LECTURA</div>
                <div style={{ fontSize: 17, fontWeight: 900, marginTop: 7 }}>{score >= 75 ? 'Confluencia alcista' : score >= 60 ? 'Condiciones interesantes' : score >= 45 ? 'Sin ventaja clara' : 'Estructura débil'}</div>
                <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.55, margin: '9px 0 15px' }}>
                  El score resume condiciones técnicas. No es una predicción ni una orden automática. La señal gana valor cuando varias lecturas independientes coinciden.
                </p>
                <div style={{ display: 'grid', gap: 7 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 10px', borderRadius: 10, background: '#10161a' }}><span style={{ color: '#64748b', fontSize: 10 }}>Momentum</span><span style={{ fontWeight: 800, fontSize: 10 }}>MULTI-TF</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 10px', borderRadius: 10, background: '#10161a' }}><span style={{ color: '#64748b', fontSize: 10 }}>Participación</span><span style={{ fontWeight: 800, fontSize: 10 }}>VOLUMEN</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 10px', borderRadius: 10, background: '#10161a' }}><span style={{ color: '#64748b', fontSize: 10 }}>Confirmación</span><span style={{ fontWeight: 800, fontSize: 10 }}>RSI · MACD</span></div>
                </div>
              </div>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              <div style={{ background: '#0c1014', border: '1px solid #1e293b', borderRadius: 14, padding: 13 }}><div style={{ color: '#64748b', fontSize: 9 }}>CAMBIO 24H</div><div style={{ fontSize: 18, fontWeight: 900, marginTop: 5 }}>{current.change_24h == null ? '—' : `${current.change_24h >= 0 ? '+' : ''}${Number(current.change_24h).toFixed(2)}%`}</div></div>
              <div style={{ background: '#0c1014', border: '1px solid #1e293b', borderRadius: 14, padding: 13 }}><div style={{ color: '#64748b', fontSize: 9 }}>VOLUMEN</div><div style={{ fontSize: 18, fontWeight: 900, marginTop: 5 }}>{current.volume == null ? '—' : Number(current.volume).toLocaleString('en-US', { maximumFractionDigits: 0 })}</div></div>
              <div style={{ background: '#0c1014', border: '1px solid #1e293b', borderRadius: 14, padding: 13 }}><div style={{ color: '#64748b', fontSize: 9 }}>LECTURAS</div><div style={{ fontSize: 18, fontWeight: 900, marginTop: 5 }}>{history.length || '—'} <span style={{ color: '#64748b', fontSize: 10, fontWeight: 600 }}>muestras</span></div></div>
            </section>
          </>
        ) : (
          <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>Sin señales disponibles todavía.</div>
        )}

        <footer style={{ marginTop: 18, color: '#475569', fontSize: 9, textAlign: 'center' }}>
          Radar experimental · datos de mercado + motor técnico · actualización automática cada 60s
        </footer>
      </div>
      <style>{`@media(max-width:720px){section{grid-template-columns:1fr !important}.main-card{grid-template-columns:1fr !important}}`}</style>
    </main>
  )
}
