# Ficha de evaluación: swing-random

**Veredicto: RECHAZADO** · control del gate, no es una estrategia

- Idea evaluada: Control nulo: compra al azar en ~15 % de los momentos de decisión (sorteo fijo por hora y moneda). El gate debe rechazarlo en "Le gana al azar" y aprobar "No mira el futuro".
- Etapa: desarrollo · Periodo: 2023-10 a 2026-09 · Datos: 148 archivos mensuales de velas (manifiesto a74cdfb99cc53d4d) y 148 de funding (manifiesto 3cd9224b5ce0edd1) de data.binance.vision
- Reglas: gate-v2 · Commit: `d6a3808` · Huella de la definición: `549b6faaa163` · Generado: 2026-10-24

| Prueba | Resultado | Exigido | ¿Pasa? |
| --- | --- | --- | --- |
| No mira el futuro (ni más de 30 días atrás) | 0 de 799 puntos cambian | 0 cambios | Sí |
| Muestra suficiente | 1805 operaciones (4000 decisiones de compra) | ≥ 200 | Sí |
| Le gana al azar | +0.019 % por operación (p 0.247) | > 0 y p < 0.05 | **No** |
| Gana después de comisiones | −0.163 % con 20 bps (−0.263 % con 30 bps) | > 0 | **No** |
| Estable en el tiempo | 2 de 3 años le ganan al azar | 3 de 3 | **No** |
| No depende de una sola moneda | 2 de 4 monedas le ganan al azar | ≥ 3 | **No** |

Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.

- Operaciones: 1805
- Señales (antes de la regla de una posición): 4000

**Candidato frente al azar** (mismo esquema TP/SL/72 h)

| Medida | Candidato | Azar |
| --- | ---: | ---: |
| Tasa de TP | 37.3 % | 35.7 % |
| Tasa de SL | 42.2 % | 39.7 % |
| Tasa de tiempo | 20.4 % | 24.6 % |
| Horas medias | 34.5 h | 38.2 h |

**Por moneda** (diferencia frente a entrar al azar en la misma moneda)

| Moneda | Operaciones | Frente al azar | Tasa de TP |
| --- | ---: | ---: | ---: |
| BTC | 349 | +0.133 % | 28.7 % |
| ETH | 432 | −0.048 % | 36.8 % |
| SOL | 549 | +0.044 % | 43.9 % |
| XRP | 475 | −0.032 % | 36.6 % |

**Por año**

| Desde | Hasta | Operaciones | Frente al azar |
| --- | --- | ---: | ---: |
| 2023-10-01 | 2024-09-30 | 618 | −0.027 % |
| 2024-10-01 | 2025-09-30 | 626 | +0.024 % |
| 2025-10-01 | 2026-09-27 | 561 | +0.039 % |

**Caídas aceptadas** (huecos de datos idénticos en las 4 monedas)

Ninguna

Cómo se mide: la decisión se toma al cierre de cada vela de 4h; se compra en la apertura de la vela siguiente y se vende al tocar +4 % neto (TP) o −4 % neto (SL), o a las 72 h en la apertura; si una vela toca ambos niveles cuenta el SL. Comisiones de ida y vuelta: 20 bps (prueba de estrés 30 bps). "Frente al azar" compara con el mismo esquema TP/SL/72 h en la misma moneda y periodo; el valor p sale de 2000 desplazamientos circulares por moneda, reaplicando la regla de una posición a la vez.
