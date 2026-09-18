# CAMPO

Instalación interactiva para el ventanal del **AI & Cybersecurity Lab**. Una cámara detecta a las personas que pasan y una pantalla las reconstruye como siluetas vivas hechas de partículas.

> La inteligencia artificial no está reproduciendo un video de ti. Está interpretando tu presencia.

- El video de la cámara **nunca** se muestra, se guarda ni se envía a ningún lado.
- Todo corre en local, en una sola computadora, sin backend.

El análisis técnico y de UX detrás de las decisiones está en [docs/ANALISIS.md](docs/ANALISIS.md).

---

## Requisitos

| | |
| --- | --- |
| Node.js | 22.12 o superior |
| Navegador | Chrome o Chromium reciente (objetivo único) |
| Cámara | USB o integrada, 720p |
| GPU | Recomendada; hay fallback automático a CPU |

## Instalar y ejecutar

```bash
npm install
```

```bash
npm run dev
```

Abre `http://localhost:5180`, permite el acceso a la cámara y colócate frente a ella.

`npm install` copia dos instancias locales del runtime WASM de MediaPipe (segmentación y Pose). Ambos modelos están incluidos en `public/models`, junto con dos segmentadores alternativos (`selfie_segmenter` cuadrado y `deeplab_v3`) que se pueden probar sin recompilar con `?vision.modelPath=…`. No se necesita internet para ejecutar.

> Para calibrar en el equipo de la instalación, [`PRUEBAS.md`](PRUEBAS.md) tiene todas las URLs
> listas para copiar y pegar, en orden, con qué mirar en cada una. Si se trabaja con Claude Code en
> ese mismo equipo, [`BRIEFING.md`](BRIEFING.md) tiene el mensaje inicial que lo pone en contexto.

### Modos útiles

| URL | Qué hace |
| --- | --- |
| `/?mock=true` | Siluetas sintéticas: prueba la experiencia sin cámara ni personas. El guion de 36 s tiene una persona que entra, una segunda y luego una tercera (modo pareja → colectivo) |
| `/?debug=true` | Panel técnico: cámara, máscara, cajas, FPS, inferencia, partículas, progreso de formación, núcleo/estela/borde, modo de grupo y estado |
| `/?calibrate=true` | Debug + cámara, máscara, Pose, ROI y controles técnicos persistibles |
| `/?mock=true&debug=true` | Ambos |

**Teclado en debug:**

| Tecla | Acción |
| --- | --- |
| `1` | Simula "mano levantada" |
| `2` | Simula "dos manos arriba" |
| `3` | Simula "mano levantada" de las dos primeras siluetas a la vez (resonancia de ondas) |
| `D` | Oculta o muestra el panel |
| `F` | Pantalla completa (disponible también fuera de debug, o con doble clic) |

## Seleccionar cámara

Por defecto se usa la cámara del sistema. Para elegir otra:

```text
http://localhost:5180/?camera=Logitech   # por fragmento del nombre
http://localhost:5180/?camera=1          # por índice
```

Con `?debug=true` el panel lista las cámaras disponibles con su índice. También puede fijarse en `src/config.ts` (`camera.deviceLabel` o `camera.deviceIndex`).

## Configuración

Todo vive en [`src/config.ts`](src/config.ts). No hay números mágicos repartidos por el código.

| Sección | Qué controla |
| --- | --- |
| `displayProfile` | Preset de salida `standard` o `large`; LARGE sólo aplica overrides puntuales sobre la misma arquitectura |
| `camera` | Resolución, cámara, espejo, encuadre (`cover`/`contain`), recorte útil (`crop`), reintentos |
| `vision` | FPS independientes de segmentación/Pose, ancho, `cropAtCapture`, delegado GPU/CPU, umbrales, suavizado, área mínima, `maxPeople`, watchdog y fallback |
| `hands` | Dedos: modelo, ritmo, recortes guiados por Pose, alcance mínimo, grosor de dedos, mezcla con la máscara general y caducidad |
| `gestures` | Visibilidad, margen, suavizado, histéresis, tiempos mínimos y gracia de ausencia |
| `proximity` | Qué tamaño aparente cuenta como lejos o cerca |
| `particles` | Pool y densidad; fases de movimiento (formación, tracking, movimiento rápido, departure); predicción e interpolación; presencia magnética; idle; onda de mano; reveal y vuelo de partículas al texto y a la marca. Subsecciones `formationWow`, `livingBody` y `groupInteraction` |
| `layout` | Columnas de espacio negativo para el texto, franja superior, umbral de ocupación e histéresis |
| `experience` | Tiempos de la narrativa: saludo, instrucciones, `instructionTimeout`, `gestureCooldown`, gracia de ausencia, marca |
| `texts` | Todos los textos en pantalla |
| `branding` | `showBranding`, `brandName`, `labName`, `tagline`, `logoEnabled`, `logoPath` |
| `privacy` | `showPrivacyNotice`, frecuencia y duración del aviso |
| `typography` | Escala global del texto |
| `kiosk` | Ocultar cursor, wake lock, recarga preventiva |

**Sin recompilar.** Cualquier valor se puede sobrescribir desde la URL usando su ruta, lo que sirve para calibrar en sitio:

```text
/?vision.maskThreshold=0.5&vision.minPersonArea=0.01
/?typography.scale=2.2&particles.particleSpacing=11
/?camera.crop={"x":0,"y":0.15,"width":1,"height":0.85}
/?experience.showDetectedMessage=false&branding.showBranding=false
/?displayProfile=large
```

