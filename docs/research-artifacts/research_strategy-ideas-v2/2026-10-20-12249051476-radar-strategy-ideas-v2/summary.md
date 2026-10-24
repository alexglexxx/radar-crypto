# Radar Crypto — pruebas de ideas de estrategia (rama de investigación)

Generado: 2026-10-20T07:49:28.602Z · Datos: **Binance spot (data.binance.vision)** · Meses evaluados: 36 · Símbolos: BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT

Costo principal: 20 bps ida y vuelta · Estrés: 30 bps · Un resultado "no calificada" es un resultado válido: significa que la idea no pasó la prueba.

| Idea | Estrategia | Plazo | Ops. fuera de muestra | Ganancia media por op. | IC 95% corregido | A 30 bps | Periodos + | Mejora vs. "siempre dentro" | Veredicto |
|---|---|---|---:|---:|---|---:|---:|---:|---|
| 0 | s0_baseline_score_15m | 15m | 5763 | -0.145% | [-0.20%, -0.08%] | -0.245% | 0/8 | 0.043% | **not_qualified** |
| 1 | s1_score_horizon_15m | 15m | 888 | 0.046% | [-0.48%, 0.57%] | -0.054% | 3/8 | 0.031% | **not_qualified** |
| 2 | s2_score_regime_15m | 15m | 312 | 0.090% | [-0.64%, 0.92%] | -0.010% | 1/8 | 0.244% | **not_qualified** |
| 2 | s3r_donchian_regime_1h | 1h | 111 | 0.299% | [-1.00%, 1.65%] | 0.199% | 4/8 | 0.389% | **not_qualified** |
| 2 | s3r_donchian_regime_4h | 4h | 94 | 0.117% | [-1.33%, 2.11%] | 0.017% | 3/8 | 0.194% | **insufficient_sample** |
| 3 | s3_donchian_1h | 1h | 245 | 0.477% | [-0.41%, 1.59%] | 0.377% | 4/8 | 0.618% | **not_qualified** |
| 3 | s3_donchian_4h | 4h | 198 | 0.364% | [-0.97%, 1.77%] | 0.264% | 4/8 | 0.482% | **not_qualified** |
| 4 | s4_relative_strength_4h | 4h | 49 | 4.272% | [-2.08%, 14.11%] | 4.172% | 6/8 | n/d | **insufficient_sample** |
| 5 | s5_donchian_btc_tide_1h | 1h | 183 | 0.128% | [-0.61%, 0.96%] | 0.028% | 3/8 | 0.292% | **not_qualified** |
| 5 | s5_donchian_btc_tide_4h | 4h | 101 | 0.890% | [-0.85%, 3.17%] | 0.790% | 3/8 | 0.935% | **not_qualified** |
| 6 | s6_donchian_funding_1h | 1h | 48 | 1.194% | [-0.50%, 3.37%] | 1.094% | 4/8 | 1.251% | **insufficient_sample** |
| 6 | s6_donchian_funding_4h | 4h | 51 | 0.502% | [-1.56%, 2.84%] | 0.402% | 4/8 | 0.653% | **insufficient_sample** |
| 7 | s7_meanrev_sideways_1h | 1h | 0 | n/d | n/d | n/d | 0/8 | n/d | **insufficient_sample** |
| 7 | s7_meanrev_sideways_4h | 4h | 120 | -0.686% | [-1.68%, 0.31%] | -0.786% | 1/8 | -0.461% | **not_qualified** |
| 8 | s8_score_exits_15m | 15m | 0 | n/d | n/d | n/d | 0/8 | n/d | **insufficient_sample** |

## Por qué cada una pasó o no

### s0_baseline_score_15m
*Referencia: score de producción sin cambios (SETUP LONG ≥ 75, salida a 4 h)*

Hipótesis: Punto de comparación. Es lo que hace hoy el radar, medido con el mismo marco que las ideas nuevas.

- Referencia: no se califica, solo sirve para comparar.
- Aciertos: 38.8% · Caída máxima: 90.0% · Exposición: 32.9% · Comprar y mantener (promedio por periodo): 12.1%

### s1_score_horizon_15m
*Mismo score, mantener la posición más tiempo (4 h a 48 h)*

Hipótesis: Con costos fijos por operación, un movimiento más largo diluye el costo: la ventaja (si existe) debería crecer con el plazo.

- Falla: Expectativa neta a 30 bps (estrés) debe ser > 0
- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 47.0% · Caída máxima: 48.8% · Exposición: 60.2% · Comprar y mantener (promedio por periodo): 12.1%

### s2_score_regime_15m
*Mismo score, solo cuando el mercado está en tendencia*

Hipótesis: Filtrar los momentos de lateralidad o volatilidad extrema elimina muchas malas operaciones.

- Falla: Expectativa neta a 30 bps (estrés) debe ser > 0
- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 45.2% · Caída máxima: 28.6% · Exposición: 9.0% · Comprar y mantener (promedio por periodo): 12.1%

### s3r_donchian_regime_1h
*Donchian + filtro de régimen (solo en tendencia) — 1h*

Hipótesis: La misma ruptura, pero solo si el mercado ya está en tendencia alcista (y sin picos de volatilidad en la variante calm).

- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 36.0% · Caída máxima: 9.2% · Exposición: 4.3% · Comprar y mantener (promedio por periodo): 12.1%

### s3r_donchian_regime_4h
*Donchian + filtro de régimen (solo en tendencia) — 4h*

