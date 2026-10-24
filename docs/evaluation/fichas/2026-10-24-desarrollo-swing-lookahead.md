# Ficha de evaluación: swing-lookahead

**Veredicto: RECHAZADO** · control del gate, no es una estrategia

- Idea evaluada: Control de futuro: compra solo si la operación va a tocar el TP antes que el SL, leyendo las velas siguientes. Parece perfecto; el gate debe rechazarlo en "No mira el futuro".
- Etapa: desarrollo · Periodo: 2023-10 a 2026-09 · Datos: 148 archivos mensuales de velas (manifiesto a74cdfb99cc53d4d) y 148 de funding (manifiesto 3cd9224b5ce0edd1) de data.binance.vision
- Reglas: gate-v2 · Commit: `d6a3808` · Huella de la definición: `1e59281df068` · Generado: 2026-10-24

| Prueba | Resultado | Exigido | ¿Pasa? |
| --- | --- | --- | --- |
| No mira el futuro (ni más de 30 días atrás) | 526 de 794 puntos cambian | 0 cambios | **No** |
| Muestra suficiente | 1602 operaciones (9352 decisiones de compra) | ≥ 200 | Sí |
| Le gana al azar | +4.192 % por operación (p 0.000) | > 0 y p < 0.05 | Sí |
| Gana después de comisiones | +4.000 % con 20 bps (+3.900 % con 30 bps) | > 0 | Sí |
| Estable en el tiempo | 3 de 3 años le ganan al azar | 3 de 3 | Sí |
| No depende de una sola moneda | 4 de 4 monedas le ganan al azar | ≥ 3 | Sí |

Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.

- Operaciones: 1602
- Señales (antes de la regla de una posición): 9352

**Candidato frente al azar** (mismo esquema TP/SL/72 h)

| Medida | Candidato | Azar |
| --- | ---: | ---: |
| Tasa de TP | 100.0 % | 35.7 % |
| Tasa de SL | 0.0 % | 39.7 % |
| Tasa de tiempo | 0.0 % | 24.6 % |
| Horas medias | 28.4 h | 38.2 h |

**Por moneda** (diferencia frente a entrar al azar en la misma moneda)

| Moneda | Operaciones | Frente al azar | Tasa de TP |
| --- | ---: | ---: | ---: |
| BTC | 229 | +4.061 % | 100.0 % |
| ETH | 370 | +4.056 % | 100.0 % |
| SOL | 560 | +4.197 % | 100.0 % |
| XRP | 443 | +4.367 % | 100.0 % |

**Por año**

| Desde | Hasta | Operaciones | Frente al azar |
| --- | --- | ---: | ---: |
| 2023-10-01 | 2024-09-30 | 584 | +4.074 % |
| 2024-10-01 | 2025-09-30 | 607 | +4.061 % |
| 2025-10-01 | 2026-09-27 | 411 | +4.438 % |

**Caídas aceptadas** (huecos de datos idénticos en las 4 monedas)

Ninguna

Cómo se mide: la decisión se toma al cierre de cada vela de 4h; se compra en la apertura de la vela siguiente y se vende al tocar +4 % neto (TP) o −4 % neto (SL), o a las 72 h en la apertura; si una vela toca ambos niveles cuenta el SL. Comisiones de ida y vuelta: 20 bps (prueba de estrés 30 bps). "Frente al azar" compara con el mismo esquema TP/SL/72 h en la misma moneda y periodo; el valor p sale de 2000 desplazamientos circulares por moneda, reaplicando la regla de una posición a la vez.
