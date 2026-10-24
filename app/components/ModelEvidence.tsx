// Static summary of the 36-month backtest of v1.1-live. Source:
// docs/RESEARCH_AUDIT.md section 5 (2026-10-24). Update it when the model or
// the evaluation changes; the page must not claim more than this evidence.
const ROWS = [
  { horizon: '15 min', excess: '+0.002 %', net: '−0.196 %', wins: '24.7 %' },
  { horizon: '1 hora', excess: '+0.008 %', net: '−0.185 %', wins: '33.2 %' },
  { horizon: '4 horas', excess: '+0.033 %', net: '−0.138 %', wins: '40.4 %' },
]

const cell = { padding: '7px 8px', borderTop: '1px solid #172027', textAlign: 'right' as const }

export default function ModelEvidence() {
  return <div style={{ background: '#0c1014', border: '1px solid #3a2f1a', borderRadius: 16, padding: 14, marginBottom: 14 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
      <div style={{ color: '#64748b', fontSize: 10, fontWeight: 800, letterSpacing: '.12em' }}>EVIDENCIA DEL MODELO · v1.1</div>
      <div style={{ color: '#fbbf24', fontWeight: 900, fontSize: 13 }}>Sin ventaja medida</div>
    </div>
    <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.55, margin: '8px 0 10px' }}>
      Probado con 51 790 señales LONG en 36 meses (oct 2023 – sep 2026; BTC, ETH, SOL y XRP). Entrar cuando el radar marca LONG no rindió mejor que entrar al azar en la misma moneda, y con comisiones de 0.20 % ida y vuelta cada operación perdió en promedio.
    </p>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, color: '#cbd5e1' }}>
        <thead><tr style={{ color: '#64748b', fontSize: 9 }}>
          <th style={{ ...cell, borderTop: 'none', textAlign: 'left' }}>HORIZONTE</th>
          <th style={{ ...cell, borderTop: 'none' }}>FRENTE AL AZAR</th>
          <th style={{ ...cell, borderTop: 'none' }}>NETO TRAS COMISIONES</th>
          <th style={{ ...cell, borderTop: 'none' }}>OPERACIONES GANADORAS</th>
        </tr></thead>
        <tbody>{ROWS.map(row => <tr key={row.horizon}>
          <td style={{ ...cell, textAlign: 'left', fontWeight: 800 }}>{row.horizon}</td>
          <td style={cell}>{row.excess}</td>
          <td style={{ ...cell, color: '#fb7185', fontWeight: 800 }}>{row.net}</td>
          <td style={cell}>{row.wins}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div style={{ color: '#64748b', fontSize: 10, marginTop: 9, lineHeight: 1.5 }}>
      Ninguna diferencia frente al azar es estadísticamente significativa. El score describe indicadores técnicos: no es una probabilidad ni una recomendación de compra.
    </div>
  </div>
}
