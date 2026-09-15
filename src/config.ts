/**
 * Configuración central de la instalación.
 *
 * Cualquier valor se puede sobrescribir desde la URL sin recompilar, usando su ruta:
 *   ?debug=true&mock=true&camera=Logitech
 *   ?vision.maskThreshold=0.5&particles.particleSpacing=11
 */

export type Delegate = 'GPU' | 'CPU';
export type FitMode = 'cover' | 'contain';

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const defaultConfig = {
  /** Panel técnico: cámara, máscara, cajas, FPS. Nunca activar en producción. */
  debugMode: false,
  /** Herramientas de ajuste en sitio. Implica debugMode y sólo persiste números técnicos. */
  calibrationMode: false,
  /** Sustituye la cámara por siluetas sintéticas (desarrollo sin cámara ni personas). */
  mockVision: false,

  camera: {
    cameraWidth: 1280,
    cameraHeight: 720,
    frameRate: 30,
    /** Fragmento del nombre de la cámara (p. ej. "Logitech"). Vacío = cámara por defecto. */
    deviceLabel: '',
    /** Índice en la lista de cámaras; -1 = no usar. */
    deviceIndex: -1,
    /** Espejo horizontal: la silueta se mueve como un reflejo. */
    mirror: true,
    /** cover llena la pantalla recortando; contain muestra todo el encuadre. */
    fit: 'cover' as FitMode,
    /** Región útil del encuadre (normalizada). Sirve para excluir reflejos, techo o calle lejana. */
    crop: { x: 0, y: 0, width: 1, height: 1 } as NormalizedRect,
    retryDelaysMs: [1000, 2000, 5000, 10000, 30000],
    /** Si el video deja de avanzar este tiempo, se considera cámara perdida y se reconecta. */
    frozenFrameTimeoutMs: 4000,
  },

  vision: {
    processingFPS: 30,
    /** Pose comparte el frame y el worker, pero corre con menor frecuencia. */
    poseFPS: 15,
    /** Ancho del frame enviado al modelo. El segmentador trabaja internamente a 256×144. */
    inferenceWidth: 320,
    delegate: 'GPU' as Delegate,
    modelPath: 'models/selfie_segmenter_landscape.tflite',
    poseModelPath: 'models/pose_landmarker_lite.task',
    wasmPath: 'mediapipe/wasm',
    /** Segunda URL del mismo runtime: evita la caché ESM al alojar dos tareas en un worker. */
    poseWasmPath: 'mediapipe/pose-wasm',
    poseDetectionConfidence: 0.55,
    posePresenceConfidence: 0.55,
    poseTrackingConfidence: 0.55,
    /** Confianza mínima para considerar un píxel como persona. */
    maskThreshold: 0.6,
    /** Histéresis: un píxel encendido se apaga hasta bajar de threshold − hysteresis. */
    maskHysteresis: 0.2,
    /** Suavizado temporal asimétrico: aparecer rápido, desaparecer más lento. */
    smoothingAttackMs: 35,
    smoothingReleaseMs: 140,
    spatialBlurRadius: 1,
    /** Área mínima de una silueta (fracción de la región útil). Filtra sombras y objetos pequeños. */
    minPersonArea: 0.006,
    maxPeople: 4,
    /** Una silueta debe persistir este tiempo antes de atraer partículas. */
    presenceConfirmMs: 180,
    trackMatchDistance: 0.25,
    trackTimeoutMs: 450,
    /** Sin resultados de visión durante este tiempo, las siluetas se liberan. */
    staleFrameMs: 1200,
    workerTimeoutMs: 8000,
    /** Descargar el runtime y compilar shaders puede tardar en equipos lentos. */
    workerInitTimeoutMs: 45000,
    /** Fallos/timeout consecutivos antes de fijar CPU para el resto de la sesión. */
    runtimeFailureThreshold: 3,
  },

  gestures: {
    minVisibility: 0.6,
    /** Distancia normalizada por encima del hombro para activar y para rearmar. */
    raiseMargin: 0.075,
    lowerMargin: 0.025,
    smoothingMs: 90,
    oneHandHoldMs: 220,
    bothHandsHoldMs: 300,
    /** Una ausencia breve de pose no rearma un gesto sostenido. */
    absenceGraceMs: 300,
  },

  proximity: {
    /** Tamaño aparente (alto normalizado) considerado LEJOS. */
    farSize: 0.3,
    /** Tamaño aparente considerado CERCA. */
    closeSize: 0.9,
    smoothingMs: 650,
  },

  particles: {
    /** Tamaño total del pool (ambiente + cuerpos + transiciones). */
    particleCount: 9000,
    idleParticleCount: 900,
    /** Máximo de partículas repartidas entre todas las siluetas. */
    bodyParticleBudget: 5600,
    /** Separación de la retícula de muestreo, en px de referencia a 1920×1080. */
    particleSpacing: 9,
    /** Fracción de celdas ocupadas según proximidad. */
    particleDensity: { far: 0.75, close: 1 },
    particleSize: { idle: 1.7, far: 2.5, close: 2.9 },
    particleOpacity: { idle: 0.42, far: 0.7, close: 0.95 },
    /** Desorden dentro de cada celda (0 = retícula perfecta). */
    cellJitter: 0.8,
    /** Amplitud del temblor vivo de cada partícula sobre el cuerpo (px). */
    particleNoise: 1.3,
    particleAttraction: 0.14,
    particleDamping: 0.64,
    maxSpeed: 40,
    formationDuration: 850,
    /** Retraso aleatorio de formación (fracción de formationDuration). */
    formationStagger: 0.45,
    spawnDistance: { min: 40, max: 240 },
    dispersionDuration: 1500,
    releaseKick: 2.4,
    /** Fracción de partículas ambientales que se conservan mientras hay personas. */
    ambientPresenceRatio: 0.55,
    ambientDrift: 0.012,
    ambientDamping: 0.962,
    ambientBrownian: 0.018,
    ambientAttraction: 0.01,
    breathingAmount: 0.08,
    /** Brillo extra del contorno para reforzar el reconocimiento de la silueta. */
    edgeBrightness: 1.35,
    /** Onda del gesto de mano: px/ms, ancho del frente (px) y empuje. */
    waveSpeed: 0.55,
    waveWidth: 110,
    waveStrength: 1.8,
  },

  render: {
    background: [0.008, 0.008, 0.01] as [number, number, number],
    particleColor: [1, 1, 1] as [number, number, number],
    maxDevicePixelRatio: 2,
  },

  experience: {
    showDetectedMessage: true,
    idlePromptDelayMs: 1200,
    greetingDelayMs: 450,
    greetingDurationMs: 2600,
    firstInstructionDelayMs: 3200,
    instructionTimeout: 9000,
    secondInstructionDelayMs: 1600,
    revealDurationMs: 4200,
    revealScatterMs: 1300,
    gestureCooldown: 350,
    absenceGraceMs: 900,
    /** Si la persona regresa antes de este tiempo, se retoma la secuencia sin repetir el saludo. */
    returnWithinMs: 8000,
    departureDurationMs: 2800,
    /** Presencia mínima para considerar que hubo interacción (y mostrar la marca al salir). */
    engagedMinMs: 4000,
    brandAfterRevealMs: 700,
    brandDurationMs: 5200,
    brandAfterPresenceMs: 22000,
  },

  texts: {
    idlePrompt: 'ACÉRCATE',
    detected: 'TÚ ERES EL INPUT',
    raiseHand: 'LEVANTA UNA MANO',
    tryBoth: 'AHORA PRUEBA CON LAS DOS',
    revealTitle: 'COMPUTER VISION',
    revealSubtitle: 'SEGMENTACIÓN HUMANA EN TIEMPO REAL',
    privacy: 'Procesamiento local en tiempo real · No almacenamos imágenes',
  },

  branding: {
    showBranding: true,
    brandName: 'ANÁHUAC CANCÚN',
    labName: 'AI & CYBERSECURITY LAB',
    tagline: '',
    logoEnabled: false,
    logoPath: 'brand/logo.svg',
  },

  privacy: {
    showPrivacyNotice: true,
    intervalMs: 45000,
    durationMs: 8000,
    presenceDelayMs: 5000,
  },

  typography: {
    /** Escala global del texto. Subir si la pantalla se ve desde lejos. */
    scale: 1,
  },

  kiosk: {
    hideCursorAfterMs: 2500,
    wakeLock: true,
    /** Recarga preventiva tras N horas, sólo en IDLE. 0 = desactivado. */
    reloadEveryHours: 12,
  },
};

export type Config = typeof defaultConfig;
