# Radar Crypto: checkpoint de investigación (2026-10-21)

`v1.1-live` y la lógica de producción siguen congeladas. Esta auditoría trabaja en la rama local `work/security-baseline-audit-20261021`; la migración de permisos está preparada, sin aplicar a producción.

## 1. Acceso a datos

La comprobación anterior que atribuía lectura anónima a las cuatro tablas usó por error una variable `NEXT_PUBLIC_SUPABASE_ANON_KEY` que contenía un JWT `service_role`. Con una clave realmente publicable, `market_snapshots`, `features` y `signal_outcomes` devuelven 401. `radar_signals` permite leer once columnas por grants de columna y una política permisiva; `current_signals_public` devuelve los cuatro activos. Se corrigió la variable local ignorada por Git y se añadió un guard de `predev`/`prebuild` que rechaza claves privilegiadas en variables públicas.

`supabase/migrations/20261021200000_lock_down_research_access.sql` elimina el acceso directo y cambia la vista delimitada a `security_invoker=false`, propiedad de `postgres`, con proyección explícita y filtro de siete días para `v1.1-live`. Esto permite mantener la vista pública sin grants de la tabla base. Requiere validación en una base aislada y revisión antes de aplicarse a producción. Una vez aplicada, ejecutar:

```powershell
node scripts/audit-public-access.mjs --expect-locked
```

Debe mostrar 401/403 en las cuatro tablas de investigación y en los cuatro objetos heredados (sección 4), y una fila visible de `current_signals_public` por activo. Antes de la migración falla correctamente en `radar_signals`, `signals`, `radar_public_metrics` y `public_signal_history`. Repetir la comprobación de la página pública después de aplicar la migración. No registrar ni imprimir claves.

## 2. Baseline reproducible

Ventana fija: cierres de vela de 15 minutos desde `2026-09-30T00:14:59.999Z` hasta `2026-10-21T15:59:59.999Z`. Se exigen 2 097 velas contiguas por BTCUSDT, ETHUSDT, SOLUSDT y XRPUSDT, incluidas 17 velas adicionales para una salida en la apertura siguiente a 4h. Faltantes, duplicados, timestamps fuera de rejilla u OHLCV inválidos detienen el informe. El reporte guarda hashes SHA-256 de las entradas de la ventana y del código de auditoría; contiene agregados, no filas privadas. Requiere `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` solo en entorno de servidor.

```powershell
npx tsx scripts/research/live-baseline.mts --from=2026-09-30T00:14:59.999Z --to=2026-10-21T15:59:59.999Z --permutations=5000 --seed=20261021
```

Genera `reports/live-baseline-audit.json` (ignorado por Git). La muestra tiene 629 LONG y cero diferencias entre outcomes guardados y retornos de cierre recalculados. Las entradas aleatorias usan el mismo activo y la misma ventana, ponderadas por el número de señales de cada activo. El valor p procede de desplazamientos circulares compartidos entre activos para conservar clusters y co-movimiento. Es una comprobación exploratoria en una ventana corta, no una estimación fuera de muestra.

| Horizonte | Episodios sin solape | Exceso medio cierre frente a baseline | p bilateral | Retorno medio entrada/salida en apertura siguiente, neto 20 bps |
| --- | ---: | ---: | ---: | ---: |
| 15m | 327 | -0.0253% | 0.0818 | -0.2276% |
| 1h | 192 | -0.0775% | 0.0910 | -0.2867% |
| 4h | 108 | -0.0242% | 0.8738 | -0.2634% |

Los costes de 20 y 30 bps son escenarios supuestos de ida y vuelta; la columna muestra 20 bps. No hay evidencia de ventaja neta en esta muestra. No son órdenes ejecutadas ni incluyen restricciones de liquidez.

Los scripts históricos `backtest.ts` y `backtest-baseline.ts` ahora rechazan archivos mensuales faltantes y series con huecos, duplicados u OHLCV inválidos antes de emitir métricas. Los archivos mensuales de Binance no cubren el mes en curso, así que una corrida histórica de 36 meses hasta el presente fallará hasta que se integre una fuente completa para el mes actual o se cierre la ventana en un mes archivado. No se publican métricas parciales como si fueran completas.

## 3. Anticipación, historial y ejecución

