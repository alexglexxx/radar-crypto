# Diseño: gate-v2 para operaciones de hasta 3 días con TP/SL

Fecha: 2026-10-24 · Estado: aprobado por Alex el 2026-10-24 · Rama: `work/security-baseline-audit-20261021`

## 1. Propósito

Alex quiere buscar una ventaja real: comprar y vender en un periodo corto, cubrir comisiones y apuntar a 3-5 % neto por operación. Las sesiones 3 y 4 mostraron que las señales de 15m-4h sobre los indicadores del radar no cubren el coste de 0.20 % (la mejor dio +0.12 % bruto a 4h). Este diseño cambia el tipo de operación (hasta 3 días, salida por TP/SL), añade una fuente de datos nueva (funding de perpetuos) y amplía la historia para tener un examen limpio.

**Éxito:** una señal que llega al TP antes que al SL con más frecuencia que una entrada al azar con el mismo esquema, en la misma moneda y periodo, que gana neto de comisiones y es estable por año y por moneda, primero en desarrollo y después en un examen único sobre años nunca mirados. Pasar da derecho a seguimiento en papel, no a operar.

### Decisiones de Alex (2026-10-24)

- Objetivo: buscar ventaja real (no panel de contexto).
- Familias de ideas: horizontes largos, y funding y derivados.
- Muestra: más historia con las mismas 4 monedas (BTC, ETH, SOL, XRP).
- Operación: comprar y luego vender, apuntando a 3-5 % neto. Máximo 3 días abierta.
- Salida única para todos los candidatos: TP +4 % neto / SL −4 % neto.
- Enfoque A: desarrollo en 2023-10..2026-09 (ya mirado) y examen único en 2020-10..2023-09 (nunca mirado).
- Open interest y ratios long/short solo si un candidato declarado los necesita.

### Supuestos (confirmados al aprobar el diseño)

- Solo spot largo. "Vender" es cerrar la compra; funding se usa como dato, no se operan futuros.
- Una posición abierta por moneda a la vez. Costes de ida y vuelta 20 bps, estrés 30 bps.

## 2. Por qué estas reglas (evidencia previa)

Medición exploratoria (2023-10..2026-09, entradas al azar cada 4h, apertura siguiente, 20 bps; script desechable, no versionado):

- Mediana de tiempo hasta +3 % neto: BTC 3.3 días, ETH 1.9, SOL 1.2, XRP 2.1. Hasta +5 %: 6.3 / 3.9 / 2.4 / 4.0 días. Un objetivo de 3-5 % exige días, no horas.
- TP +4 % / SL −4 % en 3 días al azar: TP 27-43 %, SL 28-48 %, media neta −0.06 % (BTC, ETH) a −0.37 % (XRP). El esquema de salida no crea ventaja; la señal tiene que subir la tasa de TP sobre el azar.
- Con TP y SL iguales, cubrir costes exige acertar ~53 % de las operaciones resueltas; el azar da ~49 %.

Cobertura de datos verificada por HTTP el 2026-10-24 en `data.binance.vision`: funding mensual desde 2020-01 (BTC, ETH, XRP) y 2020-09 (SOL); spot 15m de SOL desde 2020-08 (mes incompleto); métricas diarias de open interest existen al menos desde 2020-10-01. Ninguna rama de investigación ejecutó análisis sobre 2020-10..2023-09 (`docs/RESEARCH_BRANCHES.md`: la única rama con datos de 2022, `btc-eth-regime-vs-reversion`, nunca llegó a correr).

## 3. Reglas `gate-v2`

`gate-v1` no cambia: su código, tests, fichas y `registry.tsv` quedan como están. `gate-v2` es una versión nueva con sus reglas escritas antes de correr cualquier candidato.

### 3.1 Ejecución