### Calibración de cámara y pantalla en sitio

Abrir `/?calibrate=true&displayProfile=large`. El panel muestra a la vez **CAMERA FRAME + ACTIVE CROP** y **PROCESSED MASK**. También separa:

- captura solicitada vs. resolución/FPS realmente entregados por la webcam;
- bitmap que entra al worker vs. resolución de la máscara que devuelve el modelo;
- FPS de cámara, segmentación y render;
- `inferenceMs`, procesamiento de máscara y Pose por separado;
- pipeline captura → resultado, marcado explícitamente como distinto de motion-to-photon;
- cajas, `personId`, área, proximity, celdas activas, BODY particles, densidad efectiva, thresholds y presupuesto.

Esto permite distinguir una imagen de cámara ya pobre (pocos píxeles, foco, blur o exposición) de una cámara clara cuya máscara se rompe.

**Orden recomendado:**

1. Confirmar que *entregada* coincide razonablemente con la captura solicitada. Si se pidió 1920×1080@60 pero llega 1280×720@30, resolver cámara/USB/driver antes de tocar la máscara.
2. Ajustar el crop amarillo para quitar techo, piso, reflejos y zonas inútiles. El cuerpo debe ocupar la mayor fracción posible sin cortar manos ni pies.
3. Comparar los presets de inferencia 320, 480 y 640. Esperar 10–15 s en cada uno y anotar FPS, `inferenceMs`, resolución de máscara, estabilidad quieta y estabilidad caminando. Hay siempre un solo frame en vuelo.
4. Preferir 480 como punto de partida. Usar 640 sólo si mejora visiblemente el contorno **sin** bajar demasiado segmentation FPS ni aumentar el lag al caminar. Si la máscara de salida no cambia de resolución, subir el bitmap puede aportar poco.
5. Ajustar threshold e hysteresis juntos. Bajar threshold sin control admite fondo; aumentar un poco hysteresis/release conserva una extremidad ya vista durante decenas de ms.
6. Ajustar `minPersonArea` al sujeto de 4 m y verificar después que sombras/reflejos no se conviertan en personas.
7. Finalmente ajustar spacing, tamaño, opacidad y borde. Los efectos no deben usarse para esconder una máscara rota.

Los valores guardados por el panel son overrides finales y por ello prevalecen sobre el preset. Para comparar STANDARD y LARGE sin una calibración anterior, usar **RESTABLECER** primero.
El mismo panel ofrece presets de solicitud 1280/1920/3840, 720/1080/2160 y 30/60 fps; son valores `ideal`, no una garantía de la webcam.

#### Preset LARGE inicial

`?displayProfile=large` cambia únicamente estos valores; STANDARD conserva exactamente los defaults:

| Grupo | LARGE | Intención |
| --- | --- | --- |
| Visión | width 480; threshold 0.56; hysteresis 0.22; release 90 ms; min area 0.15%; poseFPS 10 | Más señal débil y una pérdida aislada tolerada, sin fantasmas largos; Pose sólo alimenta gestos y no le disputa la GPU a la silueta |
| Densidad | spacing 5.2; BODY budget 19 000; far/close 1.0 | No adelgazar a la persona lejana; multipersona sigue limitado por presupuesto |
| Latencia | prediction 50 ms; max 40 px | La pared es grande y la cámara está lejos: el adelanto en píxeles crece con ellas |
| Punto | idle 1.9; far 2.75; close 3.05 | Más presencia en LED sin volver la silueta sólida |
| Contorno | threshold 0.47; hysteresis 0.08; size ×1.12; brightness ×1.48 | Cabeza, hombros y extremidades legibles sin dibujar un outline |
| Continuidad | occlusion grace 150 ms | BODY→BODY y `personId` se conservan durante omisiones breves |
| Texto | scale 1.18 | Lectura inicial de gran formato; calibrar a distancia real |

No se añadió un threshold automático por proximity: con reflejos y varias personas sería difícil de predecir. LARGE usa valores explícitos y ajustables; la histéresis temporal sólo favorece píxeles ya presentes.

#### Protocolo obligatorio 1–4 m

Hacer una fila por distancia y preset, anotando los valores del panel:

| Distancia | Preset | Área | Celdas | BODY | Cámara FPS | Seg. FPS | Inferencia ms | Observación en movimiento |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 m | 320/480/640 | | | | | | | quieto, lateral, brazo, dos manos, giro |
| 2 m | 320/480/640 | | | | | | | quieto, lateral, brazo, dos manos, giro |
| 3 m | 320/480/640 | | | | | | | quieto, lateral, brazo, dos manos, giro |
| 4 m | 320/480/640 | | | | | | | quieto, lateral, brazo, dos manos, giro |

El criterio principal es 2.5–3 m caminando y levantando brazos. A 3–4 m deben permanecer cabeza, torso, brazos y postura general; no se exige detalle fino de dedos.

### Fluidez y alcance: dónde se va el tiempo

Tres cosas distintas se confunden en "va lagueado". El panel las separa:

| Línea del panel | Qué mide | Qué significa si está mal |
| --- | --- | --- |
| `cámara N fps medidos` | Frames que la webcam entrega de verdad | Menos de 25–30 es un problema de cámara, no de código: normalmente poca luz (el autoexposure alarga la exposición) o un modo de captura lento |
| `captura N /s · X ms` | Coste del hilo principal por pedir el frame a la cámara | Si sube, el `render fps` baja aunque los modelos estén libres |
| `segmentación N fps · X ms` | Ritmo e inferencia de la silueta | Es el ritmo real del espejo |
| `pipeline A ms sensor→web · B ms web→partículas` | A: exposición, USB y buffers del driver (lo reporta la propia cámara). B: captura → partículas dibujadas | Si A es grande, el retraso está antes de que el código vea nada |
| `interpolación cada N ms · ventana W ms` | Hueco real entre máscaras y cuánto lo cubre la interpolación | Si `N` ≫ 33, el espejo avanza a saltos de N ms; la ventana debe cubrirlo |
| `render N fps · js X ms` | Dibujo y simulación | `js` alto con `captura` baja = demasiadas partículas |

Decisiones tomadas a partir de esas medidas:

- **Una sola captura por tick.** Cuerpo y Pose comparten el mismo `ImageBitmap`; sólo se copia el bitmap ya reducido cuando toca frame de Pose. Decodificar el video dos veces por tick era el trabajo más caro del hilo principal.
- **Capturar en cuanto llega el frame.** La captura la dispara `requestVideoFrameCallback`, no el `requestAnimationFrame` siguiente. Quita hasta un frame de espera y, sobre todo, el jitter de que cámara y pantalla vayan a ritmos distintos (el `rAF` queda de red de seguridad y no captura dos veces el mismo frame).
- **Ventana de interpolación adaptativa.** Entre máscaras el target avanza con la traslación estable del track. La ventana era fija (40 ms, pensada para 30 Hz): con una cámara a 8–15 fps la silueta se congelaba 60–130 ms de cada intervalo, que es exactamente la sensación de "va a escalones". Ahora la ventana es `intervalo real × interpolationIntervalFactor` (1.2), así que se ajusta sola y no cambia nada cuando la visión va a 30 Hz. Nunca extrapola más de un intervalo: un hueco mayor es pérdida de visión, no cadencia lenta.
- **Adelanto de 50 ms en LARGE.** El resto de la latencia se compensa prediciendo (`predictionMs`), acotado por `predictionMaxDistance`. Si la silueta se adelanta al frenar, `?particles.predictionMs=30`.
- **Pose a 10 fps en LARGE.** Alimenta gestos y nada más; a 15 fps le disputaba la GPU a la silueta.
- **Dedos sólo cuando hay mano que leer.** El análisis no corre si la mano es demasiado pequeña en el sensor; ver más abajo.

**Alcance.** El segmentador trabaja internamente a 256×144, y eso —no la cámara— es el techo del detalle. A 5 m con una webcam de ángulo ancho una persona ocupa ~15 px de esos 256: sale un bulto. Por eso:

- Subir `vision.inferenceWidth` no añade detalle, sólo suaviza el reescalado.
- Subir la resolución de la cámara tampoco: el modelo reduce igual.
- Lo que sí añade detalle es **recortar**. Con `vision.cropAtCapture` (activo por defecto) `camera.crop` deja de ser un filtro y pasa a ser un zoom: el recorte se toma del video al capturar, así que esos 256×144 se gastan sólo en la zona útil. La región capturada se expande hasta recuperar la proporción del encuadre —el segmentador redimensiona sin respetar el aspecto y una región estirada le deforma a las personas—, de modo que **sólo hay ganancia si el recorte reduce ancho y alto a la vez**. Lo que se ve sigue siendo exactamente `camera.crop`.

```text
/?camera.crop={"x":0.2,"y":0.1,"width":0.6,"height":0.6}   # ~1.6× de resolución de silueta
```

En hardware: lo que amplía el alcance no son megapíxeles sino **ángulo de visión más cerrado** (la persona ocupa más de esos 256×144) y **luz** (a 30 fps reales, no 15). `?mock=true` desactiva `cropAtCapture`: no hay cámara que recortar.

### Ajustes del equipo (Linux)

La latencia que el código no puede tocar está en la cámara, en el compositor y en la pared LED. Por orden de impacto medido:

1. **Cámara a 30 fps reales.** `v4l2-ctl -d /dev/video0 --list-formats-ext` dice qué modos existen y a qué ritmo; muchos webcams sólo dan 30 fps en MJPG. Con poca luz el autoexposure baja sola a 15 fps: `v4l2-ctl -d /dev/video0 -c auto_exposure=1 -c exposure_time_absolute=...` la fija. Se comprueba en `cámara N fps medidos`.
2. **Sin "Force Full Composition Pipeline" en NVIDIA.** Se suele activar para quitar tearing y añade un frame entero. `nvidia-settings` → X Server Display Configuration → Advanced.
3. **Pantalla completa real.** Un compositor de escritorio añade otro frame; en pantalla completa suele desactivarse solo. Chrome en `--kiosk` y sin barras.
4. **Comprobar `chrome://gpu`.** Rasterización y decodificación de video por hardware activas; si no, se paga en CPU.
5. **La pared LED también tarda.** Los procesadores/scalers añaden 1–3 frames y muchos traen un modo de baja latencia. Es la parte que `pipeline` no puede medir.

**Hardware.** 16 GB de RAM y una RTX 2070 Super sobran: el segmentador ocupa milisegundos de GPU y la simulación es de un solo hilo. Lo único que puede justificar una compra es la webcam, y por FPS estables en poca luz y ángulo de visión, no por megapíxeles.

### Detalle de silueta

