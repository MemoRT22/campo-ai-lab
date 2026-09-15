# Análisis crítico de la propuesta

Este documento resume los problemas técnicos y de UX detectados antes y durante la construcción del MVP, y las decisiones que se tomaron. Donde la arquitectura propuesta no tenía sentido, se corrigió.

## 1. Veredicto

Es viable como aplicación 100 % web en Chromium, corriendo en una sola computadora, sin backend. Los tres riesgos más grandes **no son de código**:

1. **Óptica y vidrio.** Reflejos, contraluz y noche afectan más a la segmentación que cualquier parámetro.
2. **Distancia.** El modelo de MediaPipe más adecuado para navegador está entrenado para selfies y videollamadas. Pierde calidad con personas lejanas.
3. **Legibilidad desde afuera.** Un texto "pequeño y elegante" en una laptop es ilegible a 4 m detrás de un vidrio.

## 2. Correcciones a la arquitectura propuesta

| Propuesta | Problema | Decisión |
| --- | --- | --- |
| Segmentación y pose como pipelines separados | Separarlos en código es correcto. Dos capturas o dos loops de cámara duplican trabajo y desincronizan máscara y landmarks. | Una sola captura por frame y un solo worker. Pose corre en el mismo worker a menor frecuencia (configurable). |
| Muestrear la máscara y asignar `targetPosition` en cada frame | **El problema más importante del proyecto.** Si los puntos se remuestrean en cada frame, un brazo que se mueve reordena todos los índices: las partículas cruzan el cuerpo y la silueta "hierve" en vez de moverse. | `TargetField` usa una retícula **fija en pantalla**. Cada celda activa tiene una partícula dueña; sólo las celdas que se encienden o apagan provocan movimiento, y las libres se reasignan a la partícula más cercana. |
| `Particle.ts` con un objeto por partícula | Miles de objetos por frame presionan al GC y fragmentan memoria. `acceleration` no necesita almacenarse. | Estructura de arreglos (`Float32Array`) en `ParticleSystem`. Cero allocations por frame. |
| Three.js / PixiJS / `Scene.ts` | Es un solo tipo de primitiva (puntos) sin grafo de escena. Las librerías agregan peso y capas sin aportar nada aquí. | WebGL2 directo: un buffer y un `drawArrays(GL_POINTS)`. |
| Cooldown para no repetir gestos | Con las manos arriba, el gesto se vuelve a disparar al terminar el cooldown. | El reconocedor emite **flancos de subida** y exige bajar las manos antes de rearmar. El cooldown queda como segunda red. |
| FAR ≈ 200 / MEDIUM ≈ 800 / CLOSE ≈ 3000 partículas fijas | Una persona lejana ya ocupa pocas celdas en pantalla. Números fijos obligan a redistribuir partículas de golpe. | La retícula da el conteo natural por tamaño aparente. `particleDensity` modula la fracción de celdas y `bodyParticleBudget` reparte un tope entre personas. |
| Formación de 500–1200 ms | Alguien que camina a 1.4 m/s cruza el encuadre en 2–3 s. Si la silueta tarda un segundo en aparecer, ya se fue. | Formación escalonada: las primeras partículas llegan en ~300 ms y la silueta completa en ~900 ms. La confirmación de presencia es de 180 ms. |
| "TE VEO" | Suena a vigilancia. | "TÚ ERES EL INPUT" (configurable, desactivable). |
| `PoseTracker.ts` y `GestureRecognizer.ts` en el MVP | Archivos vacíos son deuda sin valor. | La iteración 2 añadió `GestureRecognizer` sólo al existir Pose real y casos de prueba para su comportamiento temporal. |

**Hallazgo adicional de la iteración 2.** Una promesa tardía de `createImageBitmap()` podía terminar después de reiniciar el worker y poner `inFlight=false` sobre la nueva instancia. Eso abría la puerta a más de un frame en vuelo y a resultados fuera de orden. La captura ahora sólo modifica ese estado si todavía pertenece al worker que la inició.

## 3. MediaPipe en navegador

**Opciones evaluadas** (`@mediapipe/tasks-vision` 1.0.1):

