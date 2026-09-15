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

`npm install` copia dos instancias locales del runtime WASM de MediaPipe (segmentación y Pose). Ambos modelos están incluidos en `public/models`. No se necesita internet para ejecutar.

### Modos útiles

| URL | Qué hace |
| --- | --- |
| `/?mock=true` | Siluetas sintéticas: prueba la experiencia sin cámara ni personas |
| `/?debug=true` | Panel técnico: cámara, máscara, cajas, FPS, inferencia, partículas y estado |
| `/?calibrate=true` | Debug + cámara, máscara, Pose, ROI y controles técnicos persistibles |
| `/?mock=true&debug=true` | Ambos |

**Teclado en debug:**

| Tecla | Acción |
| --- | --- |
| `1` | Simula "mano levantada" |
| `2` | Simula "dos manos arriba" |
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
| `camera` | Resolución, cámara, espejo, encuadre (`cover`/`contain`), recorte útil (`crop`), reintentos |
| `vision` | FPS independientes de segmentación/Pose, ancho, delegado GPU/CPU, umbrales, suavizado, área mínima, `maxPeople`, watchdog y fallback |
| `gestures` | Visibilidad, margen, suavizado, histéresis, tiempos mínimos y gracia de ausencia |
| `proximity` | Qué tamaño aparente cuenta como lejos o cerca |
| `particles` | Pool y densidad; fases de movimiento (formación, tracking, movimiento rápido, departure); predicción e interpolación; presencia magnética; idle; onda de mano; reveal y vuelo de partículas al texto y a la marca |
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
```

**Calibración recomendada en el ventanal:**

1. Abrir con `?calibrate=true`.
2. Revisar la máscara con distintas luces (mañana, tarde, noche).
3. Ajustar `maskThreshold`, `minPersonArea` y `crop` hasta que reflejos y sombras dejen de aparecer.
4. Subir `typography.scale` hasta que el texto se lea a la distancia real.

### Mirror feel: fases de movimiento

Cada partícula del cuerpo usa tiempos distintos según su fase. El panel `?debug=true` muestra cuántas hay en cada una.

| Fase | Cuándo | Parámetros principales | Carácter |
| --- | --- | --- | --- |
| **INITIAL FORMATION** | La persona acaba de llegar | `particleAttraction` 0.16, `particleDamping` 0.6, `formationDuration` 780 ms, `formationMaxSpeed` 26 | Lenta y cinematográfica: el campo es atraído y se concentra en el cuerpo |
| **NORMAL TRACKING** | Cuerpo formado (`bond` > `trackingBondThreshold`) | `trackingAttraction` 0.5, `trackingDamping` 0.42, `trackingSnap` 0.32, `maxSpeed` 64 | Espejo: resorte firme + acercamiento directo sin overshoot |
| **FAST MOTION** | Track rápido (`fastMotionSpeed` 90→700 px/s) o transporte reciente (`trackingResponseMs` 120 ms) | `fastMotionAttraction` 0.7, `fastMotionDamping` 0.34, `fastMotionSnap` 0.5, estela `fastMotionTrailRatio` 12 % | Centro pegado al cuerpo con una estela muy leve |
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
Cámara ─▶ CameraManager ─▶ ImageBitmap 320×180 ─┐
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
    MockVisionSource.ts     siluetas sintéticas para desarrollo
    protocol.ts, types.ts   contratos
  particles/
    TargetField.ts          máscara → retícula estable en pantalla
    ParticleSystem.ts       física, formación, dispersión, ondas
    FlowField.ts            campo de ruido orgánico para el ambiente
  render/
    Renderer.ts             WebGL2, un draw call de puntos
  interaction/
    GestureEvents.ts        contrato de gestos
    GestureRecognizer.ts    landmarks → flancos ONE_HAND_UP/BOTH_HANDS_UP
    InteractionManager.ts   gesto → reacción visual + narrativa
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
| **PRESENCE** | El campo es atraído y forma la silueta. "TÚ ERES EL INPUT" → "LEVANTA UNA MANO" → "AHORA PRUEBA CON LAS DOS" → "COMPUTER VISION" → marca. Después, modo libre: sin instrucciones y con los gestos activos. El campo cercano reacciona muy sutilmente al movimiento. |
| **DEPARTURE** | Momentum → desprendimiento escalonado → dispersión → campo ambiental. Si hubo interacción, aparece la marca al centro. Luego vuelve a IDLE. |

Pérdidas breves de detección (menos de 900 ms) no cuentan como salida. Si la persona regresa en menos de 8 s, la secuencia continúa sin repetir el saludo.

## Privacidad

- **Qué se almacena: nada personal.** Ni frames, capturas, video, landmarks ni identificadores se escriben en almacenamiento. Cada imagen se cierra al terminar el frame.
- **Qué sale del worker.** Un mapa de siluetas de baja resolución, cajas anónimas y landmarks transitorios para gesto/debug. No salen del navegador ni se persisten.
- **Red.** No hay conexiones de red: el documento declara una CSP con `connect-src 'self'`, y el modelo y el runtime se sirven localmente.
- **Reconocimiento facial.** No existe. Los ids de silueta sólo dan continuidad entre frames consecutivos y se descartan al perder a la persona.
- **En producción** no se muestra ninguna imagen de cámara. El video sólo es visible con `?debug=true`.

## Limitaciones conocidas

- **Personas lejanas.** El segmentador de MediaPipe está entrenado para distancias de selfie y videollamada: más allá de ~3–4 m pierde definición.
- **Personas juntas.** Dos personas que se tocan se funden en una silueta. Es segmentación semántica, no por instancias.
- **Multipose.** Se solicitan hasta cuatro poses, pero el modelo lite puede perder personas lejanas, ocluidas o muy juntas; la máscara sigue siendo semántica y no se asigna como instancia perfecta.
- **Reflejos del vidrio.** Pueden generar siluetas falsas, sobre todo de noche. Se mitiga con `crop`, área mínima y la instalación física de la cámara (ver análisis).
- **Tamaños de texto.** Están calibrados para laptop. En la pantalla real hay que subir `typography.scale`.
- **Mediciones pendientes con cámara real.** Los tiempos de inferencia se midieron con frames sintéticos: falta confirmar la latencia completa cámara → partículas.
- **Navegador.** Sólo se prueba en Chrome/Chromium.

## Verificación

`npm test` (27 pruebas), `npm run typecheck` y `npm run build` validan lógica pura, contratos TypeScript y bundle de producción. Las pruebas cubren, entre otras cosas, la traslación de la silueta al caminar sin overshoot, la predicción ante brazos/frenado/giro, el departure escalonado, el reveal sin pérdida de tracking y la elección de espacio negativo. La medición motion-to-photon sigue siendo una prueba física externa con video de alta velocidad.

## Créditos y licencias

- **Runtime y modelos.** MediaPipe Tasks Vision, `selfie_segmenter_landscape` y `pose_landmarker_lite` de Google (Apache 2.0; ver sus model cards).
- **Tipografías.** Geist y Geist Mono (SIL Open Font License), vía Fontsource.