La forma de cada persona sigue el contorno real de la máscara, no una cuadrícula de píxeles:

- **Contorno subpíxel.** El worker envía, junto con el mapa de siluetas, la confianza ya suavizada (0..255). `TargetField` la interpola en la posición exacta de cada celda. Así la retícula (`particleSpacing` 5.5 px de referencia) puede ser más fina que un píxel de máscara (~6 px a 1080p) sin escalones.
- **Borde sobre el contorno.** Cada celda de borde se desplaza sobre el gradiente de confianza hasta `silhouette.contourThreshold` (0.5), con tope `maxSnap`. El borde no usa jitter y flota apenas (`livingBody.edgeFloat`). Tiene brillo extra con `edgeBrightness`.
- **Sin parpadeo.** Cada celda tiene histéresis propia (`contourHysteresis`).
- **Densidad.** STANDARD usa `particleCount` 24 000 y `bodyParticleBudget` 15 000; LARGE sube el presupuesto a 19 000. Ambos conservan densidad far/close 1.0. Si varias personas superan el presupuesto, sólo se aclara el interior: el contorno se conserva (`silhouette.protectEdges`).

| Escena simulada (1080p, pipeline máscara → partículas) | Antes | Ahora |
| --- | --- | --- |
| Partículas por silueta de cuerpo completo | ~1 600 | ~4 600 |
| Tres personas: partículas de cuerpo | ~4 900 | ~13 800 |
| Tres personas: JS de simulación por frame | ~2 ms | ~4.5 ms (+ ~1.1 ms de máscara → retícula en promedio) |

En Chrome con `?mock=true` se midieron 3–4 ms de JS por frame con 1–3 personas. En equipos lentos se puede bajar el costo sin recompilar: `?particles.particleSpacing=6.5&particles.bodyParticleBudget=10000`. Si antes se guardó calibración con `?calibrate=true`, el `particleSpacing` guardado reemplaza el nuevo valor: usa *RESTABLECER* en el panel.

### Dedos y manos

La máscara general de toda la escena no tiene resolución suficiente para un dedo lejano (su tamaño real se ve en calibración): a 2 m, un dedo puede medir menos de un píxel ahí y la mano sale como un bulto. Los dedos se resuelven aparte, en alta resolución:

1. **Dónde mirar.** Pose da la muñeca de cada mano; de ahí sale un recorte 16:9 alrededor de ella (`roiPalmScale`, `roiShoulderScale`, acotado entre `roiMinPx` y `roiMaxPx`). Si ya hubo una mano hace poco, el encuadre lo dan sus 21 puntos (`roiHandScale`, `trackReuseMs`), que son más precisos que Pose.
2. **Qué se analiza.** El recorte se toma del video a resolución completa y se escala a `cropWidth`×`cropHeight`. Sobre él corren **Hand Landmarker** (21 puntos) y, si `segmentation` está activo, el **mismo segmentador** de siluetas: la forma real de la mano.
3. **Cómo se dibuja.** Los 21 puntos construyen cápsulas de dedos, pulgar, palma y antebrazo (`fingerRadius`, `thumbRadius`, `forearmRadius`). La segmentación del recorte sólo cuenta cerca de ese esqueleto (`segmentationGate`), así que una mancha del fondo no engorda la mano. Un dedo nunca es más fino que la retícula (`minFingerWidthCells`).
4. **Dónde manda.** La mano reemplaza a la máscara general sólo alrededor de los dedos (`patchReach`, `patchFeather`); más allá —antebrazo, cuerpo— manda la máscara general, así que la mano nunca se separa del brazo. El contorno de los dedos también se ajusta con precisión subpíxel.
5. **Nunca se congela.** Cada observación caduca sola entre `fadeStartMs` y `maxAgeMs`: si el análisis se atrasa o pierde la mano, los dedos se funden con la silueta en lugar de quedarse pegados donde estaban.

**Sólo cuando hay mano que leer.** Medido en la instalación con personas a 3–8 m, el análisis costaba ~250 ms de GPU por tanda y aplicaba **cero** celdas de dedo, mientras le robaba frames a la silueta. Por eso hay un alcance mínimo: si el recorte natural de la mano no llega a `minHandPx` píxeles de cámara, no se analiza y no cuesta nada. El umbral está en píxeles de sensor a propósito — con una cámara de más resolución o de ángulo más cerrado, el mismo número alcanza más lejos sin tocar nada. Cuando el presupuesto no da para todas las manos visibles, se analizan **las más grandes**, que son las que tienen dedos legibles. El panel muestra cuántas quedaron fuera (`N lejos`).

**Aislado del cuerpo.** Todo esto vive en su propio worker (`hands.worker.ts`). Si se atrasa, falla o el equipo no da, la segmentación del cuerpo no pierde ni un frame; tras tres fallos seguidos los dedos se apagan por el resto de la sesión.

**Alcance real.** Los dedos dependen de cuántos píxeles de cámara ocupa la mano: con 1280×720 son nítidos hasta ~1.5 m y se degradan hacia ~2.5 m; más allá el Hand Landmarker deja de encontrar la mano y la silueta vuelve al bulto de siempre. Subir la resolución de cámara o cerrar el ángulo amplía ese rango, y el filtro `minHandPx` se mueve con él automáticamente. Si con la cámara nueva los dedos aparecen más lejos de lo que el umbral deja pasar, se baja sin recompilar: `?hands.minHandPx=90`.

