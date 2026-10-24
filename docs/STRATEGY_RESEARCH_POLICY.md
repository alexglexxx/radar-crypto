# Política de investigación de estrategias — radar-crypto

## Principio fundacional

**radar-crypto es el proyecto base y no se sustituye por un bot externo.** Los repositorios, librerías, estrategias publicadas y modelos externos se estudian únicamente para complementar, auditar o corregir el sistema existente. Ninguna investigación autoriza por sí sola un reemplazo de la arquitectura, de `lib/features.ts` o de `lib/scoring.ts`.

La lógica de producción permanece intacta mientras las hipótesis se prueban en scripts y ramas de investigación aislados.

## Qué se investiga

1. **Baseline actual de radar-crypto:** medir el score existente con ejecución realista y sin modificar sus reglas.
2. **Momentum/tendencia:** comprobar si la señal actual aporta información neta fuera de muestra.
3. **Ruptura de rango (Donchian):** hipótesis independiente; no asumir que funciona en todos los marcos temporales.
4. **Reversión a la media:** evaluar por separado y sólo donde el régimen lo justifique.
5. **Filtro de régimen:** estudiar si tendencia, lateralidad y volatilidad ayudan a decidir cuándo no operar.

Cada hipótesis debe compararse sobre los mismos activos, fechas, datos y supuestos de costes. No se combinan estrategias antes de demostrar que cada componente añade valor incremental.

## Reglas de validación

- Validar cobertura, orden temporal, velas duplicadas, huecos y precios OHLC antes de aceptar métricas.
- Simular entradas posteriores al cierre de la vela de señal; nunca ejecutar retrospectivamente al precio de cierre que generó la señal si no era alcanzable.
- Incluir comisiones, spread y slippage; declarar el coste como round-trip o por lado sin ambigüedad.
- Separar entrenamiento y evaluación fuera de muestra. Los parámetros se eligen sólo con el tramo de entrenamiento.
- Alinear el objetivo de selección con la métrica principal de evaluación; para el walk-forward actual, la selección usa expectativa neta de operaciones no solapadas de 4 horas.
- Informar resultados por activo y por fold, además del agregado; incluir drawdown y sensibilidad a costes.
- Un workflow exitoso sólo demuestra que el código terminó. No demuestra que exista rentabilidad.
- Una hipótesis que no supera la validación se etiqueta como no cualificada; no se despliega ni se disfraza con más optimización.

## Referencias externas

- [Freqtrade](https://github.com/freqtrade/freqtrade): estudiar herramientas de backtesting y análisis de lookahead bias.
- [Freqtrade strategies](https://github.com/freqtrade/freqtrade-strategies): consultar estrategias como hipótesis, no como track record auditado.
- [VectorBT](https://github.com/polakowo/vectorbt): referencia para experimentos sistemáticos y análisis de carteras.
- [QuantConnect LEAN](https://github.com/QuantConnect/Lean): referencia para modelos de ejecución, costes y simulación.
- [Hummingbot](https://github.com/hummingbot/hummingbot): estudiar market making y arbitraje como líneas separadas, no mezclarlas sin más con el score direccional.

La popularidad de un repositorio o las ganancias declaradas por su autor no se consideran evidencia de rentabilidad. La evidencia debe ser reproducible, fuera de muestra y neta de costes.
