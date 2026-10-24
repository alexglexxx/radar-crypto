# gate-v2 (operaciones de hasta 3 días con TP/SL) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un comando `run-gate-v2.mts` que evalúa candidatos de compra spot con salida TP +4 % / SL −4 % neto / 72 h contra el azar, en desarrollo (2023-10..2026-09) y en un examen único (2020-10..2023-09), con funding como dato nuevo.

**Architecture:** Cargadores verificados (spot con caídas compartidas toleradas, funding mensual) alimentan un `SwingContext`. `swing-gate.ts` precalcula, por moneda, la operación que resultaría de entrar en cada cierre de 4h, aplica la regla de una posición a las decisiones del candidato y compara con el azar mediante desplazamientos circulares por moneda. `swing-registry.ts` escribe ficha y registro y aplica las guardas de etapa. gate-v1 no cambia.

**Tech Stack:** TypeScript, Node 24, `tsx`, Vitest 3, `unzip` del sistema (ya usado por `binance-archive.ts`).

**Spec:** `docs/superpowers/specs/2026-10-24-gate-v2-swing-design.md` (aprobado por Alex el 2026-10-24, con la decisión de caídas del exchange en §3.1 y §4).

## Global Constraints

- gate-v1 queda intacto: `evaluation-gate.ts`, `run-gate.mts`, `gate-candidates.ts`, `tests/evaluation-gate.test.ts`, `registry.tsv` y sus fichas no cambian de comportamiento.
- Monedas: `SYMBOLS` de `live-baseline-core.ts` (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT). Solo spot largo.
- Decisión al cierre de cada vela de 4h UTC: vela `i` con `(openTime + 15 min) % 4 h === 0`. Instante de decisión `t = openTime + BAR_MS` (no `candleCloseTime`, que resta 1 ms).
- Entrada en `open` de la vela siguiente existente. TP `E × 1.042`, SL `E × 0.962`. Coste 0.002 (estrés 0.003); los niveles no cambian con el estrés.
- 72 h por reloj desde `openTime` de la vela de entrada. SL antes que TP en la misma vela. SL se llena en `min(SL, open_j)`.
- Caídas: hueco aceptado solo si idéntico en las 4 monedas y ≤ 24 velas; cualquier otro aborta.
- Visibilidad: velas con `openTime + BAR_MS ≤ t` y funding con `calcTime ≤ t`, como mucho 30 días (`openTime ≥ t − 30 d`, `calcTime > t − 30 d`).
- Pruebas y umbrales: `no-lookahead` 0 cambios en 200 decisiones por moneda; `sample` ≥ 200 operaciones; `beats-random` exceso > 0 y p < 0.05 (2000 desplazamientos, semilla `20261024`); `net-of-costs` media neta > 0 a 20 bps; `stable` exceso > 0 en 3 de 3 años; `breadth` exceso > 0 en ≥ 3 de 4 monedas.
- Etapas: desarrollo carga desde 2023-09, años 2023-10/2024-10/2025-10; examen carga desde 2020-09, años 2020-10/2021-10/2022-10. Máximo 20 estrategias en desarrollo, 3 en examen, un examen por candidato.
- Textos de ficha y checks en español; mensajes de error y comentarios de código en inglés, como el código existente.
- Tests: `npx vitest run --no-file-parallelism` (con paralelismo, tests pesados exceden 5 s en esta máquina).

## Review Focus

1. **Caída justo después de la decisión** (2021-04-25 04:15–08:30): la entrada es la primera vela tras la caída y las 72 h cuentan desde ahí; sin vela de entrada o de salida en datos cargados, no hay decisión. Test en Task 3.
2. **Funding que empieza a mitad de mes** (SOL desde 2020-09-13, `calc_time` con milisegundos de jitter como `1600012800004`): no es un hueco; el funding liquidado a las 00:00:00.004 no es visible en la decisión de las 00:00. Test en Task 2.
3. **Candidato que mira más de 30 días atrás** (lee `index − 2976`): debe caer en `no-lookahead`, no lanzar fuera del gate. Test en Task 4.
4. **Candidato que nunca compra** (un filtro demasiado estricto en datos reales): métricas `null`, veredicto RECHAZADO, ficha con "—" y fila de registro con campos vacíos; nada lanza ni produce `NaN`. Test en Task 4 (evaluación) y Task 5 (ficha y fila).
5. **Corrida repetida del mismo id con la definición cambiada** (mismo id, otro `decide`): el comando aborta antes de cargar datos y sin escribir nada. Test en Task 5.

