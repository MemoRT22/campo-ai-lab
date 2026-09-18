# Pruebas en sitio

Hoja para copiar y pegar en la barra del navegador del equipo de la instalación.
Todas asumen el servidor de desarrollo (`npm run dev`, puerto **5180**). Con el build de
producción (`npm run preview`) cambia el puerto a **4180**; con un servidor propio, sólo el host.

Cualquier parámetro se puede combinar con `&`. Ninguno recompila nada ni se guarda: al recargar sin
el parámetro, vuelve el valor por defecto. Lo único que persiste es lo que se guarda a mano desde
`?calibrate=true`.

---

## Red de seguridad — si la cámara falla

Sin panel y sin cámara. Corre la coreografía completa con siluetas sintéticas: entra una persona,
luego una segunda, luego una tercera, con modo pareja y colectivo. No depende de nada externo y no
puede fallar. **Tenerla en una pestaña abierta el día del evento.**

```text
http://localhost:5180/?mock=true&displayProfile=large
```

La misma, con panel, para revisar que la app arranca bien antes de conectar nada:

```text
http://localhost:5180/?mock=true&debug=true&displayProfile=large
```

---

## 0. Lo primero al llegar

Panel técnico con el perfil de la pared:

```text
http://localhost:5180/?debug=true&displayProfile=large
```

Si alguna vez se guardó calibración en ese equipo, **pisa los valores por defecto** (área mínima,
presupuesto de partículas, predicción, spacing). Abre calibración y pulsa **RESTABLECER** antes de
medir nada:

```text
http://localhost:5180/?calibrate=true&displayProfile=large
```

---

## 1. Compensar la latencia (empezar por aquí)

Sube el adelanto de 50 a 110 ms y hace que las partículas se peguen más rápido al target. Es lo que
cancela la latencia que no se puede quitar (cámara, capturadora, procesador de la pared). El precio
es que al frenar en seco la silueta se pasa un poco y vuelve:

```text
http://localhost:5180/?debug=true&displayProfile=large&particles.predictionMs=110&particles.predictionMaxDistance=80&particles.trackingResponseMs=85
```

Si se pasa demasiado, bajar el adelanto:

```text
http://localhost:5180/?debug=true&displayProfile=large&particles.predictionMs=80&particles.predictionMaxDistance=60&particles.trackingResponseMs=100
```

Volver al valor por defecto del perfil (50 ms) para comparar:

```text
http://localhost:5180/?debug=true&displayProfile=large
```

| Parámetro | Defecto LARGE | Qué hace | Se pasa cuando |
| --- | ---: | --- | --- |
| `particles.predictionMs` | 50 | Cuánto se adelanta el target a la persona | La silueta se sale del cuerpo al frenar |
| `particles.predictionMaxDistance` | 40 | Tope del adelanto, en px | — |
| `particles.trackingResponseMs` | 120 | Suavizado de la partícula hacia su celda. Menos = más pegado y más nervioso | Las partículas vibran |

---

## 2. Aislar de dónde viene el lag

El panel mide de la captura en adelante. **Lo que pasa antes —sensor de la cámara, HDMI,
capturadora— y lo que pasa después —procesador de la pared LED— no aparece en ningún número.**
`sensor→web ≈ 0 ms` con una capturadora UVC no significa "instantáneo", significa que el
dispositivo no entrega un timestamp real del sensor.

Por eso, si se ve lagueado con el panel marcando ~60 ms, hay que separar las variables a mano:

| Prueba | Cámara | Equipo | Pantalla | Si va lagueado aquí… |
| --- | --- | --- | --- | --- |
| 1 | Canon + capturadora | laptop | laptop | es la cadena de cámara |
| 2 | webcam USB simple | desktop | pared LED | es el equipo o la pared |
| 3 | webcam USB simple | desktop | monitor normal | es el equipo |

Prueba 2 mal y prueba 3 bien ⇒ es el procesador de la pared.

**Latencia real (glass-to-glass).** Ningún número del panel la mide. Se filma con un móvil a 120 o
240 fps la pared y a la persona en el mismo cuadro, y se cuentan los frames entre el movimiento y
la reacción de las partículas. Es la única medida honesta del conjunto.

---

## 3. Bajar el coste de la captura

`captura X ms` es lo que tarda el navegador en entregar el frame ya reducido. En una cámara
integrada son ~0.2 ms; con una capturadora que comprime a MJPG pueden ser 20–25 ms, y entran
enteros en la latencia.