- `ImageSegmenter` + `selfie_segmenter` / `selfie_segmenter_landscape`: una máscara de confianza para todas las personas en un solo pase. **Elegido.**
- `selfie_multiclass_256x256`: separa pelo, piel y ropa. Más costoso y no aporta a una silueta.
- DeepLab v3: clases genéricas, más lento y con peores bordes en personas.
- `PoseLandmarker` se usa sólo para landmarks; sus máscaras por pose permanecen desactivadas. La silueta sigue viniendo del segmentador semántico, más robusto para este encuadre.
- `InteractiveSegmenter`: requiere un punto de entrada. Descartado.

**Hallazgos verificados durante la implementación:**

- **Resolución de la máscara.** Sale a la resolución del frame de entrada, no a la del modelo. Enviar 1280 px significa leer 900 k floats de la GPU. Se envían 320×180, suficiente para un modelo de 256×144.
- **Tiempos.** La inferencia medida es de 5.5–7 ms en GPU con lectura a CPU incluida, más 0.5–0.7 ms de limpieza de máscara (Apple M4 Max).
- **Primera inferencia.** En GPU tardó **4.2 s** por compilación de shaders. El worker hace un calentamiento antes de anunciar que está listo.
- **Carga en worker.** Los *module workers* no admiten `importScripts`; hay que usar `FilesetResolver.forVisionTasks(base, true)`, que carga la variante `vision_wasm_module_internal`.
- **Fallback a CPU.** El runtime WASM no puede instanciarse dos veces en el mismo worker, porque borra `ModuleFactory` tras usarlo. El fallback GPU → CPU **requiere un worker nuevo**; hacerlo en el mismo worker falla siempre.
- **Máscaras.** El modelo expone una sola etiqueta (`selfie`).

**Limitaciones del modelo elegido:**

- Pierde recall y definición de bordes a partir de ~3–4 m.
- Personas que se tocan o se traslapan se funden en una sola silueta: es segmentación semántica, no por instancias.
- Si en sitio no alcanza, las alternativas en orden de costo son:
  1. Máscaras de `PoseLandmarker`.
  2. YOLO-seg vía ONNX Runtime Web/WebGPU: robusto por instancias, pero bastante más GPU, y la licencia AGPL de Ultralytics es un problema institucional.
  3. Un proceso nativo local que envíe sólo la máscara al navegador.

## 4. Multipersona

- **Separación de siluetas.** Componentes conexas sobre la máscara limpia, con filtro de área mínima. Los fragmentos pequeños y cercanos, como una mano separada por la máscara, se unen a su persona en lugar de volverse "otra persona".
- **Continuidad sin identidad.** Una asociación anónima por centroide entre frames da continuidad a la proximidad y a la confirmación. No hay identidad ni persistencia.
- **Presupuesto compartido.** Las partículas se reparten entre las siluetas con un tope global; la densidad baja suavemente cuando hay varias.
- **Estética uniforme.** Sin colores por persona.

## 5. Ventanal e iluminación (riesgo principal)

- **Reflejos nocturnos.** De noche el vidrio se vuelve espejo. La cámara ve el interior del laboratorio, a las personas de adentro y **la propia pantalla** (partículas brillantes) y puede producir siluetas falsas.
  - Mitigación física: la cámara pegada al vidrio con un capuchón de goma negro, luces interiores fuera del cono de la cámara y pantalla fuera de su reflejo.
  - Mitigación en software: `camera.crop` para excluir zonas problemáticas.
- **Contraluz diurno.** La silueta oscura se segmenta razonablemente, pero la exposición automática oscila con nubes y reflejos. Conviene una cámara con exposición manual o WDR.
- **Noche exterior.** Con poca luz el ruido degrada la máscara. Opciones: una cámara con buen desempeño en baja luz, o IR con iluminador (el segmentador acepta imagen monocroma).
- **La pantalla detrás del vidrio.** Un fondo negro de día funciona como espejo. Se necesita un panel de alto brillo: ≥700–1000 nits, o ~2500 si le da el sol directo. **Probar en sitio antes de comprar.**
- **Sombras y objetos pequeños.** Los filtran `minPersonArea`, `presenceConfirmMs` y la histéresis del umbral.
- **Calibración.** Hacerla en vivo con `?debug`, sin grabar video.

## 6. Latencia y temblor

**Presupuesto aproximado:**

| Etapa | Tiempo |
| --- | --- |
| Captura de webcam | 30–70 ms |
| Captura + inferencia + limpieza | ~10 ms |
| Retardo del resorte de partículas | ~3–4 frames (50–70 ms) |
| **Total** | **~100–150 ms**, más el panel |