---

### Task 1: Spot con caídas compartidas toleradas

**Files:**
- Modify: `scripts/research/historical-coverage.ts`
- Modify: `scripts/research/binance-archive.ts`
- Test: `tests/archive-outages.test.ts`

**Interfaces:**
- Produces:
  - `export type Outage = { from: string; to: string; bars: number }` (ISO de la primera y la última vela que faltan) en `historical-coverage.ts`.
  - `export function findOutages(candles: HistoricalCandle[], symbol: string, startMs: number, endMs: number, maxOutageBars: number): Outage[]` en `historical-coverage.ts`.
  - `export async function fetchArchiveZip(url: string, cacheFile: string, label: string): Promise<{ text: string; sha256: string; bytes: number }>` en `binance-archive.ts` (lee caché o descarga; 404 lanza `Binance archive unavailable for ${label}; refusing incomplete backtest`; descomprime con `unzip -p`).
  - `export async function loadArchivedCandlesWithOutages(symbol: string, startMs: number, endMs: number, { maxOutageBars, interval = '15m', cacheDir }: {...}): Promise<{ candles: Candle[]; manifest: ArchiveFile[]; outages: Outage[] }>`.

- [ ] **Step 1: Write the failing tests** in `tests/archive-outages.test.ts`, con velas sintéticas válidas en una rejilla de 300 velas desde 0:

```ts
it('reports a gap up to the limit as an outage', () => {
  const candles = grid(300).filter((_, i) => i < 100 || i >= 118)
  expect(findOutages(candles, 'BTCUSDT', 0, 300 * BAR_MS - 1, 24))
    .toEqual([{ from: new Date(100 * BAR_MS).toISOString(), to: new Date(117 * BAR_MS).toISOString(), bars: 18 }])
})
it('rejects a gap longer than the limit', () => {
  const candles = grid(300).filter((_, i) => i < 100 || i >= 125)
  expect(() => findOutages(candles, 'BTCUSDT', 0, 300 * BAR_MS - 1, 24)).toThrow(/25 candles/)
})
it('rejects a missing first or last candle', ...)   // grid(300).slice(1) y .slice(0, -1) → toThrow(/edge/)
it('rejects duplicates, off-grid times and invalid OHLCV', ...) // /duplicate|grid/ y /invalid/
it('keeps assertHistoricalCoverage strict', ...)    // el mismo hueco de 18 sigue lanzando /coverage/
```

- [ ] **Step 2: Run** `npx vitest run tests/archive-outages.test.ts` — Expected: FAIL, `findOutages` no existe.

- [ ] **Step 3: Implement** `findOutages` (mismas validaciones de OHLCV que `assertHistoricalCoverage`; orden estrictamente creciente sobre la rejilla de 15 min; agrupa huecos consecutivos; la primera y la última vela de la ventana deben existir). Extrae `fetchArchiveZip` de `readMonth` sin cambiar su comportamiento y añade `loadArchivedCandlesWithOutages`, que es `loadArchivedCandles` con `findOutages` en lugar de `assertHistoricalCoverage`. `loadArchivedCandles` no cambia.

- [ ] **Step 4: Run** `npx vitest run --no-file-parallelism tests/archive-outages.test.ts tests/research-audit.test.ts tests/historical-baseline.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Load spot archives that contain short exchange outages for gate-v2"`

### Task 2: Cargador de funding

**Files:**
- Create: `scripts/research/funding-archive.ts`
- Test: `tests/funding-archive.test.ts`

**Interfaces:**
- Consumes: `fetchArchiveZip`, `monthKeys`, `ArchiveFile` de `binance-archive.ts`.
- Produces:
  - `export type FundingPoint = { calcTime: number; intervalHours: number; rate: number }`
  - `export function parseFundingCsv(csv: string, label: string): FundingPoint[]` — encabezado opcional `calc_time,funding_interval_hours,last_funding_rate`; fila ilegible lanza `${label}: unparseable funding row N`.
  - `export function assertFundingContinuity(points: FundingPoint[], symbol: string): void` — ordenado y sin duplicados; hueco si `b.calcTime − a.calcTime > 1.5 × max(a.intervalHours, b.intervalHours) h`; lanza `${symbol}: N funding gaps, first after <ISO de a>`.
  - `export function fundingIndexAt(points: FundingPoint[], t: number): number` — índice del último punto con `calcTime ≤ t`, `−1` si no hay; búsqueda binaria.
  - `export async function loadArchivedFunding(symbol: string, startMs: number, endMs: number, { cacheDir = path.join(process.cwd(), '.backtest-cache') } = {}): Promise<{ points: FundingPoint[]; manifest: ArchiveFile[] }>` sobre `https://data.binance.vision/data/futures/um/monthly/fundingRate/<SYM>/<SYM>-fundingRate-<YYYY-MM>.zip`; filtra a `[startMs, endMs]` y llama a `assertFundingContinuity`.

