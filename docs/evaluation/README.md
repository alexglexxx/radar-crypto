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

## Límite importante

Los 36 meses ya se miraron en análisis anteriores. Para una idea nueva sacada de esos mismos datos, pasar el histórico es necesario pero no suficiente: la prueba limpia es el seguimiento en papel con datos posteriores a 2026-09.
