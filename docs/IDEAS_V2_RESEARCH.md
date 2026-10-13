# Ideas v2 — banco de pruebas de estrategias (rama de investigación)

Rama: `research/strategy-ideas-v2`. **No modifica** `lib/`, `app/`, `supabase/`, `package.json` ni ningún archivo existente:
todo el código nuevo vive en `scripts/research/ideas/`. `v1.1-live` sigue congelado (ver `STRATEGY_RESEARCH_POLICY.md`).

## Qué prueba

| # | Idea | Módulo | Plazo |
|---|------|--------|-------|
| 0 | Referencia: score de producción tal cual (≥ 75, salida a 4 h) | `s0_baseline_score_15m` | 15m |
| 1 | El mismo score, manteniendo la posición más tiempo (4 h a 48 h) | `s1_score_horizon_15m` | 15m |
| 2 | Filtro de régimen: operar solo en tendencia (score y Donchian) | `s2_score_regime_15m`, `s3r_*` | 15m / 1h / 4h |
| 3 | Ruptura de rango Donchian + volumen + stop que sube (ATR) | `s3_donchian_*` | 1h / 4h |
| 4 | Fuerza relativa: tener solo la moneda más fuerte (o efectivo) | `s4_relative_strength_4h` | 4h |
| 5 | Marea de BTC: las alts solo compran si BTC está en tendencia | `s5_donchian_btc_tide_*` | 1h / 4h |
| 6 | Funding: ignorar rupturas cuando el mercado está sobrecargado a la compra | `s6_donchian_funding_*` | 1h / 4h |
| 7 | Reversión a la media solo en mercado lateral | `s7_meanrev_sideways_*` | 1h / 4h |
| 8 | Salidas definidas para el score actual (stop, objetivo, stop que sube) | `s8_score_exits_15m` | 15m |

Pendiente (no incluido): *interés abierto* de futuros (idea 6 completa). Sus archivos diarios de `data.binance.vision` son pesados y se dejan para una segunda iteración.

## Protocolo (igual para todas)

- Datos: velas cerradas de Binance spot (`data.binance.vision`), BTC/ETH/SOL/XRP, 36 meses + 3 de calentamiento. Se rechaza cualquier hueco o vela inválida.
- Una señal se calcula al **cierre** de la vela `i` y se ejecuta en la **apertura** de la vela `i+1`. Nada mira hacia adelante (hay una prueba automática que lo comprueba para cada estrategia).
- Stops antes que objetivos dentro de la misma vela; un hueco que cruza el stop se ejecuta a la apertura; los stops que suben solo usan máximos pasados.
- Costos ida y vuelta: 10 / **20** (principal) / **30** (estrés) puntos base.
- Walk-forward: 12 meses de entrenamiento → 3 meses fuera de muestra, avanzando de 3 en 3. Los parámetros se eligen **solo** con entrenamiento (mayor estadístico *t* de la ganancia neta, con mínimo de operaciones y ganancia positiva). Si ninguno cumple, la estrategia **se abstiene** ese periodo.
- Las posiciones abiertas al final de una ventana se cierran a la apertura siguiente (no se descartan).
- Comparaciones: (a) "siempre dentro" con la misma salida (¿la señal de entrada aporta algo?), (b) comprar y mantener.

## Cuándo una idea queda como *candidata*

Todas deben cumplirse (fuera de muestra, operaciones reunidas):

1. Al menos 100 operaciones.
2. Ganancia media neta > 0 a 20 bps **y** a 30 bps.
3. Límite inferior del intervalo de confianza (bootstrap, corregido por el número de estrategias probadas) > 0.
4. Al menos 60 % de los periodos fuera de muestra positivos.
5. Mejor que "siempre dentro" con la misma salida.

*Candidata* **no** significa rentable: significa que merece una segunda validación con otros datos y ejecución real. *No calificada* es un resultado válido.

## Cómo correrlo

```bash
npm install
npx vitest run scripts/research/ideas          # pruebas del sistema (sin datos externos)
npx tsx scripts/research/ideas/run-ideas.ts     # datos reales (necesita acceso a data.binance.vision)
```

Variables: `MONTHS` (36), `TIMEFRAMES` (`15m,1h,4h`), `ONLY` (prefijos de id, p. ej. `s3_,s5_`), `SYMBOLS`, `REPORT_DIR`.
Verificación del propio sistema: `SYNTHETIC=random` (no debe calificar nada) y `SYNTHETIC=trend` (una estrategia de tendencia sí debe ganar).

En GitHub: *Actions → Radar strategy ideas v2 (research) → Run workflow*. El resumen aparece en la página de la corrida y los JSON en el artefacto.

## Limitaciones conocidas

- El cargador de funding (`futures/um/monthly/fundingRate`) está probado con texto de ejemplo, **no** con archivos reales descargados. Si falla, esas estrategias se marcan `skipped` sin detener las demás.
- Las operaciones de distintos símbolos están correlacionadas; el intervalo de confianza las trata como independientes y es optimista.
- Los 36 meses incluyen un solo ciclo de mercado. 7 u 8 periodos fuera de muestra siguen siendo pocos.