- **Momento de decisión:** cierre de cada vela de 4h UTC (00, 04, 08, 12, 16, 20), es decir la vela de 15m `i` cuyo `openTime + 15m` es múltiplo de 4h.
- **Entrada:** apertura de la vela `i+1`, precio `E`.
- **Niveles**, definidos con el coste base de 20 bps: TP en `E × 1.042` (+4 % neto), SL en `E × 0.962` (−4 % neto).
- **Recorrido:** las 72 h se cuentan por reloj desde la apertura de la vela de entrada, no por número de velas. Se recorren las velas `j ≥ i+1` con `openTime_j < openTime_{i+1} + 72 h` (sin huecos, `j = i+1 … i+288`). En cada vela se mira primero el SL y después el TP: si `low ≤ SL` sale por SL; si no, si `high ≥ TP` sale por TP. Si una misma vela toca los dos, cuenta el SL.
- **Precio de salida:** TP se llena en el nivel TP. SL se llena en `min(SL, open_j)`: un hueco a la baja, incluido el de una caída del exchange, se paga completo.
- **Tiempo:** si no tocó ninguno, sale en la apertura de la primera vela con `openTime ≥ openTime_{i+1} + 72 h` (sin huecos, `i+289`).
- **Caídas del exchange:** si falta la vela de 4h, en ese momento no hay decisión. Si la caída empieza justo después de la decisión, se entra en la apertura de la primera vela que vuelve a existir, como pasaría en la realidad.
- **Retorno neto:** `(salida − E) / E − coste`. Con estrés se resta 30 bps en lugar de 20; los niveles no cambian.
- **Una posición por moneda:** tras entrar en `i`, la siguiente decisión válida es el primer cierre de 4h en o después del cierre de la vela de salida. Las señales intermedias se ignoran.
- **Cola reservada:** una decisión solo cuenta si la vela de entrada y la de salida por tiempo existen en los datos cargados (sin huecos: las últimas 289 velas del periodo no generan decisiones).

### 3.2 Comparación con el azar

- **Tabla de operaciones:** para cada momento de decisión de cada moneda se calcula una vez la operación que resultaría de entrar ahí (índice de salida, motivo, retorno neto).
- **Azar de la moneda:** media de esa tabla en todos los momentos de decisión de la moneda y del periodo (sin regla de una posición).
- **Exceso:** media neta de las operaciones del candidato menos la media del azar de las monedas correspondientes, ponderada por operación como en gate-v1.
- **Valor p:** 2000 desplazamientos circulares independientes por moneda de la secuencia booleana de decisiones del candidato; en cada desplazamiento se vuelve a aplicar la regla de una posición sobre la tabla precalculada. `p = (desplazamientos con exceso ≥ observado + 1) / (2000 + 1)`, unilateral. Semilla fija `20261024`.

### 3.3 Pruebas

| Id | Prueba | Exigido |
| --- | --- | --- |
| `no-lookahead` | No mira el futuro (ni más de 30 días atrás) | 0 cambios en 200 momentos de decisión por moneda al dejar **todas** las series solo con lo publicado en los 30 días que terminan en el instante de la decisión |
| `sample` | Muestra | ≥ 200 operaciones en el periodo |
| `beats-random` | Le gana al azar | Exceso > 0 y p < 0.05 |
| `net-of-costs` | Gana después de comisiones | Media neta > 0 con 20 bps (se informa 30 bps) |
| `stable` | Estable | Exceso > 0 en cada uno de los 3 años del periodo |
| `breadth` | Amplitud | Exceso > 0 en ≥ 3 de 4 monedas |

Cada año se compara con el azar de la misma moneda dentro de ese año. La ficha informa además la tasa de TP, SL y salida por tiempo, la duración media y lo mismo para el azar.

**Límite de potencia.** Con retornos de ±4 % la desviación por operación ronda 4 %. Con 200 operaciones el gate solo distingue del azar excesos de ~0.7 % por operación o más (p < 0.05 unilateral, potencia 80 %). Una ventaja menor no se verá. El objetivo de 3-5 % por operación ya supone una ventaja de ese tamaño.

### 3.4 Etapas

| Etapa | Periodo de decisiones | Años | Carga de datos | Corridas |
| --- | --- | --- | --- | --- |
| `desarrollo` | 2023-10 .. 2026-09 | 2023-10..2024-09, 2024-10..2025-09, 2025-10..2026-09 | desde 2023-09 | ilimitadas, todas registradas |
| `examen` | 2020-10 .. 2023-09 | 2020-10..2021-09, 2021-10..2022-09, 2022-10..2023-09 | desde 2020-09 | una por candidato |