La prueba de prefijos compara el resultado de `replayLiveSignal` con archivo completo y con solo el prefijo disponible en cada punto. Muestrea cada 16 velas y todas las LONG desde la vela 250; 959 comparaciones entre los cuatro activos dieron cero diferencias. Un evaluador artificial que lee la última vela futura sí falla el control. La prueba cubre esos puntos y la ruta de señales live, no todos los posibles cambios futuros del código.

Comparar el historial creciente con la ventana limitada del motor produjo cambios de features en los 959 puntos, un cambio de score y una decisión LONG diferente en BTC; los otros activos no cambiaron decisión en los puntos probados. El informe JSON incluye conteos por activo y fechas de primera/última observación. La evaluación con entrada a cierre coincide con los outcomes guardados; la evaluación alternativa entra en la apertura siguiente y sale en una apertura posterior. La apertura siguiente más costes evita tratar el cierre que genera la señal como un precio ejecutable garantizado.

## 4. Validación aislada de la migración (2026-10-23)

**Estado de producción leído (solo SELECT sobre catálogos y HEAD con clave publicable).** Producción contiene objetos que ninguna migración del repositorio crea:

| Objeto | Filas | Acceso con clave publicable | Riesgo |
| --- | ---: | --- | --- |
| `signals` (tabla heredada, 2026-09-23 a 09-25, sin uso en el código) | 888 | lectura (206); política `Allow all` para `public` y grants INSERT/UPDATE/DELETE a `anon` | **escritura y borrado anónimos** |
| `radar_public_metrics` (2026-09-30 a 10-01, solo la usa `public_current_signals`) | 148 | lectura (206) | exposición de métricas |
| `public_signal_history` (vista, últimas 96 señales) | 96 | lectura (206) | expone `radar_signals` por columnas |
| `public_current_signals` (vista) | — | 401 (falta grant de columnas `rsi_14`…) | ninguno hoy |
| `radar_signals` | — | lectura de 11 columnas (206) | el hallazgo original |

Además, las vistas públicas tienen todos los grants por defecto de Supabase (INSERT/UPDATE/DELETE incluidos), las políticas `public read *` de la fase 1 ya no existen en producción pero sí al reproducir el repositorio, y el historial de migraciones difiere: producción registra `create_news_intelligence` (sin archivo aquí), no registra la fase 1 y usa otras versiones (`20261002…`). La migración debe aplicarse como SQL revisado, no con `supabase db push`.

**Cambio en la migración.** Además de lo descrito en la sección 1: elimina las políticas `public read *` de la fase 1 y la `Allow all` de `signals`; revoca todo a `public`/`anon`/`authenticated` en los cuatro objetos heredados (guardas `to_regclass` para entornos nuevos; no borra filas); deja las vistas de noticias en solo SELECT. Termina con un guard general: si `anon` o `authenticated` pueden leer algo fuera de la lista permitida (`current_signals_public`, vistas y tablas de noticias) o escribir en cualquier relación de `public`, la migración aborta completa. Una tabla creada después de esta auditoría con los grants por defecto la hará fallar, que es el comportamiento buscado. El comentario anterior según el cual `REVOKE` de tabla no quita grants de columna era falso (comprobado); el revoke por columna queda como no-op documentado.

**Prueba aislada.** `tests/migration-access.test.ts` levanta un Postgres en memoria (PGlite 0.5.8, Postgres 18) con los roles y privilegios por defecto de Supabase, aplica todas las migraciones del repositorio, reproduce la deriva de producción anterior y siembra datos. Seis pruebas:

1. Antes: el conjunto de políticas coincide con producción; `anon` lee `radar_signals` y `public_signal_history` e inserta/borra en `signals`.
2. Después: `anon` y `authenticated` reciben `permission denied` al leer las ocho relaciones privadas, al escribir en `signals` y al escribir a través de `current_signals_public`; las filas de `signals` se conservan.
3. La consulta exacta del dashboard sobre `current_signals_public` devuelve las 11 columnas y solo la señal `v1.1-live` de los últimos 7 días; las vistas de noticias siguen legibles.
4. `service_role` sigue insertando snapshots, features, señales, outcomes y noticias.
5. Reaplicar es idempotente; con una tabla desconocida expuesta la migración aborta y el estado previo queda intacto (atómica).
6. `supabase/rollback/20261021200000_lock_down_research_access.down.sql` restaura solo la ruta anterior del dashboard sin reabrir `signals`; reaplicar la migración vuelve a cerrar.