- [ ] **Step 1: Write the failing tests** in `tests/funding-archive.test.ts`:

```ts
it('parses with and without header', ...)        // mismo resultado; '1704067200000,8,0.00037409' → { calcTime: 1704067200000, intervalHours: 8, rate: 0.00037409 }
it('rejects an unparseable row', ...)             // toThrow(/unparseable funding row 2/)
it('reports gaps with count and first date', ...) // 8h,8h,falta,falta,8h,falta,8h → toThrow(/2 funding gaps, first after 2024-01-01T08:00/)
it('accepts a switch from 8h to 4h settlements', ...) // 8h,8h,4h,4h,4h → no lanza; 4h,4h y luego 7h → lanza
it('accepts a series that starts mid-month with millisecond jitter', ...) // primer punto 1600012800004 → no lanza
it('never returns a settlement after t', ...)     // para cada t en una rejilla de 15 min sobre 3 días: idx === -1 || points[idx].calcTime <= t, e idx+1 fuera o > t
it('does not see a 00:00:00.004 settlement at the 00:00 decision', ...) // fundingIndexAt(points, 1600012800000) === -1
it('refuses a missing month', async () => {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
  await expect(loadArchivedFunding('BTCUSDT', Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1) - 1, { cacheDir: tmp }))
    .rejects.toThrow(/unavailable/)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/funding-archive.test.ts` — Expected: FAIL, módulo no encontrado.
- [ ] **Step 3: Implement** `funding-archive.ts` con las firmas de arriba.
- [ ] **Step 4: Run** `npx vitest run tests/funding-archive.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add the verified funding archive loader for gate-v2"`

### Task 3: Simulador de operación, tabla de operaciones y regla de una posición

**Files:**
- Create: `scripts/research/swing-gate.ts`
- Test: `tests/swing-gate.test.ts`

**Interfaces:**
- Consumes: `Candle` de `lib/features`, `BAR_MS` de `live-baseline-core.ts`, `FundingPoint` de Task 2.
- Produces (en `swing-gate.ts`):
  - `export type SwingRules` con exactamente los campos de `GATE_V2_RULES` (números salvo `version` y `execution`, que son `string`).
  - `export const GATE_V2_RULES: Readonly<SwingRules>` con `version: 'gate-v2'`, `decisionEveryMs: 4 h`, `takeProfit: 0.042`, `stopLoss: 0.038` (desplazamientos brutos sobre `E`), `maxHoldMs: 72 h`, `lookbackMs: 30 d`, `costRoundTrip: 0.002`, `stressCostRoundTrip: 0.003`, `alpha: 0.05`, `minTrades: 200`, `minPositiveAssets: 3`, `leakChecksPerAsset: 200`, `permutations: 2000`, `seed: 20261024`, `maxOutageBars: 24`, `maxDevCandidates: 20`, `maxExamCandidates: 3`, y `execution` (texto en español para la ficha).
  - `export type SwingContext = { candles: Map<string, Candle[]>; funding: Map<string, FundingPoint[]> }`
  - `export type SwingCandidate = { id: string; kind: 'strategy' | 'control'; hypothesis: string; decide(ctx: SwingContext, symbol: string, index: number): boolean }`
  - `export type SwingTrade = { decisionIndex: number; entryIndex: number; exitIndex: number; reason: 'tp' | 'sl' | 'time'; exitTime: number; hours: number; gross: number; net: number; netStress: number }`
  - `export const decisionTime = (c: Candle) => c.openTime + BAR_MS`
  - `export function simulateTrade(candles: Candle[], i: number, rules?: SwingRules): SwingTrade | null` — `null` si no existen la vela `i+1` o una vela con `openTime ≥ entryOpen + 72 h`. `exitTime`: TP/SL → `openTime_j + BAR_MS`; tiempo → `openTime` de la vela de salida. `hours = (exitTime − entryOpen) / 3.6e6`.
  - `export type TradeTable = { trades: SwingTrade[]; times: number[]; nextFree: number[] }` — una entrada por vela de decisión con `periodStart ≤ t < periodEnd` y operación no nula; `nextFree[k]` es el primer `k' > k` con `times[k'] ≥ trades[k].exitTime` (o `trades.length`).
  - `export function buildTradeTable(candles: Candle[], periodStart: number, periodEnd: number, rules?: SwingRules): TradeTable`
  - `export function applyOnePosition(selected: boolean[], nextFree: number[]): number[]` — recorre `k`; si `selected[k]`, toma `k` y salta a `nextFree[k]`.