- El mes anterior al periodo es calentamiento: **ningún candidato puede mirar más de 30 días hacia atrás.** Las decisiones empiezan con el primer cierre de 4h del periodo (00:00 UTC del primer día), y `no-lookahead` corta el contexto también por delante para comprobarlo.
- El periodo lo fija la etapa; el comando no acepta otro.
- **Tope de desarrollo:** como máximo 20 candidatos de estrategia distintos bajo `gate-v2` en desarrollo. Los controles no cuentan. El comando rechaza el número 21.
- **Huella de definición:** cada corrida registra `definition`, los primeros 12 caracteres del SHA-256 de `hypothesis` + `decide.toString()`. Cambiar la definición de un candidato exige un id nuevo; el comando aborta si un id ya registrado aparece con otra huella.
- **Paso a examen:** solo candidatos cuya última corrida de desarrollo, con la misma huella, aprobó todas las pruebas, y como máximo 3 candidatos en total.
- **Examen:** el comando se niega si hay cambios sin commit en `scripts/` o `lib/`, si el candidato ya tiene una fila de examen en `registry-v2.tsv`, o si ya hay 3 candidatos examinados. La fila se escribe pase lo que pase.
- **Veredictos:** en desarrollo, `APRUEBA DESARROLLO` o `RECHAZADO`; en examen, `CANDIDATO A PAPEL` o `RECHAZADO`.
- Si ningún candidato aprueba desarrollo, el examen no se gasta y la decisión vuelve a Alex.

## 4. Datos

- **Spot 15m:** `scripts/research/binance-archive.ts` sin cambios de comportamiento para gate-v1 (SHA-256 por archivo, aborta si falta un mes o hay velas inválidas, caché `.backtest-cache`). Los 4 activos deben compartir la misma rejilla de tiempo.
- **Caídas del exchange (decisión de Alex, 2026-10-24):** el examen tiene 10 caídas de Binance que faltan a la vez en las 4 monedas (93 velas; la mayor, 18 velas el 2021-04-25 y el 2021-08-13). Desarrollo no tiene ninguna. gate-v2 acepta un hueco solo si es idéntico en las 4 monedas y dura ≤ 24 velas (6 h); cualquier otro hueco aborta. La ficha lista las caídas aceptadas. Se contaron solo marcas de tiempo, sin leer precios del examen.
- **Funding:** cargador nuevo `scripts/research/funding-archive.ts` sobre `futures/um/monthly/fundingRate/<SYM>/<SYM>-fundingRate-<YYYY-MM>.zip`, con las mismas garantías y manifiesto. Columnas: `calc_time`, `funding_interval_hours`, `last_funding_rate`. Aborta si falta un mes o si entre dos liquidaciones hay más de 1.5 × `funding_interval_hours` (informa cuántos huecos). Respeta los cambios de intervalo (8h a 4h).
- **Visibilidad:** en la decisión de la vela `i` (cierre `t`), un candidato ve las velas con cierre ≤ `t` de las 4 monedas y las liquidaciones de funding con `calc_time ≤ t`. El archivo solo trae funding liquidado, no el estimado en tiempo real.
- **Open interest / long-short:** fuera de este diseño. Si un candidato los necesita, se añaden con su propio cargador y verificación de huecos.

## 5. Candidatos

### 5.1 Interfaz

```ts
type SwingContext = {
  candles: Map<string, Candle[]>      // 15m, mismas 4 monedas, rejilla común
  funding: Map<string, FundingPoint[]> // ordenado por calc_time
}
type SwingCandidate = {
  id: string
  kind: 'strategy' | 'control'
  hypothesis: string
  // Decisión al cierre de candles[symbol][index]. Solo puede leer datos con cierre ≤ ese instante.
  decide(ctx: SwingContext, symbol: string, index: number): boolean
}
```

La prueba `no-lookahead` llama a `decide` con el contexto completo y con un contexto cortado en el instante de la decisión (velas de las 4 monedas y funding) y exige la misma respuesta. Un `throw` cuenta como respuesta distinta.

### 5.2 Ideas iniciales para desarrollo

Puntos de partida, no compromisos. Todas solo compran.

- **M1, ruptura de N días:** el cierre de 4h supera el máximo de los últimos 10 o 20 días.
- **M2, momentum con marea de BTC:** retorno de 7 días de la moneda > 0 y BTC sobre su media de 20 días.
- **F1, funding extremo negativo:** el último funding está en el 10 % más bajo de los últimos 30 días de esa moneda.
- **F2, capitulación:** funding en su 10 % más bajo de 30 días y caída > X % en 3 días; X se fija al declarar el candidato.
- **F3, tendencia sin euforia:** M1 solo si el funding no está en su 30 % más alto de 30 días.

