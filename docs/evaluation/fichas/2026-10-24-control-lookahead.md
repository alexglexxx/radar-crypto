# Ficha de evaluación: control-lookahead

**Veredicto: RECHAZADO** · control del gate, no es una estrategia

- Idea evaluada: Control de trampa: compra solo si el precio de salida a 4h ya se sabe mayor que el de entrada (mira el futuro). Parece perfecto; el gate debe detectarlo y rechazarlo.
- Horizonte declarado antes de correr: 4h
- Periodo: 2023-10 a 2026-09 · Datos: 144 archivos mensuales de data.binance.vision, manifiesto 8c39a495be356c34
- Reglas: gate-v1 · Commit: `d395e2e` · Generado: 2026-10-24

| Prueba | Resultado | Exigido | ¿Pasa? |
| --- | --- | --- | --- |
| No mira el futuro | 800 de 800 puntos cambian | 0 cambios | **No** |
| Muestra suficiente | 5233 episodios independientes (212821 señales) | ≥ 300 | Sí |
| Le gana al azar | +0.937 % por operación (p 0.000) | > 0 y p < 0.05 | Sí |
| Gana después de comisiones | +0.765 % con 20 bps (+0.665 % con 30 bps) | > 0 | Sí |
| Estable en el tiempo | 3 de 3 periodos le ganan al azar | 3 de 3 | Sí |
| No depende de una sola moneda | 4 de 4 monedas le ganan al azar | ≥ 3 | Sí |

Rechazado: no pasa todas las pruebas. No se usa para operar ni se ajusta mirando estos mismos datos.

**Por moneda** (diferencia frente a entrar al azar en la misma moneda)

| Moneda | Señales | Frente al azar |
| --- | ---: | ---: |
| BTC | 53939 | +0.630 % |
| ETH | 53717 | +0.878 % |
| SOL | 53107 | +1.209 % |
| XRP | 52058 | +1.040 % |

**Por periodo**

| Desde | Hasta | Señales | Frente al azar |
| --- | --- | ---: | ---: |
| 2023-10-01 | 2024-09-30 | 71682 | +0.940 % |
| 2024-10-01 | 2025-09-30 | 71676 | +1.015 % |
| 2025-10-01 | 2026-09-30 | 69463 | +0.854 % |

Cómo se mide: la señal se da al cierre de una vela, se compra en la apertura de la siguiente y se vende en la apertura cuando se cumple el horizonte. Comisiones de ida y vuelta: 20 bps (prueba de estrés 30 bps). "Frente al azar" compara con entrar en cada vela de la misma moneda y periodo; el valor p sale de 2000 desplazamientos circulares que conservan los grupos de señales.