### Mirror feel: fases de movimiento

Cada partícula del cuerpo usa tiempos distintos según su fase. El panel `?debug=true` muestra cuántas hay en cada una.

| Fase | Cuándo | Parámetros principales | Carácter |
| --- | --- | --- | --- |
| **INITIAL FORMATION** | La persona acaba de llegar | `particleAttraction` 0.16, `particleDamping` 0.6, `formationDuration` 660 ms, `formationStagger` 0.4, `formationMaxSpeed` 26, `formationWow.*` | Anticipación → colapso → lock (ver *Formation WOW*) |
| **NORMAL TRACKING** | Cuerpo formado (`bond` > `trackingBondThreshold`) | `trackingAttraction` 0.5, `trackingDamping` 0.42, `trackingSnap` 0.32, `maxSpeed` 64 | Espejo: resorte firme + acercamiento directo sin overshoot |
| **FAST MOTION** | Track rápido (`fastMotionSpeed` 90→700 px/s) o transporte reciente (`trackingResponseMs` 120 ms) | `fastMotionAttraction` 0.7, `fastMotionDamping` 0.34, `fastMotionSnap` 0.5 | Todo el núcleo pegado al cuerpo; la estela es visual (`livingBody`) |
| **DEPARTURE** | El track desapareció | `occlusionGraceMs` 120, `departureLetGoMs` 70, `departureStaggerMs` 480, `dispersionDuration` 1750 | Momentum → desprendimiento escalonado → dispersión → campo |

**Caminar.** Cuando la silueta se traslada, toda la propiedad de celdas se desplaza a la vez: cada partícula recorre sólo el movimiento real del cuerpo, en lugar de cruzar del borde trasero al delantero. La traslación se mide con los bordes de la silueta, así que levantar o extender un brazo no la dispara. Medido a 540 px/s: lag medio de 24.6 px → 5.0 px y peor partícula de 101 px → 5 px, sin overshoot al detenerse.

**Predicción e interpolación.** Ambas usan la velocidad de traslación rígida, sólo con tracks estables (`predictionStableFrames`) y con tope `predictionMaxDistance`.
- `predictionMs` (30 ms) adelanta el target; se atenúa al girar (`predictionTurnCosine`), se corta proporcionalmente al frenar (`predictionBrakeRatio`) y se apaga al invertir la dirección. Crece suave (`predictionRiseMs`) y se reduce de inmediato. En vertical pesa `predictionVerticalFactor` (0.35).
- `interpolationMaxMs` (40 ms) avanza el target entre frames de visión, para que el cuerpo no avance a escalones de 30 Hz.
- `?particles.predictionMs=0&particles.interpolationMaxMs=0` desactiva ambas.

**Afinar con la cámara real** (`?calibrate=true`: caminar, detenerse, cambiar de dirección, mover brazos):

1. Si el cuerpo queda atrás pero estable, subir `trackingSnap` hacia 0.4; si tiembla, bajarlo hacia 0.25.
2. Si se adelanta al detenerse, bajar `predictionMs` a 15–20 o ponerlo en `0`.
3. Si al caminar avanza a saltos, subir `interpolationMaxMs` hacia 50; si se adelanta, bajarlo.
4. Si el contorno deja una estela, bajar `vision.smoothingReleaseMs` hacia 50–60 ms; si parpadea, subirlo hacia 75–90 ms.
5. Si los brazos rápidos se quedan atrás, subir `fastMotionSnap` o `trackingResponseMs`.
6. Verificar motion-to-photon con video externo: `pipeline` mide captura → resultado y no incluye pantalla ni cámara físicas.

### Formation WOW

La formación de cada persona (por `personId` temporal, así una segunda persona también tiene su entrada) sigue tres fases sobre el sistema existente:

1. **Anticipation.** En cuanto el segmentador ve una silueta aún no confirmada, el campo cercano ya se curva hacia ella (`pendingAttraction`, `anticipationCurl`) y brilla levemente. Al confirmarse, la atracción sube (`anticipationBoost`).
2. **Collapse.** Las partículas convergen en arco (`collapseCurl`) con un retraso que mezcla azar y distancia al centro del cuerpo (`radialStagger`): el torso se reconoce antes que las extremidades. Mientras esperan su turno ya se acercan (`waitingAttraction`) y brillan a mitad de viaje (`collapseGlow`).
3. **Lock.** Cuando `lockThreshold` (80 %) del cuerpo está formado, el resto acelera (`lockSpeedup`), hay un pulso breve (`lockGlow`) y el giro del campo se apaga (`curlReleaseMs`). A partir de ahí las celdas nuevas casi no esperan (`lockedStaggerScale`): la silueta crece como espejo.

El target es siempre la celda actual: si la persona entra caminando, las partículas convergen hacia donde está, no hacia donde fue detectada. Medido en simulación a 1920×1080: lock a ~780 ms desde el campo ambiental.

### Living body

El núcleo sigue su target exactamente igual que antes; encima se aplica un **offset visual** que nunca modifica la celda, el target ni la posición física. Una prueba verifica que las posiciones del núcleo son idénticas con y sin efectos.