- [ ] **Step 1: Write the failing tests** in `tests/swing-gate.test.ts` (`flat(n)` = velas planas a 100 desde 00:00 UTC; las variaciones se insertan en la vela indicada):

```ts
describe('simulateTrade', () => {
  it('exits at TP for +4 % net', ...)              // high 104.2 en i+5 → reason 'tp', net ≈ 0.04, netStress ≈ 0.039
  it('exits at SL for −4 % net', ...)              // low 96.2 en i+5 → 'sl', net ≈ -0.04
  it('counts SL when one candle touches both', ...) // high 105, low 95 en la misma vela → 'sl'
  it('fills a gap down at the open', ...)          // open 90 en i+5 → 'sl', net ≈ -0.102
  it('times out at the open of i+289', ...)        // planas → 'time', exitIndex i+289, hours 72
  it('enters after an outage that starts right after the decision', ...)
    // quitar velas i+1..i+18: entryIndex apunta a la vela de openTime_i + 19 × BAR_MS; salida a 72 h de esa apertura
  it('counts 72 h by clock across an outage inside the trade', ...) // quitar 18 velas a mitad: salida en openTime_entry + 72 h
  it('returns null without an exit candle', ...)   // i a menos de 289 velas del final → null
})
describe('trade table', () => {
  it('decides only at 4h closes inside the period', ...) // times todos % 4h === 0 y en [periodStart, periodEnd)
  it('lets a time exit re-enter at the exit close', ...)   // planas: nextFree[k] === k + 18
  it('applies one position per coin', () => {
    expect(applyOnePosition([true, true, false, true], [2, 2, 3, 4])).toEqual([0, 3])
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/swing-gate.test.ts` — Expected: FAIL, módulo no encontrado.
- [ ] **Step 3: Implement** las firmas de arriba en `swing-gate.ts`. `simulateTrade` usa `E × (1 + takeProfit)` y `E × (1 − stopLoss)`; `gross = (salida − E) / E`; `net = gross − costRoundTrip`; `netStress = gross − stressCostRoundTrip`.
- [ ] **Step 4: Run** `npx vitest run tests/swing-gate.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Simulate gate-v2 trades with TP/SL by clock and one position per coin"`

### Task 4: Evaluación, valor p y controles

**Files:**
- Modify: `scripts/research/swing-gate.ts`
- Create: `scripts/research/swing-candidates.ts`
- Test: `tests/swing-gate.test.ts`

**Interfaces:**
- Consumes: todo lo de Task 3; `mean` de `live-baseline-core.ts`; `pct` y `Check` de `evaluation-gate.ts`.
- Produces:
  - `export function definitionHash(candidate: SwingCandidate): string` — primeros 12 hex de SHA-256 de `hypothesis + decide.toString()`.
  - `export type SwingStage = 'desarrollo' | 'examen'`
  - `export type SwingResult = { candidate: { id; kind; hypothesis; definition: string }; stage: SwingStage; rules: SwingRules; verdict: 'APRUEBA DESARROLLO' | 'CANDIDATO A PAPEL' | 'RECHAZADO'; checks: Check[]; metrics: { decisions: number; trades: number; leak_checks: number; leak_divergences: number; mean_net: number | null; baseline_net: number | null; excess: number | null; p_outperformance: number | null; net_cost: number | null; net_stress_cost: number | null; tp_rate: number | null; sl_rate: number | null; timeout_rate: number | null; mean_hours: number | null; random: { tp_rate: number; sl_rate: number; timeout_rate: number; mean_hours: number }; by_asset: { symbol: string; trades: number; excess: number | null; tp_rate: number | null }[]; by_year: { from: string; to: string; trades: number; excess: number | null }[] } }`
  - `export function evaluateSwingCandidate(candidate: SwingCandidate, ctx: SwingContext, opts: { stage: SwingStage; periodStart: number; periodEnd: number; yearStarts: number[]; rules?: SwingRules }): SwingResult`
  - `export function windowContext(ctx: SwingContext, index: number, rules?: SwingRules): { ctx: SwingContext; index: number }` — corta las 4 series a `[t − lookbackMs, t]` según Global Constraints y traduce el índice.
  - `export const SWING_CANDIDATES: Record<string, SwingCandidate>` en `swing-candidates.ts` con `swing-random`, `swing-lookahead`, `swing-btc-lookahead`.

