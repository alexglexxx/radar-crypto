# Gate de evaluación

Un examen fijo por el que pasa cualquier idea de estrategia antes de tomarla en serio. Las reglas se escribieron antes de correr ningún candidato y son las mismas para todos. Cambiarlas crea una versión nueva del gate; cada veredicto queda ligado a la versión que lo dio.

## Reglas `gate-v1`

Cada candidato declara de antemano su idea y su horizonte (15m, 1h o 4h). El gate no busca el horizonte que mejor le quede.

| Prueba | Qué pregunta | Exigido |
| --- | --- | --- |
| No mira el futuro | ¿La decisión cambia si se borra todo lo que pasó después? | 0 cambios en 200 puntos por moneda |
| Muestra suficiente | ¿Hay suficientes operaciones que no se pisen entre sí? | ≥ 300 episodios independientes |
| Le gana al azar | ¿Rinde más que entrar en cualquier vela de la misma moneda? | Diferencia > 0 y p < 0.05 |
| Gana después de comisiones | ¿Gana dinero pagando 0.20 % de ida y vuelta? | Promedio neto > 0 |
| Estable en el tiempo | ¿Le gana al azar en cada uno de los tres años? | 3 de 3 |
| No depende de una sola moneda | ¿Le gana al azar en varias monedas? | ≥ 3 de 4 |

La compra se hace en la apertura de la vela siguiente a la señal, que es lo primero que se puede ejecutar. El valor p sale de 2000 desplazamientos circulares que conservan los grupos de señales, como en el resto de la investigación.

Veredictos: **RECHAZADO**, o **CANDIDATO A PAPEL**. Pasar el histórico no autoriza operar: el candidato sigue en papel con datos nuevos antes de cualquier uso real.

## Controles

El gate se prueba a sí mismo con candidatos cuyo resultado se conoce:

- `control-random`: compra al azar. Debe salir rechazado.
- `control-lookahead`: hace trampa mirando el precio futuro. Parece perfecto y debe salir rechazado por "No mira el futuro".
- En los tests, un control positivo con una ventaja sembrada en datos sintéticos debe salir aprobado; si el gate rechazara todo, no serviría.
- `v1.1-live`: ya se sabe que no tiene ventaja. Si el gate lo aprobara, el gate estaría mal.

## Uso

```powershell
npx tsx scripts/research/run-gate.mts --candidates=v1.1-live,control-random,control-lookahead
```

Opciones: `--from-month=2023-10 --to-month=2026-09 --seed=20261024`. Los candidatos viven en `scripts/research/gate-candidates.ts`.

Cada corrida escribe:

- `fichas/<fecha>-<candidato>.md`: la ficha legible, con el veredicto y cada prueba.
- `registry.tsv`: una fila por intento, incluidos los fallidos y los controles. No se borran filas.
- `reports/gate/<candidato>.json` (no versionado): el detalle completo con el manifiesto de datos.

## Reglas `gate-v2`

Segundo gate, para candidatos de swing largo en spot (BTC, ETH, SOL y XRP). La decisión se toma al cierre de cada vela de 4h UTC con solo los últimos 30 días de velas de 15m y de funding; se compra en la apertura de la vela siguiente y se vende al tocar +4 % neto (TP) o −4 % neto (SL), o a las 72 h. Si una vela toca ambos niveles cuenta el SL. El SL se vende en el nivel o en la apertura si es peor: una vela que abre por debajo del SL (hueco a la baja, también tras una caída del exchange) se vende en su apertura y la operación puede perder más de −4 %. Comisión: 0.20 % de ida y vuelta (estrés 0.30 %). Una posición a la vez por moneda. Las reglas están en `scripts/research/swing-gate.ts` (`GATE_V2_RULES`).

| Prueba | Qué pregunta | Exigido |
| --- | --- | --- |
| `no-lookahead` | ¿La decisión cambia si se borra todo lo que pasó después (y lo anterior a 30 días)? | 0 cambios en 200 decisiones por moneda |
| `sample` | ¿Hay suficientes operaciones? | ≥ 200 operaciones |
| `beats-random` | ¿Rinde más que entrar al azar con el mismo esquema? | Exceso > 0 y p < 0.05 (2000 desplazamientos circulares por moneda, semilla 20261024) |
| `net-of-costs` | ¿Gana dinero a 20 bps de ida y vuelta? | Media neta > 0 |
| `stable` | ¿Le gana al azar en cada año? | Exceso > 0 en 3 de 3 años |
| `breadth` | ¿Le gana al azar en varias monedas? | Exceso > 0 en ≥ 3 de 4 monedas |

La muestra de `no-lookahead` son hasta 200 puntos distintos por moneda: la mitad repartida sobre todos los momentos de decisión del periodo y la mitad sobre las compras del candidato (si un punto cae en ambas mitades cuenta una vez).