- **Microestela** (`trailRatioEdge` 30 % del borde, `trailRatioInterior` 3 % del interior): con velocidad local alta (`trailSpeed` 220→1000 px/s), la partícula conserva `trailInertia` de su posición en el mundo y regresa en ~`trailDurationMs` (200 ms), con tope `trailMaxDistance`.
- **Desprendimiento de borde** (`shedRatio` 14 % del borde): además se abre en arco (`shedForce`, `shedDurationMs`, `shedMaxDistance`) y vuelve al cuerpo. No se convierte en partícula ambiental ni resta densidad.
- **Cuerpo quieto**: el temblor ahora es visual; el interior casi no se mueve (`interiorNoise`) y el borde flota lento (`edgeFloat`, `edgeFloatSpeed`).
- En total, alrededor del 90 % del cuerpo queda como núcleo espejo. Al volver al campo, el offset se integra a la posición y no hay saltos.

### Group mode

`GroupInteraction` es lógica pura y determinista. Usa sólo los `personId` temporales, sin identidad persistente.

| Personas estables (`stableMs`, `dropGraceMs`) | Modo | Qué se ve |
| --- | --- | --- |
| 1 | single | Comportamiento normal |
| 2 | pair | Una corriente curva y sutil de partículas del campo entre ambas (`pairStrength`, `pairParticleBudget`) |
| 3+ | collective | Hasta `maxConnections` corrientes (primero conecta a todos y luego agrega los pares más cercanos), pequeños nodos que giran (`nodeRatio`) y el campo completo más activo (`collectiveAmbientDrift`, `collectiveTwinkle`) |

- **Sin saltos.** El modo cambia con histéresis (`enterMs`, `exitMs`). Cada conexión conserva su lugar mientras exista su par, su fuerza sube y baja con `strengthAttackMs`/`strengthReleaseMs`, sus extremos siguen a las personas con `positionSmoothingMs` y un par ya conectado se prefiere al elegir (`selectionStickiness`).
- **Proximidad.** La fuerza va de plena a cero entre `connectionDistance.near` y `.far`, sin un switch duro. El movimiento relativo del par acelera la corriente (`relativeSpeedBoost`).
- **Presupuesto.** Sólo se reclutan partículas ambientales cercanas a la corriente, con un barrido acotado por frame (`recruitScanPerFrame`). Si faltan, aparecen unas pocas (`spawnPerFrame`). Los cuerpos nunca ceden partículas y la población ambiental no las cuenta.
- **Resonancia.** Si dos personas hacen ONE_HAND_UP dentro de `resonanceWindowMs` (700 ms) con el grupo activo, las ondas se encuentran a mitad de camino: brillo breve, dispersión controlada del campo y un pequeño pulso de partículas. Sin texto. El cooldown de gestos ahora es por persona.
- `?particles.groupInteraction.enabled=false` desactiva todo el modo.

### Texto en el espacio negativo

Con personas presentes, el texto nunca va abajo ni encima del cuerpo. Al aparecer cada mensaje, `NegativeSpaceLayout` mide cuánto ocupan las siluetas las columnas laterales (`layout.sideColumnWidth`) y una franja superior, y elige el espacio libre con histéresis (`layout.switchMargin`). Un texto visible nunca cambia de lugar.

- Las instrucciones que piden levantar las manos nunca van arriba, porque ahí van a estar las manos.
- Saludo, título y marca pueden subir a la franja superior si ambas columnas están ocupadas.
- Sin personas (ACÉRCATE, marca de salida) el texto va al centro.

### Gestos, reveal y marca

- **ONE_HAND_UP:** onda orgánica acotada a `waveMaxRadius` alrededor de la mano detectada, con brillo leve (`waveGlow`). Se ancla a la persona y la acompaña si camina.
- **BOTH_HANDS_UP:** expansión (`revealExpandMs`) → suspensión (`revealSuspendMs`) → un `textParticleRatio` (20 %) del cuerpo viaja al título → **COMPUTER VISION** → regreso. Esas partículas conservan su celda, así que el tracking nunca se detiene.
- **Marca:** al terminar el reveal, las mismas partículas pasan del título a **ANÁHUAC CANCÚN** (`brandTravelMs`) y después vuelven al cuerpo.
- **Legibilidad:** sólo los textos grandes reciben partículas, más tenues y pequeñas (`textParticleAlpha`, `textParticleSize`). El DOM y el muestreo comparten tipografía y cortes de línea, así que las partículas caen sobre las letras reales.

## Pantalla completa y modo kiosko

**Para probar:** presiona `F` o haz doble clic.

**Para la instalación permanente:**

1. Servir el build de producción:

   ```bash
   npm run build
   ```

   ```bash
   npm run preview
   ```

   Queda disponible en `http://localhost:4180`. También puede servirse `dist/` con cualquier servidor estático en `localhost`.

2. Abrir Chrome en modo kiosko. En macOS:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --kiosk --no-first-run --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream http://localhost:4180
   ```

   En Windows y Linux se usan las mismas banderas con el ejecutable de Chrome o Chromium.

   `--use-fake-ui-for-media-stream` concede la cámara sin mostrar el diálogo. Úsalo **sólo** en la computadora dedicada a la instalación.

3. **Arranque automático:**
   - macOS: un LaunchAgent o Ítems de inicio con un script que levante el servidor y luego Chrome.
   - Windows: el Programador de tareas, "Al iniciar sesión".
   - Linux: un servicio de usuario de systemd, con `Restart=always`.

4. **Sistema operativo:** desactivar suspensión, protector de pantalla y actualizaciones automáticas en horario de uso.

La aplicación ya:

- oculta el cursor;
- bloquea scroll, zoom y menú contextual;
- mantiene la pantalla encendida (wake lock);
- se recupera sola de pérdidas de cámara, del worker o del contexto WebGL;
- se recarga cada 12 h, sólo cuando nadie está frente a ella.

## Arquitectura

```text
Cámara ─▶ CameraManager ─▶ ImageBitmap 320/480/640 ─┐
                                               ▼
                         ┌──────── Web Worker (vision.worker.ts) ────────┐
                         │ PersonSegmenter  (MediaPipe ImageSegmenter)   │
                         │ PoseLandmarkerRunner (10–20 FPS configurable) │
                         │ MaskProcessor    blur → suavizado temporal →  │
                         │                  histéresis → componentes →   │
                         │                  área mínima → proximidad     │
                         └───────────────┬───────────────────────────────┘
                                         │ personMap + personas + pose transitoria
                                         ▼