Controles de mutación: quitar el bloque heredado y el guard hace fallar las pruebas 2, 5 y 6; conservar los grants de escritura de la vista hace fallar al menos 2 y 3 (el guard aborta la migración). Límites: PGlite no es PostgREST ni la plataforma Supabase (no prueba códigos HTTP, JWT ni `pg_graphql`) y usa Postgres 18 frente a 17.6 en producción.

**Aplicada en producción el 2026-10-24 ~00:38 UTC**, con autorización de Alex, que la ejecutó en el SQL Editor de Supabase. Por eso no aparece en `supabase_migrations.schema_migrations`. Verificación:
- Catálogo: solo quedan las políticas de noticias; `current_signals_public` tiene `security_invoker=false, security_barrier=true`. `anon` conserva únicamente SELECT sobre `current_signals_public`, las dos vistas de noticias, `news_briefings` y `news_items`. `signals` (888 filas) y `radar_public_metrics` (148) siguen intactas.
- `audit-public-access.mjs --expect-locked`: código 0. Los 8 objetos privados responden 401 y la vista muestra las 4 monedas.
- Dashboard revisado por Alex: "4/4 activos al día" y un historial distinto por moneda.
- El cron de las 00:45 escribió las señales de los 4 activos con `service_role`; 0 outcomes pendientes.
- Los logs de Vercel no devolvieron registros (403 por MCP y 0 por CLI), así que el código HTTP del cron no quedó confirmado por esa vía.

**Procedimiento seguido.** 1) Ejecutar el SQL de la migración en producción como una sola transacción. 2) `node scripts/audit-public-access.mjs --expect-locked` debe salir con código 0. 3) Abrir `radar-crypto.vercel.app`: "4/4 activos al día" e historial visible. 4) Esperar una ejecución del cron (HTTP 200) y comprobar outcomes pendientes = 0. Si el dashboard falla, aplicar el rollback y repetir los pasos 2 y 3.

## 5. Backtest histórico con ventana live (tareas 3 y 4)

**Registrado antes de ejecutar (2026-10-24).** Ventana: 36 meses completos, de 2023-10 a 2026-09. Reserva: 2023-10 a 2024-09. Ningún análisis previo por tramo de score cubrió ese periodo: la atribución de `production-score-walkforward` empieza en 2024-10.

- **H1:** en la reserva, el exceso a 4h con entrada en apertura siguiente de las señales LONG con score 80–100 es ≥ que el de las de score 75–79.
- **Decisión:** si H1 se cumple, la inversión 80–100 observada en live se trata como propia de la ventana o del régimen. Si falla, se trata como estructural.
- Los cortes por trimestre, tendencia, volatilidad y movimiento previo son descriptivos y no cambian la decisión.

**Ejecución.**

```powershell
npx tsx scripts/research/run-historical-baseline.mts --from-month=2023-10 --to-month=2026-09 --holdout-end-month=2024-09 --permutations=2000 --seed=20261024
```

Genera `reports/historical-baseline.json` (ignorado por Git), unos 3.5 minutos con caché.

- **Datos:** 144 archivos mensuales de `data.binance.vision`, con URL, SHA-256, bytes y primera/última vela por archivo. Hash del manifiesto: `8c39a495be356c34…`.
- **Cobertura:** 105 216 de 105 216 velas por activo, de 2023-10-01 00:00 a 2026-09-30 23:45.
- **Exclusiones declaradas por activo:** 248 de calentamiento y 17 de cola (estructurales), 0 rechazos de replay, 0 ventanas cortas.
- **Señales:** 51 790 LONG (BTC 10 414, ETH 12 159, SOL 16 069, XRP 13 148), que forman 5 232 episodios independientes a 4h.

**Tarea 3. Resultado principal (apertura siguiente, ventana live de 249 velas).**