El modelo trabaja internamente a 256×144, así que para **el cuerpo** bajar la resolución de cámara
no cuesta nada de detalle. Para **los dedos** sí, porque salen de recortes del mismo video:

```text
http://localhost:5180/?debug=true&displayProfile=large&camera.cameraWidth=640&camera.cameraHeight=360
```

```text
http://localhost:5180/?debug=true&displayProfile=large&camera.cameraWidth=960&camera.cameraHeight=540
```

Pose gasta ~50 ms de GPU por inferencia y sólo alimenta los gestos. Bajarla libera GPU para la
silueta, que es lo que se ve:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.poseFPS=6
```

---

## 4. Dedos

Van encendidos por defecto. No se analizan las manos demasiado pequeñas en el sensor
(`hands.minHandPx`, 120 px): a distancia no hay dedos que encontrar y el análisis sólo le quitaría
GPU al cuerpo. El panel avisa con `N lejos`.

Si en el video se ven dedos claros pero el panel dice `lejos`, el umbral está alto:

```text
http://localhost:5180/?debug=true&displayProfile=large&hands.minHandPx=90
```

Si los dedos salen gordos o pegados:

```text
http://localhost:5180/?debug=true&displayProfile=large&hands.fingerRadius=0.075
```

Si parpadean:

```text
http://localhost:5180/?debug=true&displayProfile=large&hands.maxAgeMs=320
```

Apagarlos del todo (útil para medir cuánto cuestan):

```text
http://localhost:5180/?debug=true&displayProfile=large&hands.enabled=false
```

---

## 5. Detección: lejos, fantasmas, cámara nueva

Si Pose ve a la persona pero la máscara sale vacía, la confianza del segmentador no llega al
umbral. Pasa al cambiar de cámara, porque cambia el contraste y el rango de la imagen:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.maskThreshold=0.45&vision.maskHysteresis=0.15
```

Si aparecen siluetas fantasma (reflejos del vidrio, sombras), subir el área mínima:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.minPersonArea=0.0025
```

**Zoom de recorte.** El techo del detalle a distancia es el tensor interno del modelo (256×144), no
la cámara. Recortar concentra esos 256×144 en la zona útil, y con `cropAtCapture` el recorte se
toma al capturar, así que es resolución real. Sólo hay ganancia si el recorte reduce ancho **y**
alto a la vez. Lo que se ve sigue siendo exactamente el recorte:

```text
http://localhost:5180/?debug=true&displayProfile=large&camera.crop={"x":0.2,"y":0.1,"width":0.6,"height":0.6}
```

---

## 5b. Siluetas: limpieza y detalle

El techo del detalle es el modelo, no la cámara. El segmentador por defecto
(`selfie_segmenter_landscape`) trabaja internamente a **256×144**: una persona de pie que ocupa el
80% del alto del encuadre se resuelve con ~115 filas de píxeles, se mire con la cámara que se mire.
Subir resolución de cámara o `inferenceWidth` no añade ni una fila.

### Probar otro modelo (lo primero si el contorno se ve basto)

Están los tres en `public/models`. El cambio es sólo URL, no recompila nada, y si se ve peor se
vuelve recargando sin el parámetro. **Es un A/B de 30 segundos; pruébalos parado a la distancia
real.**

Cuadrado en vez de apaisado — 256×256, casi el doble de filas para un cuerpo de pie:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.modelPath=models/selfie_segmenter.tflite
```