requestAnimationFrame ─▶ TargetField ─▶ ParticleSystem ─▶ Renderer (WebGL2)
                              │
                              └─▶ Experience (máquina de estados) ─▶ overlays
                                        ▲
             GestureRecognizer ─▶ InteractionManager ┘  ◀── GestureEvents
```

```text
src/
  config.ts                 configuración central
  main.ts
  core/
    App.ts                  orquestador: un solo requestAnimationFrame
    StateMachine.ts         máquina de estados genérica
    Experience.ts           IDLE → PRESENCE → DEPARTURE, qué se dice y cuándo
    configOverrides.ts      overrides por URL y calibración técnica local
    configValidation.ts     rangos, clamps y defaults seguros
  vision/
    CameraManager.ts        permisos, selección, pérdida y reconexión de cámara
    CameraVisionSource.ts   captura, worker, reintentos, fallback GPU → CPU
    vision.worker.ts        todo lo que toca píxeles vive aquí
    PersonSegmenter.ts      MediaPipe ImageSegmenter
    PoseLandmarkerRunner.ts MediaPipe Pose Landmarker (mismo worker/frame)
    WorkerRecoveryPolicy.ts circuito GPU → CPU sin oscilación
    MaskProcessor.ts        limpieza de máscara y siluetas (código puro)
    HandTracker.ts          recortes de mano guiados por Pose y observaciones
    hands.worker.ts         Hand Landmarker + segmentación del recorte (worker aparte)
    handGeometry.ts         recortes, esqueleto de la mano y distancias (código puro)
    handsProtocol.ts        contrato del worker de manos
    MockVisionSource.ts     siluetas y manos sintéticas para desarrollo
    protocol.ts, types.ts   contratos
  particles/
    TargetField.ts          máscara + confianza → retícula estable con contorno subpíxel
    ParticleSystem.ts       física, formación, dispersión, ondas, offset vivo, corrientes
    FormationTracker.ts     formación por persona: inicio, progreso y lock
    GroupInteraction.ts     personas estables, modo, pares, fuerza y presupuesto (puro)
    FlowField.ts            campo de ruido orgánico para el ambiente
  render/
    Renderer.ts             WebGL2, un draw call de puntos
  interaction/
    GestureEvents.ts        contrato de gestos
    GestureRecognizer.ts    landmarks → flancos ONE_HAND_UP/BOTH_HANDS_UP
    InteractionManager.ts   gesto → reacción visual + narrativa
    GestureResonance.ts     ONE_HAND_UP casi simultáneo de dos personas
  ui/
    InstructionOverlay.ts   mensajes con prioridad, timeout y fundido
    BrandOverlay.ts
    PrivacyNotice.ts
    DebugPanel.ts           sólo existe con ?debug
    CalibrationPanel.ts     controles de instalación con ?calibrate=true
  utils/
    PerformanceMonitor.ts, MathUtils.ts, noise.ts, Kiosk.ts