Hipótesis: La misma ruptura, pero solo si el mercado ya está en tendencia alcista (y sin picos de volatilidad en la variante calm).

- Solo 94 operaciones fuera de muestra; se necesitan al menos 100.
- Aciertos: 33.0% · Caída máxima: 16.1% · Exposición: 7.1% · Comprar y mantener (promedio por periodo): 12.1%

### s3_donchian_1h
*Ruptura de rango (Donchian) con volumen y stop por ATR — 1h*

Hipótesis: Comprar cuando el cierre supera el máximo de los últimos N días (con volumen alto) y dejar correr la ganancia con un stop que sube.

- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 40.8% · Caída máxima: 12.6% · Exposición: 7.7% · Comprar y mantener (promedio por periodo): 12.1%

### s3_donchian_4h
*Ruptura de rango (Donchian) con volumen y stop por ATR — 4h*

Hipótesis: Comprar cuando el cierre supera el máximo de los últimos N días (con volumen alto) y dejar correr la ganancia con un stop que sube.

- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 37.9% · Caída máxima: 22.4% · Exposición: 9.9% · Comprar y mantener (promedio por periodo): 12.1%

### s4_relative_strength_4h
*Fuerza relativa: tener solo la moneda más fuerte — 4h*

Hipótesis: Quien más sube en 30–90 días tiende a seguir liderando; si ninguna sube, quedarse en efectivo.

- Solo 49 operaciones fuera de muestra; se necesitan al menos 100.
- Aciertos: 44.9% · Caída máxima: 54.2% · Exposición: 84.4% · Comprar y mantener (promedio por periodo): 12.1%

### s5_donchian_btc_tide_1h
*Donchian + marea de BTC (alts solo si BTC está en tendencia) — 1h*

Hipótesis: Las alts casi siempre siguen a BTC: solo se permiten compras cuando BTC también está en tendencia alcista.

- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 38.3% · Caída máxima: 11.7% · Exposición: 3.9% · Comprar y mantener (promedio por periodo): 12.1%

### s5_donchian_btc_tide_4h
*Donchian + marea de BTC (alts solo si BTC está en tendencia) — 4h*

Hipótesis: Las alts casi siempre siguen a BTC: solo se permiten compras cuando BTC también está en tendencia alcista.

- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Aciertos: 39.6% · Caída máxima: 12.3% · Exposición: 8.3% · Comprar y mantener (promedio por periodo): 12.1%

### s6_donchian_funding_1h
*Donchian + funding (evitar mercado sobrecargado a la compra) — 1h*

Hipótesis: Un funding en su percentil alto indica demasiados apostando al alza; en ese caso la ruptura se ignora.

- Solo 48 operaciones fuera de muestra; se necesitan al menos 100.
- Aciertos: 45.8% · Caída máxima: 3.5% · Exposición: 2.2% · Comprar y mantener (promedio por periodo): 12.1%

### s6_donchian_funding_4h
*Donchian + funding (evitar mercado sobrecargado a la compra) — 4h*

Hipótesis: Un funding en su percentil alto indica demasiados apostando al alza; en ese caso la ruptura se ignora.

- Solo 51 operaciones fuera de muestra; se necesitan al menos 100.
- Aciertos: 39.2% · Caída máxima: 7.1% · Exposición: 2.6% · Comprar y mantener (promedio por periodo): 12.1%

### s7_meanrev_sideways_1h
*Reversión a la media solo en mercado lateral — 1h*

Hipótesis: En un mercado sin tendencia, una caída exagerada (z-score) tiende a regresar a su promedio de 20 velas.

- Solo 0 operaciones fuera de muestra; se necesitan al menos 100.

### s7_meanrev_sideways_4h
*Reversión a la media solo en mercado lateral — 4h*

Hipótesis: En un mercado sin tendencia, una caída exagerada (z-score) tiende a regresar a su promedio de 20 velas.

- Falla: Expectativa neta a 20 bps debe ser > 0
- Falla: Expectativa neta a 30 bps (estrés) debe ser > 0
- Falla: Límite inferior del intervalo de confianza (corregido por 15 estrategias) debe ser > 0
- Falla: Al menos 60% de los periodos fuera de muestra deben ser positivos
- Falla: Debe superar a "estar siempre dentro" con la misma salida
- Aciertos: 41.7% · Caída máxima: 18.9% · Exposición: 2.3% · Comprar y mantener (promedio por periodo): 12.1%

### s8_score_exits_15m
*Mismo score, salidas definidas (stop, objetivo o stop que sube)*

Hipótesis: Hoy no hay stop ni objetivo; definir cuándo salir puede cambiar los resultados más que mejorar la entrada.

- Solo 0 operaciones fuera de muestra; se necesitan al menos 100.

## Cómo leer esto

- **Fuera de muestra**: los parámetros se eligen solo con 12 meses de entrenamiento y se prueban en los 3 meses siguientes, que el sistema no vio.
- **IC corregido**: intervalo de confianza que descuenta haber probado varias ideas a la vez (cuantas más pruebas, más fácil engañarse con la suerte).
- **Siempre dentro**: lo que ganaría quien entra sin ninguna señal usando la misma salida. Si la idea no lo supera, la señal de entrada no aporta nada.
- Pasar estas pruebas **no** demuestra rentabilidad futura; solo permite seguir validando con otros datos y con ejecución real.