Cada variante (por ejemplo M1 con 10 y con 20 días) es un candidato distinto y cuenta para el tope de 20.

### 5.3 Controles

- `swing-random`: compra al azar en ~15 % de los momentos de decisión. Debe salir rechazado.
- `swing-lookahead`: compra solo si la operación tocará el TP antes que el SL. Debe caer en `no-lookahead`.
- `swing-btc-lookahead`: decide sobre cada moneda mirando el precio futuro de BTC. Debe caer en `no-lookahead`.
- En tests, una ventaja sembrada en datos sintéticos que solo usa el pasado debe aprobar.

## 6. Componentes

| Archivo | Responsabilidad |
| --- | --- |
| `scripts/research/funding-archive.ts` | Descargar, verificar y cachear funding mensual; consulta "último funding conocido en `t`" |
| `scripts/research/swing-gate.ts` | Reglas `GATE_V2_RULES`, simulador de operación TP/SL/tiempo, tabla de operaciones, regla de una posición, valor p, `evaluateSwingCandidate`, ficha y fila de registro |
| `scripts/research/swing-candidates.ts` | Candidatos y controles de gate-v2 |
| `scripts/research/run-gate-v2.mts` | CLI: `--stage=desarrollo|examen --candidates=a,b`; carga datos, aplica las guardas de etapa, escribe salidas |
| `tests/swing-gate.test.ts` | Simulador, controles, guardas |
| `tests/funding-archive.test.ts` | Lectura, huecos, consulta sin futuro |
| `docs/evaluation/README.md` | Sección nueva gate-v2 |

Reutiliza de `live-baseline-core.ts` y `evaluation-gate.ts` lo que encaje (`mean`, formato `pct`) sin cambiar su comportamiento. Si `circularPValue` no admite la regla de una posición, `swing-gate.ts` tiene su propia versión.

## 7. Salidas

- Ficha `docs/evaluation/fichas/<fecha>-<etapa>-<candidato>.md` en español: veredicto, etapa, pruebas, tasas de TP/SL/tiempo frente al azar, por moneda, por año.
- Registro nuevo `docs/evaluation/registry-v2.tsv`, una fila por corrida, sin borrar filas. Columnas: `date candidate kind stage rules period commit definition verdict trades excess p_outperformance net_cost tp_rate sl_rate timeout_rate leak_divergences`.
- `reports/gate-v2/<etapa>-<candidato>.json` (no versionado) con detalle y manifiestos de spot y funding.

## 8. Errores

- Mes faltante, fila ilegible, rejilla distinta entre monedas o hueco que no es una caída compartida de ≤ 24 velas: aborta antes de evaluar.
- Hueco de funding: aborta con el número de huecos y la primera fecha afectada.
- Guardas de etapa incumplidas: aborta sin escribir ficha ni registro, con el motivo.
- Un candidato que lanza error en la evaluación principal aborta la corrida (en la prueba de futuro cuenta como respuesta distinta).

## 9. Pruebas

- **Simulador:** TP, SL, ambos en la misma vela (SL), hueco a la baja en el SL, salida por tiempo en `i+289`, coste base y de estrés, señales ignoradas con posición abierta, siguiente decisión tras la salida.
- **Funding:** CSV con y sin encabezado, mes faltante, hueco mayor de 1.5 intervalos, cambio de intervalo 8h a 4h, consulta en `t` que nunca devuelve `calc_time > t`.
- **Gate:** ventaja sembrada aprueba; `swing-random` rechazado; `swing-lookahead` y `swing-btc-lookahead` caen en `no-lookahead`; la ventaja sembrada sobre datos sin ventaja sale rechazada.
- **Guardas:** id existente con otra huella rechazado, segundo examen rechazado, árbol con cambios rechazado, candidato sin desarrollo aprobado rechazado, candidato 21 rechazado, cuarto examen rechazado.
- **No regresión:** los tests de gate-v1 pasan sin cambios; `npm test` sin paralelismo, typecheck, lint y `verify:engine`.

## 10. Fuera de alcance

Cambios en el dashboard, en producción o en `v1.1-live`; lado corto o futuros; open interest y ratios long/short; órdenes maker; seguimiento en papel (`v1.2-shadow`), que tendrá su propio diseño si un candidato aprueba el examen.
