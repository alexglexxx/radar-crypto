# Radar Crypto: checkpoint de investigación (2026-10-21)

`v1.1-live` y la lógica de producción siguen congeladas. Esta auditoría trabaja en la rama local `work/security-baseline-audit-20261021`; la migración de permisos está preparada, sin aplicar a producción.

## 1. Acceso a datos

La comprobación anterior que atribuía lectura anónima a las cuatro tablas usó por error una variable `NEXT_PUBLIC_SUPABASE_ANON_KEY` que contenía un JWT `service_role`. Con una clave realmente publicable, `market_snapshots`, `features` y `signal_outcomes` devuelven 401. `radar_signals` permite leer once columnas por grants de columna y una política permisiva; `current_signals_public` devuelve los cuatro activos. Se corrigió la variable local ignorada por Git y se añadió un guard de `predev`/`prebuild` que rechaza claves privilegiadas en variables públicas.

`supabase/migrations/20261021200000_lock_down_research_access.sql` elimina el acceso directo y cambia la vista delimitada a `security_invoker=false`, propiedad de `postgres`, con proyección explícita y filtro de siete días para `v1.1-live`. Esto permite mantener la vista pública sin grants de la tabla base. Requiere validación en una base aislada y revisión antes de aplicarse a producción. Una vez aplicada, ejecutar:

```powershell
node scripts/audit-public-access.mjs --expect-locked
```

Debe mostrar 401/403 en las cuatro tablas y una fila visible de `current_signals_public` por activo. Antes de la migración falla correctamente en `radar_signals`. Repetir la comprobación de la página pública después de aplicar la migración. No registrar ni imprimir claves.

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

## Validación local

`npm test`: 36 pruebas pasan. `npm run typecheck -- --incremental false` y `npm run build`: pasan. La migración SQL sigue sin ejecutarse: no hay Postgres/Docker local disponible y el proyecto prohíbe desplegar o aplicar cambios de producción sin autorización. El siguiente paso de la tarea 1 es probarla en una base aislada, después revisar el smoke test público y recién entonces plantear su aplicación.