```

### Decisiones clave

- **Visión en un Web Worker.** Segmentación y Pose consumen el mismo `ImageBitmap`; Pose corre a menor frecuencia. Hay un solo frame en vuelo: si el modelo se atrasa se descartan capturas, en lugar de acumular latencia. Los buffers de máscara se reciclan entre hilos.
- **Gestos por flanco.** Mantener una mano arriba no repite el evento. Bajarla rearma el gesto; la ausencia breve conserva el estado.
- **Fallback estable.** Varios fallos GPU reinician el worker y fijan CPU durante el resto de la sesión, sin alternar delegados.
- **WebGL2 directo, no Three.js ni PixiJS.** Es una sola primitiva (puntos suaves con mezcla aditiva) en un solo draw call. Una librería de escena no aporta nada aquí y Canvas 2D no escala a miles de puntos suaves en pantallas grandes.
- **Retícula estable con transporte temporal.** Cada partícula conserva celda y `personId` mientras son válidos. Cuando cambia la postura, los BODY sin celda se reasignan primero a targets del mismo track usando desplazamiento y vecindad espacial; sólo se recurre al ambiente después. Posición, velocidad, `bond`, vida y brillo sobreviven al cambio.
- **Predicción conservadora.** La velocidad filtrada del track adelanta el target unos milisegundos, con estabilidad mínima, límite espacial y corte por salto/reversión. No es optical flow ni reconocimiento de identidad.
- **Reveal sin congelar el cuerpo.** BOTH_HANDS_UP expande y suspende parcialmente el resorte; una fracción pequeña de BODY particles refuerza la tipografía y regresa a su celda mientras el resto mantiene tracking.
- **Sin React.** No hay estado de UI que lo justifique.

### Estados

| Estado | Pantalla |
| --- | --- |
| **IDLE** | Campo lento con profundidad (cada partícula tiene tamaño, brillo y deriva según su profundidad). "ACÉRCATE" aparece y se desvanece cada `idlePromptIntervalMs`. Aviso de privacidad periódico. |
| **PRESENCE** | El campo nota la presencia, converge y forma la silueta (anticipación → colapso → lock). Con dos o más personas, el espacio entre ellas se activa (Group mode). "TÚ ERES EL INPUT" → "LEVANTA UNA MANO" → "AHORA PRUEBA CON LAS DOS" → "COMPUTER VISION" → marca. Después, modo libre: sin instrucciones y con los gestos activos. El campo cercano reacciona muy sutilmente al movimiento. |
| **DEPARTURE** | Momentum → desprendimiento escalonado → dispersión → campo ambiental. Si hubo interacción, aparece la marca al centro. Luego vuelve a IDLE. |

Pérdidas breves de detección (menos de 900 ms) no cuentan como salida. Si la persona regresa en menos de 8 s, la secuencia continúa sin repetir el saludo.

## Privacidad

- **Qué se almacena: nada personal.** Ni frames, capturas, video, landmarks ni identificadores se escriben en almacenamiento. Cada imagen se cierra al terminar el frame.
- **Qué sale del worker.** Un mapa de siluetas y su confianza (de baja resolución y con dimensiones visibles en calibración, sin imagen), cajas anónimas y landmarks transitorios para gesto/debug.
- **Manos.** Los recortes de mano se analizan en memoria y se cierran en el mismo frame; sólo salen 21 puntos y la confianza del recorte, sin imagen. No se guardan ni salen del navegador. No hay identificación biométrica: un punto de dedo no identifica a nadie y se descarta al perder la mano. No salen del navegador ni se persisten.
- **Red.** No hay conexiones de red: el documento declara una CSP con `connect-src 'self'`, y el modelo y el runtime se sirven localmente.
- **Reconocimiento facial.** No existe. Los ids de silueta sólo dan continuidad entre frames consecutivos y se descartan al perder a la persona.
- **En producción** no se muestra ninguna imagen de cámara. El video sólo es visible con `?debug=true`.

## Limitaciones conocidas

- **Personas lejanas.** El segmentador de MediaPipe está entrenado para distancias de selfie y videollamada: más allá de ~3–4 m pierde definición. El techo es su tensor interno de 256×144, no la cámara: la única forma real de ganar detalle a distancia es que la persona ocupe más de esos 256×144 (recorte de captura, óptica más cerrada o acercar la cámara).
- **Personas juntas.** Dos personas que se tocan se funden en una silueta. Es segmentación semántica, no por instancias.
- **Multipose.** Se solicitan hasta cuatro poses, pero el modelo lite puede perder personas lejanas, ocluidas o muy juntas; la máscara sigue siendo semántica y no se asigna como instancia perfecta.
- **Dedos a distancia.** El Hand Landmarker necesita que la mano ocupe suficientes píxeles: más allá de ~2.5 m con 1280×720 deja de encontrarla y la mano vuelve a verse como un bulto. Los dedos dependen además de Pose: si no ve la muñeca, no hay recorte que analizar.
- **Reflejos del vidrio.** Pueden generar siluetas falsas, sobre todo de noche. Se mitiga con `crop`, área mínima y la instalación física de la cámara (ver análisis).
- **Perfil LARGE es un punto de partida.** La óptica, pitch físico, resolución del controlador LED y distancia de lectura todavía requieren calibración en sitio.
- **Cámara por debajo de sus FPS.** Con poca luz la webcam alarga la exposición y entrega 14–19 fps en vez de 30; el espejo no puede ir más fluido que eso. Se ve en `cámara N fps medidos` y se corrige con luz o fijando la exposición (`v4l2-ctl` en Linux), no con código.
- **Mediciones pendientes con cámara real.** Los tiempos de inferencia se midieron con frames sintéticos: falta confirmar la latencia completa cámara → partículas.
- **Navegador.** Sólo se prueba en Chrome/Chromium.

## Verificación

`npm test` (87 pruebas), `npm run typecheck` y `npm run build` validan lógica pura, contratos TypeScript y bundle de producción. Las pruebas cubren, entre otras cosas, STANDARD/LARGE y sus rangos, retención corta de extremidades sin fantasmas, traslación de la silueta al caminar sin overshoot, predicción ante brazos/frenado/giro, departure escalonado, reveal sin pérdida de tracking, elección de espacio negativo, lock de formación por persona, estela visual sin alterar el núcleo espejo, contorno subpíxel, protección del contorno ante el presupuesto, manos, recortes, la región de captura (zoom sin deformar y sin mover lo que se ve) la ventana de interpolación (cubre el hueco real de visión y nunca extrapola más de un intervalo) y el alcance mínimo de las manos (no analiza lo que no tiene dedos, y sube con la resolución de la cámara). La medición motion-to-photon sigue siendo una prueba física externa con video de alta velocidad.

## Créditos y licencias

- **Runtime y modelos.** MediaPipe Tasks Vision, `selfie_segmenter_landscape`, `pose_landmarker_lite` y `hand_landmarker` de Google (Apache 2.0; ver sus model cards). Los tres modelos se sirven localmente desde `public/models/`.
- **Tipografías.** Geist y Geist Mono (SIL Open Font License), vía Fontsource.
