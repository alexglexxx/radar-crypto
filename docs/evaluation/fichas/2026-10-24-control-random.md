# Ficha de evaluación: control-random

**Veredicto: RECHAZADO** · control del gate, no es una estrategia

- Idea evaluada: Control nulo: compra al azar en ~12 % de las velas, la misma frecuencia que v1.1-live. El gate debe rechazarlo.
- Horizonte declarado antes de correr: 4h
- Periodo: 2023-10 a 2026-09 · Datos: 144 archivos mensuales de data.binance.vision, manifiesto 8c39a495be356c34
- Reglas: gate-v1 · Commit: `d395e2e` · Generado: 2026-10-24

| Prueba | Resultado | Exigido | ¿Pasa? |
| --- | --- | --- | --- |
| No mira el futuro | 0 de 800 puntos cambian | 0 cambios | Sí |
| Muestra suficiente | 5609 episodios independientes (50572 señales) | ≥ 300 | Sí |
| Le gana al azar | −0.002 % por operación (p 0.615) | > 0 y p < 0.05 | **No** |
| Gana después de comisiones | −0.175 % con 20 bps (−0.275 % con 30 bps) | > 0 | **No** |
| Estable en el tiempo | 1 de 3 periodos le ganan al azar | 3 de 3 | **No** |
| No depende de una sola moneda | 1 de 4 monedas le ganan al azar | ≥ 3 | **No** |

Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.

**Por moneda** (diferencia frente a entrar al azar en la misma moneda)

| Moneda | Señales | Frente al azar |
| --- | ---: | ---: |
| BTC | 12680 | −0.000 % |
| ETH | 12704 | −0.007 % |
| SOL | 12667 | −0.006 % |
| XRP | 12521 | +0.006 % |

**Por periodo**

| Desde | Hasta | Señales | Frente al azar |
| --- | --- | ---: | ---: |
| 2023-10-01 | 2024-09-30 | 16778 | −0.010 % |
| 2024-10-01 | 2025-09-30 | 16896 | −0.005 % |
| 2025-10-01 | 2026-09-30 | 16898 | +0.010 % |

Cómo se mide: la señal se da al cierre de una vela, se compra en la apertura de la siguiente y se vende en la apertura cuando se cumple el horizonte. Comisiones de ida y vuelta: 20 bps (prueba de estrés 30 bps). "Frente al azar" compara con entrar en cada vela de la misma moneda y periodo; el valor p sale de 2000 desplazamientos circulares que conservan los grupos de señales.