DeepLab v3 — 257×257, entrenado con escenas reales y cuerpos completos, no con selfies. Es el más
pesado (2.8 MB, más clases): mira que `segmentación ms inf` no se dispare:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.modelPath=models/deeplab_v3.tflite
```

El de siempre, para comparar:

```text
http://localhost:5180/?debug=true&displayProfile=large
```

En la línea `modelo` del panel se ve cuál cargó y con qué etiquetas.

Ninguno de los tres está entrenado para cuerpos completos a 5 m; los dos primeros son de selfie y
videollamada. Por eso el A/B es empírico: no hay forma de predecir cuál gana en esta sala.

### Ajustar el contorno por síntoma

| Lo que se ve | Qué probar |
| --- | --- |
| Borde dentado, escalonado | `vision.spatialBlurRadius=2` |
| Silueta hinchada, se come el fondo | `vision.maskThreshold=0.62` |
| Faltan brazos o partes finas | `vision.maskThreshold=0.48&vision.maskHysteresis=0.14` |
| El contorno hierve estando quieto | `vision.smoothingAttackMs=40&vision.smoothingReleaseMs=140` |
| Se pierde detalle fino (dedos, pelo) | `vision.spatialBlurRadius=0&particles.silhouette.contourHysteresis=0.05` |
| El borde no se pega a la forma | `particles.silhouette.contourThreshold=0.42&particles.silhouette.maxSnap=1.0` |

Ejemplo de contorno más suave y estable, para leerse de lejos:

```text
http://localhost:5180/?debug=true&displayProfile=large&vision.spatialBlurRadius=2&vision.smoothingAttackMs=40&vision.smoothingReleaseMs=140
```

### Lo que gana más que cualquier parámetro

1. **Acercar a la persona.** A 2 m ocupa el doble de píxeles del modelo que a 4 m. Una marca en el
   piso resuelve el problema de raíz en vez de pelearlo.
2. **Luz sobre la persona.** Con poca luz la imagen llega movida y con ruido, y el borde de la
   máscara hierve. Es la causa más común de "no sale limpia".
3. **Recortar** (sección 5): concentra los 256×144 en la zona útil.

---

## 6. Densidad y rendimiento

Si `densidad` va por debajo del 100% y sobra `js`, subir el presupuesto:

```text
http://localhost:5180/?debug=true&displayProfile=large&particles.bodyParticleBudget=21000
```

Si el equipo no da, aligerar:

```text
http://localhost:5180/?debug=true&displayProfile=large&particles.particleSpacing=6.5&particles.bodyParticleBudget=12000
```

---

## 7. Elegir cámara

Por índice (el `dispositivo #N` del panel):

```text
http://localhost:5180/?debug=true&displayProfile=large&camera=1
```

Por nombre (fragmento, sin distinguir mayúsculas):

```text
http://localhost:5180/?debug=true&displayProfile=large&camera=UVC
```

---

## 8. Producción

Sin panel: es la única forma honesta de juzgar cómo se siente, porque el panel también cuesta.

```text
http://localhost:5180/?displayProfile=large
```

Con el adelanto que haya quedado bien en el paso 1, por ejemplo:

```text
http://localhost:5180/?displayProfile=large&particles.predictionMs=110&particles.predictionMaxDistance=80&particles.trackingResponseMs=85
```

Y la de respaldo, sin cámara, por si hay que salir del paso:

```text
http://localhost:5180/?mock=true&displayProfile=large
```

Cuando los valores estén decididos, conviene fijarlos en `src/config.ts` o en el perfil LARGE
(`src/core/configOverrides.ts`) en vez de depender de la URL.

---

## Qué mirar en el panel

| Línea | Qué es | Bien |
| --- | --- | --- |
| `cámara N fps medidos` | Lo que la cámara entrega de verdad | ≥ 27 |
| `captura N /s · X ms` | Coste de sacar cada frame del dispositivo | X < 5 ms |
| `segmentación N fps · X ms inf · age A ms` | Ritmo de la máscara y su antigüedad | N ≥ 25, A ≤ 40 |
| `pose N fps · X ms inf` | Sólo alimenta gestos | N 6–10 |
| `manos N/M vistas · K lejos` | Manos aplicadas / vistas / descartadas por tamaño | — |
| `pipeline A · B · ≈ T` | A no es fiable con capturadora; B es lo que controla el código | B ≤ 35 ms |
| `interpolación cada N ms · ventana W` | Hueco real entre máscaras y cuánto lo cubre | W ≥ N |
| `silueta N celdas · densidad D%` | Detalle de la silueta | D = 100% |
| `render N fps · js X ms` | Dibujo y simulación | N ≥ 55, X ≤ 10 ms |

### Referencias medidas

| | MacBook Pro (cámara integrada) | Desktop + Canon por capturadora |
| --- | --- | --- |
| `cámara` | 30.0 fps | 27.6 fps |
| `captura` | 0.2 ms | 23.4 ms |
| `segmentación` | 30.0 fps · age 33 ms | 18.7 fps · age 50 ms |
| `pipeline` B | 11 ms | 54 ms |
| `js` | 3.28 ms | 16.11 ms (incluía el coste del propio panel, ya corregido) |