- [ ] **Step 1: Write the failing tests** (añadir a `tests/swing-gate.test.ts`). Mercado sintético: 4 monedas, 2880 + 400 × 96 velas desde una medianoche UTC, paseo aleatorio ±0.2 % por vela con semilla por moneda; con `planted`, cada 192 velas, en una vela de decisión, volumen ×10 seguido de +0.2 % por vela durante 32 velas. `RULES = { ...GATE_V2_RULES, permutations: 300, leakChecksPerAsset: 50 }`; periodo desde la vela 2880 hasta el final; `yearStarts` en los tercios del periodo. `spike` = estrategia `volume[i] > 5 × volume[i−1]`.

```ts
it('approves a planted, past-only edge', ...)      // verdict 'APRUEBA DESARROLLO', ningún check falla, tp_rate > 0.9, trades >= 200
it('gives CANDIDATO A PAPEL for the same edge in examen', ...)
it('rejects swing-random', ...)                    // RECHAZADO; beats-random falla; no-lookahead pasa
it('catches swing-lookahead', ...)                 // excess > 0; no-lookahead falla; RECHAZADO
it('catches swing-btc-lookahead', ...)             // no-lookahead falla
it('catches a candidate that reads more than 30 days back', ...)
  // decide: (ctx, s, i) => ctx.candles.get(s)![i - 2976].close > 0 → no-lookahead falla, evaluate no lanza
it('finds no edge for the spike without the plant', ...) // RECHAZADO
it('rejects a candidate that never buys without throwing', ...)
  // decide: () => false → RECHAZADO; trades 0; excess, p_outperformance, mean_net y tp_rate null; sample falla
it('rejects assets on different grids', ...)       // quitar una vela solo en ETH → toThrow(/identical time grid/)
it('keeps the same hash for the same definition', ...) // definitionHash estable y distinto si cambia decide
```

- [ ] **Step 2: Run** `npx vitest run --no-file-parallelism tests/swing-gate.test.ts` — Expected: FAIL en los tests nuevos.
- [ ] **Step 3: Implement** `evaluateSwingCandidate`:
  - Exige rejilla idéntica en las 4 monedas (`Assets need an identical time grid`).
  - Tabla de operaciones por moneda (Task 3). Azar de la moneda = media de `net` de su tabla.
  - `no-lookahead`: hasta `leakChecksPerAsset` decisiones repartidas por moneda; compara `decide` sobre el contexto completo con `decide` sobre `windowContext`; un `throw` cuenta como distinto.
  - Decisiones del candidato en cada entrada de la tabla (un `throw` aquí aborta), luego `applyOnePosition`.
  - `excess` = media de `net` de las operaciones tomadas − media del azar de su moneda por operación.
  - Valor p, algoritmo no determinado por las firmas:

```ts
// Each coin is shifted on its own, then the one-position rule is reapplied:
// the null keeps how often and how clustered the candidate buys, not when.
for (let it = 0; it < rules.permutations; it++) {
  let sum = 0, base = 0, count = 0
  for (const symbol of symbols) {
    const sel = selected.get(symbol)!, n = sel.length
    const shift = 1 + Math.floor(next() * (n - 1))
    const shifted = sel.map((_, k) => sel[(k - shift + n) % n])
    for (const k of applyOnePosition(shifted, tables.get(symbol)!.nextFree)) {
      sum += tables.get(symbol)!.trades[k].net; base += baseline.get(symbol)!; count++
    }
  }
  if (count > 0 && (sum - base) / count >= observedExcess) upper++
}
p = (upper + 1) / (rules.permutations + 1)
```
  con el mismo xorshift de `circularPValue` sembrado con `rules.seed`.
  - Años: cada operación pertenece al año de su decisión; se compara con el azar de su moneda dentro de ese año.
  - Checks con ids y exigencias de Global Constraints; etiqueta de `no-lookahead`: `No mira el futuro (ni más de 30 días atrás)`.
  - Controles en `swing-candidates.ts`: `swing-random` compra si un hash determinista de `openTime` y símbolo es < 0.15; `swing-lookahead` compra si `simulateTrade(candles, index)?.reason === 'tp'`; `swing-btc-lookahead` compra si `BTC[index + 96].close > BTC[index].close`. Hipótesis en español que digan qué deben producir.