**Etapas y límites.** `desarrollo` evalúa 2023-10 a 2026-09 (carga desde 2023-09 para tener historia previa; años desde 2023-10, 2024-10 y 2025-10): máximo 20 estrategias. `examen` evalúa 2020-10 a 2023-09 (años desde 2020-10, 2021-10 y 2022-10), años nunca mirados: máximo 3 candidatos, un examen por candidato, solo si su última fila de desarrollo es APRUEBA DESARROLLO, con `scripts`, `lib` y `docs/evaluation/registry-v2.tsv` sin cambios pendientes de commit. Los controles nunca pasan al examen. Un mismo id con otra definición se rechaza: un cambio de definición exige un id nuevo.

**Antes del examen** el comando comprueba, sin escribir nada, y aborta si algo falla:

1. Reproducción del desarrollo: vuelve a evaluar el candidato en desarrollo con el código actual y exige que veredicto, operaciones, exceso, p y media neta coincidan exactamente con su última fila APRUEBA DESARROLLO. Así el examen juzga lo mismo que aprobó el desarrollo, aunque haya cambiado una función auxiliar, una constante o el propio gate. Esta reproducción se imprime y no se registra.
2. Simulacro de caídas: toma las caídas del examen, las mueve +3 años (misma hora UTC) sobre los datos de desarrollo, quita esas velas de las 4 monedas y repite solo la prueba `no-lookahead`. Si cambia alguna decisión, el candidato cuenta velas en lugar de leer por tiempo y el examen se niega (corrígelo con un id nuevo).

Tras escribir una fila de examen, haz commit de `registry-v2.tsv` y de la ficha enseguida: sin commit, descartar el registro permitiría repetir el examen.

**Errores del candidato.** Si `decide` lanza un error en la evaluación principal, la corrida se aborta pero el intento queda escrito: fila RECHAZADO con las métricas vacías y una ficha con el mensaje de error. En el examen esa fila gasta el examen del candidato.

**Caídas aceptadas.** Un hueco de datos se acepta solo si es idéntico en las 4 monedas y dura 24 velas o menos; cualquier otro aborta la corrida. Las caídas aceptadas y la primera y última liquidación de funding de cada moneda se listan en la ficha (en el examen el funding de SOL empieza el 2020-09-13). Desarrollo no tiene caídas; el examen tiene 10 (93 velas, la mayor de 18).

**Leer por tiempo, no por número de velas.** Como el examen tiene caídas, "los últimos N días" no son siempre N × 96 velas: `candles[i − 2879]` está a 30 días en desarrollo y a más de 30 días tras una caída, donde `no-lookahead` falla. Busca el inicio de la ventana por hora con `firstIndexAtOrAfter` (en `swing-gate.ts`):

```ts
const DAY_MS = 24 * 3_600_000
decide: (ctx, symbol, index) => {
  const candles = ctx.candles.get(symbol)!
  const from = firstIndexAtOrAfter(candles, decisionTime(candles[index]) - 10 * DAY_MS) // últimos 10 días
  const high = Math.max(...candles.slice(from, index).map(c => c.high))
  return candles[index].close > high
}
```

**Controles.** `swing-random` (compra al azar; debe pasar `no-lookahead` y fallar `beats-random`), `swing-lookahead` (mira si la operación tocará TP; debe fallar `no-lookahead`) y `swing-btc-lookahead` (mira el cierre de BTC 24 h después; debe fallar `no-lookahead`). Los tres deben salir RECHAZADO; si no, el gate está mal.

**Veredictos.** RECHAZADO, APRUEBA DESARROLLO o CANDIDATO A PAPEL (solo tras el examen).

### Uso

```powershell
npx tsx scripts/research/run-gate-v2.mts --stage=desarrollo --candidates=swing-random,swing-lookahead,swing-btc-lookahead
```

Ambos argumentos son obligatorios. Los candidatos viven en `scripts/research/swing-candidates.ts`. Las rutas salen de la raíz del repositorio, se ejecute desde donde se ejecute. Cada corrida escribe:

- `fichas/<fecha>-<etapa>-<candidato>.md`: la ficha legible. Nunca se sobrescribe: si ya existe, se añade `-2`, `-3`, …
- `registry-v2.tsv`: una fila por intento, cualquiera que sea el veredicto. No se borran filas.
- `reports/gate-v2/<etapa>-<candidato>.json` (no versionado): resultado, contexto y manifiestos de velas y funding.

Para revisar los datos de una etapa sin evaluar nada (descarga, valida velas, rejilla y funding, e imprime caídas y cobertura de funding por moneda; no escribe nada):

```powershell
npx tsx scripts/research/run-gate-v2.mts --stage=examen --check-data
```

## Límite importante

Los 36 meses ya se miraron en análisis anteriores. Para una idea nueva sacada de esos mismos datos, pasar el histórico es necesario pero no suficiente: la prueba limpia es el seguimiento en papel con datos posteriores a 2026-09.
