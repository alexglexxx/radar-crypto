# Ficha de evaluación: swing-btc-lookahead

**Veredicto: RECHAZADO** · control del gate, no es una estrategia

- Idea evaluada: Control de futuro entre monedas: compra cualquier moneda si BTC cierra más alto 24 h después. El gate debe rechazarlo en "No mira el futuro".
- Etapa: desarrollo · Periodo: 2023-10 a 2026-09 · Datos: 148 archivos mensuales de velas (manifiesto a74cdfb99cc53d4d) y 148 de funding (manifiesto 3cd9224b5ce0edd1) de data.binance.vision
- Reglas: gate-v2 · Commit: `d6a3808` · Huella de la definición: `1e051b987672` · Generado: 2026-10-24

| Prueba | Resultado | Exigido | ¿Pasa? |
| --- | --- | --- | --- |
| No mira el futuro (ni más de 30 días atrás) | 796 de 796 puntos cambian | 0 cambios | **No** |
| Muestra suficiente | 2392 operaciones (13800 decisiones de compra) | ≥ 200 | Sí |
| Le gana al azar | +1.149 % por operación (p 0.000) | > 0 y p < 0.05 | Sí |
| Gana después de comisiones | +0.962 % con 20 bps (+0.862 % con 30 bps) | > 0 | Sí |
| Estable en el tiempo | 3 de 3 años le ganan al azar | 3 de 3 | Sí |
| No depende de una sola moneda | 4 de 4 monedas le ganan al azar | ≥ 3 | Sí |

Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.

- Operaciones: 2392
- Señales (antes de la regla de una posición): 13800

**Candidato frente al azar** (mismo esquema TP/SL/72 h)

| Medida | Candidato | Azar |
| --- | ---: | ---: |
| Tasa de TP | 51.3 % | 35.7 % |
| Tasa de SL | 28.6 % | 39.7 % |
| Tasa de tiempo | 20.2 % | 24.6 % |
| Horas medias | 33.5 h | 38.2 h |

**Por moneda** (diferencia frente a entrar al azar en la misma moneda)

| Moneda | Operaciones | Frente al azar | Tasa de TP |
| --- | ---: | ---: | ---: |
| BTC | 429 | +1.311 % | 40.1 % |
| ETH | 548 | +1.049 % | 51.1 % |
| SOL | 754 | +1.206 % | 58.9 % |
| XRP | 661 | +1.063 % | 50.1 % |

**Por año**

| Desde | Hasta | Operaciones | Frente al azar |
| --- | --- | ---: | ---: |
| 2023-10-01 | 2024-09-30 | 851 | +0.963 % |
| 2024-10-01 | 2025-09-30 | 896 | +1.118 % |
| 2025-10-01 | 2026-09-27 | 645 | +1.350 % |

**Caídas aceptadas** (huecos de datos idénticos en las 4 monedas)

Ninguna

Cómo se mide: la decisión se toma al cierre de cada vela de 4h; se compra en la apertura de la vela siguiente y se vende al tocar +4 % neto (TP) o −4 % neto (SL), o a las 72 h en la apertura; si una vela toca ambos niveles cuenta el SL. Comisiones de ida y vuelta: 20 bps (prueba de estrés 30 bps). "Frente al azar" compara con el mismo esquema TP/SL/72 h en la misma moneda y periodo; el valor p sale de 2000 desplazamientos circulares por moneda, reaplicando la regla de una posición a la vez.