| Horizonte | Exceso frente a baseline del mismo activo | p circular bilateral | Neto 20 bps | Neto 30 bps | Ops. con ganancia neta a 20 bps |
| --- | ---: | ---: | ---: | ---: | ---: |
| 15m | +0.002 % | 0.41 | −0.196 % | −0.296 % | 24.7 % |
| 1h | +0.008 % | 0.26 | −0.185 % | −0.285 % | 33.2 % |
| 4h | +0.033 % | 0.12 | −0.138 % | −0.238 % | 40.4 % |

El comparador de cierre a cierre da casi lo mismo (+0.033 % a 4h, p = 0.12). En 36 meses la selección del score no se distingue de entrar al azar en el mismo activo, y con costes realistas cada operación pierde en promedio en los tres horizontes. Por activo a 4h: XRP +0.084 %, ETH +0.046 %, SOL +0.006 %, BTC −0.003 %. Ninguno queda positivo neto de 20 bps. Coincide con la ventana live (neto −0.23 % a −0.29 %) y con los walk-forward de las ramas.

**Tarea 4. H1 no se cumple.** En la reserva (2023-10 a 2024-09), a 4h, el tramo 80–100 rinde 0.066 puntos porcentuales **menos** que el 75–79 (10 907 frente a 7 032 señales; p de permutación de etiquetas 0.011, optimista por el solape). Según la regla registrada, la inversión no puede atribuirse solo a la ventana live.

El contexto descriptivo matiza la conclusión. Después de la reserva (2024-10 a 2026-09) el orden se invierte: 80–100 rinde +0.045 puntos más (p = 0.026), lo que replica la atribución de `production-score-walkforward` en ese mismo periodo. En el total de 36 meses la diferencia es +0.006 (p = 0.68). Por trimestre, el tramo alto rinde menos en 5 de 12 trimestres, y esas inversiones no siguen la dirección del mercado: aparecen con subas de +108 % y +57 % y con caídas de −23 %. La lectura que soportan los datos es que **por encima de 75 el score no ordena las señales de forma estable**: el signo de la diferencia entre tramos cambia según el periodo. No es una inversión estructural constante ni una propiedad exclusiva de octubre de 2026. Esto no justifica ajustar umbrales.

Cortes descriptivos a 4h, sin valor de decisión y no corregidos por pruebas múltiples:
- **Tendencia:** EMA50 > EMA200, +0.050 % (37 549 señales); EMA50 < EMA200, −0.010 % (14 241).
- **Volatilidad:** tercil alto +0.055 %, medio +0.010 %, bajo +0.022 %.
- **Movimiento previo de 4h:** negativo +0.062 % (solo 1 316 señales), +0–1 % +0.016 %, ≥ +1 % +0.042 %.

Ningún corte queda positivo neto de costes. El mejor, volatilidad alta, da −0.114 % neto a 20 bps.

**Scripts anteriores.** `backtest.ts` y `backtest-baseline.ts` usan ahora el mismo cargador (`scripts/research/binance-archive.ts`): una fila ilegible o un mes faltante abortan la carga, la ventana termina en el último mes completo y el reporte incluye el manifiesto de archivos. Se eliminó el contador constante `missing_data: 0`. `backtest-baseline.ts` ya termina (51 808 señales). La diferencia de 18 señales frente a este reporte viene de que acepta ventanas de calentamiento de menos de 249 velas. Sus métricas son brutas y de cierre a cierre; la referencia es este reporte.

**Límites.** Solo spot, 4 activos, costes supuestos, sin liquidez, latencia ni ejecución parcial. Los trimestres y cortes se vieron después de registrar H1, pero no se usaron para formularla.

## Validación local

2026-10-21: `npm test` 36 pruebas, typecheck y build pasan.

2026-10-23: `npm test` 42/42 en tres corridas consecutivas (incluye las 6 de la sección 4); `npm run typecheck -- --incremental false`, `npm run lint`, `npm run build`, `npm run verify:engine` (18 checkpoints) y `git diff --check` pasan. La prueba de migración construye la réplica una vez y la clona por caso: con siete arranques de PGlite en paralelo, las pruebas pesadas de paridad y cron superaban el timeout de 5 s en 4 núcleos. La migración se aplicó el 2026-10-24 (sección 4).

2026-10-24, tareas 3 y 4: `npm test` 47/47 (incluye 5 pruebas nuevas del cargador y del replay histórico), typecheck, lint, `verify:engine` y `git diff --check` pasan. `backtest-baseline.ts` corre de punta a punta.