- [ ] **Step 4: Run** `npx vitest run --no-file-parallelism tests/swing-gate.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Evaluate gate-v2 candidates against random entries with per-coin circular shifts"`

### Task 5: Ficha, registro y guardas de etapa

**Files:**
- Create: `scripts/research/swing-registry.ts`
- Test: `tests/swing-registry.test.ts`

**Interfaces:**
- Consumes: `SwingResult`, `SwingCandidate`, `SwingStage`, `definitionHash`, `GATE_V2_RULES`; `Outage`.
- Produces:
  - `export const STAGES: Record<SwingStage, { loadFrom: string; periodFrom: string; periodTo: string; years: string[] }>` = desarrollo `2023-09`/`2023-10`/`2026-09`/`['2023-10','2024-10','2025-10']`; examen `2020-09`/`2020-10`/`2023-09`/`['2020-10','2021-10','2022-10']`.
  - `export type SwingContextInfo = { period: string; commit: string; generatedAt: string; data: string; outages: Outage[] }`
  - `export const REGISTRY_V2_HEADER` con las columnas `date candidate kind stage rules period commit definition verdict trades excess p_outperformance net_cost tp_rate sl_rate timeout_rate leak_divergences` (tabuladas).
  - `export type RegistryV2Row` (un campo por columna, todos `string`) y `export function parseRegistryV2(tsv: string): RegistryV2Row[]`.
  - `export function swingRegistryRow(result: SwingResult, info: SwingContextInfo): string`
  - `export function renderSwingFiche(result: SwingResult, info: SwingContextInfo): string`
  - `export function assertStageAllowed(input: { stage: SwingStage; candidates: SwingCandidate[]; registry: RegistryV2Row[]; dirty: boolean; rules?: SwingRules }): void`

- [ ] **Step 1: Write the failing tests** in `tests/swing-registry.test.ts`:

```ts
it('rejects a registered id with another definition', ...)       // fila con id 'm1' y otra huella → toThrow(/another definition/)
it('rejects the 21st development strategy', ...)                 // 20 ids distintos registrados + 1 nuevo → toThrow(/20/); controles no cuentan
it('allows rerunning a registered strategy in development', ...) // mismo id y huella → no lanza
it('rejects examen with uncommitted changes', ...)               // dirty: true → toThrow(/uncommitted/)
it('rejects examen without an approved last development run', ...) // última fila de desarrollo con la huella: RECHAZADO → lanza
it('rejects a second examen of the same candidate', ...)
it('rejects a fourth examined candidate', ...)
it('round-trips a registry row', ...)    // parseRegistryV2(HEADER + '\n' + swingRegistryRow(...)) devuelve candidate, stage, definition, verdict
it('writes a fiche and a row for a candidate that never buys', ...) // ficha con '—', fila sin 'NaN' ni 'null'
it('writes a fiche with every check, TP/SL rates and outages', ...)
  // contiene '**Veredicto: APRUEBA DESARROLLO**', las 6 etiquetas como '| <label> |', 'Tasa de TP', y la fecha de cada caída
```

- [ ] **Step 2: Run** `npx vitest run tests/swing-registry.test.ts` — Expected: FAIL, módulo no encontrado.
- [ ] **Step 3: Implement** `swing-registry.ts`. Ficha con la estructura de `renderFiche` de gate-v1: título, veredicto (aviso si es control), idea, etapa y periodo, reglas, commit y huella; tabla de pruebas; frase de cierre según veredicto (desarrollo aprobado: "Puede pasar al examen único sobre años nunca mirados."; examen aprobado: "Siguiente paso: seguimiento en papel con datos nuevos antes de cualquier uso real."; rechazado: "No se usa para operar ni se ajusta mirando estos mismos datos."); tabla candidato frente al azar (tasa de TP, SL, tiempo, horas medias); por moneda; por año; caídas aceptadas ("Ninguna" si no hay); "Cómo se mide" con `rules.execution`.
- [ ] **Step 4: Run** `npx vitest run tests/swing-registry.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Write gate-v2 fiches and registry rows and enforce the stage limits"`

