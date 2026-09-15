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

`npm install` copia el runtime WASM de MediaPipe a `public/mediapipe/wasm`. El modelo de segmentación ya está incluido en `public/models`. No se necesita internet para ejecutar.

### Modos útiles

| URL | Qué hace |
| --- | --- |
| `/?mock=true` | Siluetas sintéticas: prueba la experiencia sin cámara ni personas |
| `/?debug=true` | Panel técnico: cámara, máscara, cajas, FPS, inferencia, partículas y estado |
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
| `vision` | `processingFPS`, ancho de inferencia, delegado GPU/CPU, `maskThreshold`, histéresis, suavizado, área mínima, `maxPeople`, confirmación de presencia |
| `proximity` | Qué tamaño aparente cuenta como lejos o cerca |
| `particles` | `particleCount`, `idleParticleCount`, `particleSpacing`, `particleDensity`, `particleSize`, `particleOpacity`, `particleNoise`, `particleAttraction`, `particleDamping`, `formationDuration`, `dispersionDuration`, onda de gesto |
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

1. Abrir con `?debug=true`.
2. Revisar la máscara con distintas luces (mañana, tarde, noche).
3. Ajustar `maskThreshold`, `minPersonArea` y `crop` hasta que reflejos y sombras dejen de aparecer.
4. Subir `typography.scale` hasta que el texto se lea a la distancia real.

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
                         │ MaskProcessor    blur → suavizado temporal →  │
                         │                  histéresis → componentes →   │
                         │                  área mínima → proximidad     │
                         └───────────────┬───────────────────────────────┘
                                         │ personMap (Uint8) + personas
                                         ▼
requestAnimationFrame ─▶ TargetField ─▶ ParticleSystem ─▶ Renderer (WebGL2)
                              │
                              └─▶ Experience (máquina de estados) ─▶ overlays
                                        ▲
                     InteractionManager ┘  ◀── GestureEvents (Fase 4)
```

```text
src/
  config.ts                 configuración central
  main.ts
  core/
    App.ts                  orquestador: un solo requestAnimationFrame
    StateMachine.ts         máquina de estados genérica
    Experience.ts           IDLE → PRESENCE → DEPARTURE, qué se dice y cuándo
    configOverrides.ts      overrides por URL
  vision/
    CameraManager.ts        permisos, selección, pérdida y reconexión de cámara
    CameraVisionSource.ts   captura, worker, reintentos, fallback GPU → CPU
    vision.worker.ts        todo lo que toca píxeles vive aquí
    PersonSegmenter.ts      MediaPipe ImageSegmenter
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
    InteractionManager.ts   gesto → reacción visual + narrativa
  ui/
    InstructionOverlay.ts   mensajes con prioridad, timeout y fundido
    BrandOverlay.ts
    PrivacyNotice.ts
    DebugPanel.ts           sólo existe con ?debug
  utils/
    PerformanceMonitor.ts, MathUtils.ts, noise.ts, Kiosk.ts
```

### Decisiones clave

- **Visión en un Web Worker.** La inferencia nunca bloquea el render. Hay un solo frame en vuelo: si el modelo se atrasa se descartan capturas, en lugar de acumular latencia. Los buffers de máscara se reciclan entre hilos.
- **WebGL2 directo, no Three.js ni PixiJS.** Es una sola primitiva (puntos suaves con mezcla aditiva) en un solo draw call. Una librería de escena no aporta nada aquí y Canvas 2D no escala a miles de puntos suaves en pantallas grandes.
- **Retícula estable.** Cada partícula es dueña de una celda fija de pantalla. Si la persona está quieta, nada se mueve salvo la "respiración". Al moverse, sólo migran las partículas de las celdas que cambian, hacia las más cercanas. Remuestrear la máscara en cada frame haría que la silueta "hierva".
- **Sin React.** No hay estado de UI que lo justifique.

### Estados

| Estado | Pantalla |
| --- | --- |
| **IDLE** | Campo de partículas lento y orgánico. "ACÉRCATE". Aviso de privacidad periódico. |
| **PRESENCE** | Las partículas cercanas se sienten atraídas y forman la silueta. "TÚ ERES EL INPUT". A los ~3 s, "LEVANTA UNA MANO". Tras el gesto, "PRUEBA CON LAS DOS". Con las dos manos, la silueta se afloja y aparece "COMPUTER VISION". Después, la marca del laboratorio. |
| **DEPARTURE** | La silueta conserva el momentum, se fragmenta y se dispersa. Si hubo interacción, aparece la marca. Luego vuelve a IDLE. |

Pérdidas breves de detección (menos de 900 ms) no cuentan como salida. Si la persona regresa en menos de 8 s, la secuencia continúa sin repetir el saludo.

## Privacidad

- **Qué se almacena: nada.** Ni frames, ni capturas, ni video, ni landmarks, ni identificadores. Cada frame vive sólo lo que dura su inferencia y se cierra en el worker.
- **Qué sale del worker.** Sólo un mapa de siluetas de baja resolución y cajas envolventes anónimas.
- **Red.** No hay conexiones de red: el documento declara una CSP con `connect-src 'self'`, y el modelo y el runtime se sirven localmente.
- **Reconocimiento facial.** No existe. Los ids de silueta sólo dan continuidad entre frames consecutivos y se descartan al perder a la persona.
- **En producción** no se muestra ninguna imagen de cámara. El video sólo es visible con `?debug=true`.

## Limitaciones conocidas

- **Sin detección real de gestos todavía.** Las instrucciones de mano aparecen y expiran; los gestos se prueban con las teclas `1` y `2` en debug. La arquitectura para Fase 4 está lista.
- **Personas lejanas.** El segmentador de MediaPipe está entrenado para distancias de selfie y videollamada: más allá de ~3–4 m pierde definición.
- **Personas juntas.** Dos personas que se tocan se funden en una silueta. Es segmentación semántica, no por instancias.
- **Reflejos del vidrio.** Pueden generar siluetas falsas, sobre todo de noche. Se mitiga con `crop`, área mínima y la instalación física de la cámara (ver análisis).
- **Tamaños de texto.** Están calibrados para laptop. En la pantalla real hay que subir `typography.scale`.
- **Mediciones pendientes con cámara real.** Los tiempos de inferencia se midieron con frames sintéticos: falta confirmar la latencia completa cámara → partículas.
- **Navegador.** Sólo se prueba en Chrome/Chromium.

## Próximas fases

- **Fase 4:** `PoseLandmarker` en el mismo worker a 10–15 Hz. `GestureRecognizer` con histéresis y flanco de subida, que emita los mismos `GestureEvents` que hoy se simulan.
- **Fase 5:** logo real, colores institucionales opcionales y ajuste en sitio.

## Créditos y licencias

- **Runtime y modelo.** MediaPipe Tasks Vision y el modelo `selfie_segmenter_landscape` de Google (Apache 2.0; ver la *model card* de MediaPipe).
- **Tipografías.** Geist y Geist Mono (SIL Open Font License), vía Fontsource.