El panel de debug muestra la latencia interna captura → resultado. No la presenta como motion-to-photon, que debe medirse externamente.

**Contra el parpadeo**, en orden de importancia:

1. Umbral con **histéresis**: un píxel encendido se apaga hasta bajar de `threshold − hysteresis`.
2. Suavizado temporal **asimétrico**: aparecer en 35 ms, desaparecer en 140 ms.
3. Retícula estable en pantalla.
4. Resortes amortiguados con velocidad máxima.

## 7. Rendimiento

**Medido en la Mac de desarrollo (Apple M4 Max, Chrome):**

| Métrica | Valor |
| --- | --- |
| Render | 120 fps (pantalla ProMotion) |
| JS por frame en el hilo principal | ~1.5 ms |
| Inferencia (worker) | 5.5–7 ms |
| Limpieza de máscara | 0.5–0.7 ms |
| Simulación de partículas (Node, ~3100 de cuerpo a 1080p) | 0.2 ms p50, 0.7 ms p99 |

**Prueba de estabilidad.** Se simularon 30 minutos del pipeline real sin render (máscara → retícula → partículas) con personas entrando y saliendo, ruido y caídas del segmentador. Se verificaron invariantes en cada frame de visión: cada partícula de cuerpo es dueña de su celda, el pool no se corrompe, no hay NaN, y al vaciarse la escena vuelve exactamente a 900 partículas ambientales. No se observó crecimiento de memoria.

**Hardware recomendado.** Un Mac mini con Apple Silicon, o un mini PC con iGPU moderna (Ryzen 780M, Intel Core Ultra). Evitar iGPU Intel UHD antiguas, que corren el delegado GPU con dificultad. Revisar el *thermal throttling* en gabinetes cerrados.

## 8. Navegador y operación continua

- **Navegador objetivo.** Chrome/Chromium estable. Firefox y Safari no son objetivo: tienen diferencias en el delegado GPU y en OffscreenCanvas en workers, y no hay modo kiosko comparable.
- **Operación sin supervisión:**
  - Reconexión de cámara con backoff.
  - Detección de video congelado.
  - Reinicio del worker si deja de responder o no termina de iniciar.
  - Manejo de pérdida del contexto WebGL.
  - Wake lock para la pantalla.
  - Recarga preventiva cada 12 h, sólo en IDLE.
- **Permiso de cámara.** Chrome lo recuerda para `http://localhost`. En la máquina dedicada, `--use-fake-ui-for-media-stream` lo concede sin diálogo. No usar esa bandera en una computadora personal.

## 9. UX

- **KPI de 5 segundos.** Depende sobre todo de dos cosas:
  1. Que la silueta sea **reconocible desde lejos**. Por eso se reforzaron los valores FAR y el contorno.
  2. Que el **espejo coincida con la posición de la persona**. La cámara debe quedar centrada horizontalmente respecto a la pantalla (arriba o abajo); si está desplazada, la silueta aparece corrida y se rompe la sensación de reflejo.
- **Tamaño del texto.** Regla práctica: ~2.5 cm de altura de letra por cada 3 m de distancia. En una pantalla de 55" a 1080p, leer a 4 m requiere ~50 px de altura de mayúscula. Los tamaños actuales están pensados para probar en laptop: **en sitio subir `typography.scale` a ~2–2.5.**
- **Texto sobre la silueta.** Se usa un halo oscuro difuso en lugar de cajas, para mantener la estética sin sacrificar lectura.
- **Privacidad.** El aviso en pantalla no sustituye un aviso físico junto al ventanal. Aunque no se almacene nada, conviene validar con el área jurídica de la universidad si aplica un aviso de privacidad simplificado conforme a la LFPDPPP.

## 10. Mantenibilidad

- **Código.** TypeScript estricto, sin framework.
- **Configuración.** Toda en `src/config.ts`, sobrescribible por URL sin recompilar.
- **Contratos explícitos.** Visión (`VisionFrame`) → retícula (`TargetField`) → partículas (`ParticleSystem`). La narrativa (`Experience`) no sabe nada de partículas ni de visión.
- **Mock.** `?mock` permite trabajar en efectos y narrativa sin cámara ni voluntarios.
- **Dependencias.** Sólo tres de ejecución: MediaPipe y dos fuentes.