### Task 6: Comando `run-gate-v2.mts`, documentación y controles sobre datos reales

**Files:**
- Create: `scripts/research/run-gate-v2.mts`
- Modify: `docs/evaluation/README.md` (sección nueva "Reglas `gate-v2`", sin tocar la de gate-v1)
- Create (salida): `docs/evaluation/registry-v2.tsv`, `docs/evaluation/fichas/<fecha>-desarrollo-<control>.md`

**Interfaces:**
- Consumes: `loadArchivedCandlesWithOutages`, `loadArchivedFunding`, `evaluateSwingCandidate`, `SWING_CANDIDATES`, todo `swing-registry.ts`.

- [ ] **Step 1: Implement** `run-gate-v2.mts` con el patrón de `run-gate.mts`:
  1. Acepta solo `--stage=desarrollo|examen` y `--candidates=a,b` (ambos obligatorios; cualquier otro argumento lanza). Ids desconocidos lanzan con la lista conocida.
  2. Lee `docs/evaluation/registry-v2.tsv` (lo crea con el encabezado si falta), calcula `dirty` con `git status --porcelain -- scripts lib` y llama a `assertStageAllowed` **antes** de cargar datos.
  3. Carga spot de las 4 monedas desde `loadFrom` hasta el fin de `periodTo` con `maxOutageBars` de las reglas; aborta si las listas de caídas difieren entre monedas. Carga funding del mismo rango.
  4. Por candidato: evalúa con `periodStart`/`periodEnd`/`yearStarts` de `STAGES`; escribe `reports/gate-v2/<etapa>-<id>.json` (resultado, info, manifiestos de spot y funding), la ficha y la fila del registro; imprime una línea por candidato y una por prueba como `run-gate.mts`.
- [ ] **Step 2: Escribe la sección gate-v2** del README: tabla de pruebas, etapas y límites, caídas aceptadas, controles, uso (`npx tsx scripts/research/run-gate-v2.mts --stage=desarrollo --candidates=swing-random,swing-lookahead,swing-btc-lookahead`) y salidas.
- [ ] **Step 3: Verifica todo** — `npx vitest run --no-file-parallelism`, `npm run typecheck`, `npm run lint`, `npm run verify:engine`. Expected: todo pasa; los tests de gate-v1 siguen sin cambios.
- [ ] **Step 4: Commit** el código y el README — `git commit -m "Add the gate-v2 command and document its rules"`
- [ ] **Step 5: Corre los controles en desarrollo:** `npx tsx scripts/research/run-gate-v2.mts --stage=desarrollo --candidates=swing-random,swing-lookahead,swing-btc-lookahead`. Expected: 0 caídas en desarrollo; los tres RECHAZADO; `swing-lookahead` y `swing-btc-lookahead` fallan `no-lookahead`; `swing-random` pasa `no-lookahead` y falla `beats-random`. Si un control no sale como se espera, el gate está mal: parar y diagnosticar antes de seguir.
- [ ] **Step 6: Commit** registro y fichas — `git commit -m "Run gate-v2 controls on development: all rejected as expected"`

### Task 7: Memoria ALE

**Files:**
- Modify: `D:\proyectos\alexglexxx\alex-legacy-engine\projects\radar-crypto\current-state.md`, `action-plan.md`, `decisions.md`, `lessons-learned.md`; `PROJECT_STATE.md`; `HANDOFF.md` regenerado con el script existente.

- [ ] **Step 1:** Entrada nueva en `current-state.md` con commits, resultado de los controles (tasas de TP/SL del azar por moneda), validaciones y siguiente paso: Alex fija el primer lote de candidatos (ideas M1–F3 del spec) antes de correrlos.
- [ ] **Step 2:** `decisions.md`: gate-v2 y la regla de caídas compartidas ≤ 6 h. `lessons-learned.md`: los archivos de Binance de 2020-2023 tienen caídas del exchange; un cargador que exige rejilla completa no puede usar esos años.
- [ ] **Step 3:** Actualiza `PROJECT_STATE.md`, regenera `HANDOFF.md` con el script del repo ALE y corre la auditoría de memoria y sus tests (`node --test tests/`). Expected: pasan.
