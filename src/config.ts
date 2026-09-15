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
    smoothingAttackMs: 22,
    smoothingReleaseMs: 65,
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
    smoothingMs: 500,
  },

  particles: {
    /** Tamaño total del pool (ambiente + cuerpos + transiciones). */
    particleCount: 9000,
    idleParticleCount: 1050,
    /** Máximo de partículas repartidas entre todas las siluetas. */
    bodyParticleBudget: 5600,
    /** Separación de la retícula de muestreo, en px de referencia a 1920×1080. */
    particleSpacing: 9,
    /** Fracción de celdas ocupadas según proximidad. */
    particleDensity: { far: 0.75, close: 1 },
    particleSize: { idle: 1.7, far: 2.5, close: 2.9 },
    particleOpacity: { idle: 0.34, far: 0.68, close: 0.95 },
    /** Desorden dentro de cada celda (0 = retícula perfecta). */
    cellJitter: 0.8,
    /** Amplitud del temblor vivo de cada partícula sobre el cuerpo (px). */
    particleNoise: 0.9,

    /* INITIAL FORMATION — entrada lenta y cinematográfica. */
    particleAttraction: 0.16,
    particleDamping: 0.6,
    formationDuration: 780,
    /** Retraso aleatorio de formación (fracción de formationDuration). */
    formationStagger: 0.34,
    formationMaxSpeed: 26,
    /** Las partículas nuevas aparecen lejos del cuerpo y viajan hacia él: se ven llegar, no encenderse. */
    spawnDistance: { min: 70, max: 300 },
    /** Atracción del campo hacia una persona que acaba de llegar (px de referencia y ms). */
    formationAttractionRadius: 440,
    formationAttractionInnerRadius: 160,
    formationAttractionWindowMs: 2600,
    formationAttractionFadeMs: 2000,
    /** Anillos de bins (64 px) en los que se buscan partículas ambientales para formar el cuerpo. */
    formationSearchRings: 6,
    /** Brillo extra de las partículas del campo mientras son atraídas (anticipación). */
    formationAnticipationGlow: 0.45,

    /* NORMAL TRACKING — cuerpo ya formado: debe sentirse como espejo. */
    /** Fracción de `bond` desde la que una partícula usa el perfil de seguimiento. */
    trackingBondThreshold: 0.85,
    trackingAttraction: 0.5,
    trackingDamping: 0.42,
    /** Acercamiento directo al target por frame de 60 Hz. Quita lag sin agregar overshoot. */
    trackingSnap: 0.32,
    /** Tras un transporte BODY → BODY, la partícula usa el perfil rápido durante esta ventana. */
    trackingResponseMs: 120,
    maxSpeed: 64,
    /** Distancia máxima de transporte intra-persona, en px de referencia. */
    trackingSearchRadius: 360,

    /* FAST MOTION — caminar rápido o mover brazos. */
    /** Velocidad del track (px/s de referencia) donde empieza y se completa el perfil rápido. */
    fastMotionSpeed: { start: 90, full: 700 },
    fastMotionAttraction: 0.7,
    fastMotionDamping: 0.34,
    fastMotionSnap: 0.5,
    /** Fracción de partículas que se quedan levemente atrás y cuánto se relaja su seguimiento. */
    fastMotionTrailRatio: 0.12,
    fastMotionTrail: 0.55,

    /* Predicción e interpolación — sólo tracks estables, limitadas y sin overshoot. */
    /** Adelanto del track. 0 desactiva completamente la predicción. */
    predictionMs: 30,
    predictionMaxDistance: 26,
    predictionSmoothingMs: 75,
    predictionStableFrames: 3,
    predictionMinSpeed: 45,
    /** Por encima de esta velocidad (px/s) el movimiento se trata como salto, no como traslación. */
    predictionMaxTrackSpeed: 2400,
    /** Coseno de giro: por debajo se apaga; entre este valor y 0.95 se atenúa. */
    predictionTurnCosine: 0.35,
    predictionReversalCosine: -0.25,
    /** Si la velocidad cae bajo esta fracción de la anterior, el adelanto se corta en proporción. */
    predictionBrakeRatio: 0.7,
    /** Levantar los brazos mueve el centro en vertical: se predice sobre todo en horizontal. */
    predictionVerticalFactor: 0.35,
    /** El adelanto crece con esta constante de tiempo y se reduce de inmediato. */
    predictionRiseMs: 90,
    /** Avance del target entre frames de visión (30 Hz → 60 Hz). 0 desactiva. */
    interpolationMaxMs: 40,

    /* DEPARTURE — la presencia se disuelve. */
    /** Tolera una pérdida aislada de segmentación sin dispersar el cuerpo. */
    occlusionGraceMs: 120,
    /** Durante esa gracia la partícula suelta su target en este tiempo y sigue con su momentum. */
    departureLetGoMs: 70,
    /**
     * Al irse una persona, cada partícula conserva forma y momentum un tiempo distinto (0..este valor)
     * antes de desprenderse: la silueta se disuelve de forma progresiva, no de golpe.
     */
    departureStaggerMs: 480,
    departureCohesionDamping: 0.985,
    dispersionDuration: 1750,
    releaseKick: 1.8,
    /** Fracción de partículas ambientales que se conservan mientras hay personas. */
    ambientPresenceRatio: 0.5,
    ambientDrift: 0.009,
    ambientDamping: 0.968,
    ambientBrownian: 0.01,
    /** Fuerza de atracción del campo durante la formación. */
    ambientAttraction: 0.008,

    /* Presencia magnética — el campo reacciona apenas al cuerpo ya formado. */
    /** Atracción que queda tras la ventana de formación (fracción de ambientAttraction). */
    magneticResidualAttraction: 0.2,
    magneticRadius: 280,
    /** Arrastre del campo detrás del movimiento corporal. */
    ambientMotionInfluence: 0.08,
    /** Desvío lateral de las partículas que quedan delante del movimiento. */
    magneticDeflection: 0.05,

    /* IDLE — campo lento con profundidad. Cada partícula tiene una profundidad fija (0 lejos, 1 cerca). */
    idleDepth: { sizeFar: 0.55, sizeNear: 1.45, alphaFar: 0.4, alphaNear: 1, driftFar: 0.5, driftNear: 1.35 },
    idleTwinkle: 0.22,
    ambientCohesion: 0.000018,
    ambientCohesionRadius: 360,
    /** Velocidad y deriva de los tres pozos lentos que dan respiración al campo. */
    idleWellSpeed: 0.08,
    idleWellWander: 0.06,
    breathingAmount: 0.055,
    /** Brillo extra del contorno para reforzar el reconocimiento de la silueta. */
    edgeBrightness: 1.28,

    /* ONE_HAND_UP — onda orgánica alrededor de la mano; acompaña a la persona si se mueve. */
    /** Velocidad del frente (px/ms de referencia), ancho del frente (px), empuje y radio máximo. */
    waveSpeed: 0.34,
    waveWidth: 110,
    waveStrength: 1.35,
    waveMaxRadius: 240,
    waveOrganicWarp: 0.18,
    /** Las partículas libres casi no tienen fricción: la onda sólo las roza para no dibujar anillos. */
    waveAmbientFactor: 0.12,
    /** Brillo leve concentrado junto a la mano. */
    waveGlow: 0.4,
    waveGlowRadius: 110,
    gestureExciteSize: 0.7,
    gestureExciteAlpha: 0.16,
    gestureExciteDecayMs: 650,
    /** Cuánto se relaja el seguimiento directo donde un gesto excita partículas (deja ver la onda). */
    gestureSnapRelief: 0.85,

    /* BOTH_HANDS_UP — expansión → suspensión → desprendimiento → texto → regreso. Nunca detiene el tracking. */
    revealExpansion: 16,
    revealSuspension: 0.26,
    revealExpandMs: 320,
    revealSuspendMs: 380,
    revealRecoverMs: 700,
    /** Fracción del cuerpo que viaja al texto y cuántos puntos tipográficos se muestrean como máximo. */
    textParticleRatio: 0.2,
    textParticleMaxTargets: 900,
    /** Las partículas sobre el texto son más tenues y pequeñas: la legibilidad del texto manda. */
    textParticleAlpha: 0.5,
    textParticleSize: 0.75,
    textParticleGlow: 0.25,
    textTravelAttraction: 0.09,
    revealTravelMs: 800,
    revealHoldMs: 2400,
    revealReturnMs: 1000,
    /** Tras el reveal, las mismas partículas pasan del texto a la marca y luego regresan al cuerpo. */
    brandTravelMs: 1100,
    brandReturnMs: 1200,
  },

  render: {
    background: [0.008, 0.008, 0.01] as [number, number, number],
    particleColor: [1, 1, 1] as [number, number, number],
    maxDevicePixelRatio: 2,
  },

  experience: {
    showDetectedMessage: true,
    idlePromptDelayMs: 2000,
    idlePromptDurationMs: 5200,
    /** Tiempo entre apariciones de ACÉRCATE mientras nadie está presente. */
    idlePromptIntervalMs: 15000,
    /** El saludo espera a que la silueta termine de formarse. */
    greetingDelayMs: 950,
    greetingDurationMs: 2400,
    /** Saludo → fundido → silencio → primera instrucción. */
    firstInstructionDelayMs: 5200,
    instructionTimeout: 7000,
    /** Deja terminar la onda de la mano antes de pedir las dos. */
    secondInstructionDelayMs: 1500,
    revealDurationMs: 4400,
    /** El título aparece cuando termina la suspensión de la silueta. */
    revealTextDelayMs: 650,
    gestureCooldown: 350,
    absenceGraceMs: 900,
    /** Si la persona regresa antes de este tiempo, se retoma la secuencia sin repetir el saludo. */
    returnWithinMs: 8000,
    departureDurationMs: 2800,
    /** Presencia mínima para considerar que hubo interacción (y mostrar la marca al salir). */
    engagedMinMs: 4000,
    brandAfterRevealMs: 450,
    brandDurationMs: 5200,
    brandAfterPresenceMs: 26000,
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

  layout: {
    /** Columnas laterales de espacio negativo (fracción del ancho) donde vive el texto con personas. */
    sideColumnWidth: 0.28,
    /** Fracción de la columna que puede ocupar el texto. */
    columnFill: 0.86,
    /** Banda vertical de las columnas donde se mide la ocupación y se centra el texto. */
    textBandTop: 0.3,
    textBandBottom: 0.7,
    /** Franja superior alternativa para mensajes que no piden levantar las manos. */
    topBand: { top: 0.06, bottom: 0.2, width: 0.5 },
    /** Ocupación (0..1) desde la que una columna se considera en conflicto con la silueta. */
    maxOccupancy: 0.1,
    /** Diferencia mínima de ocupación para cambiar de lado (evita alternar). */
    switchMargin: 0.08,
    occupancySmoothingMs: 450,
    /** Por debajo de esta proporción ancho/alto no hay columnas laterales útiles. */
    minSideAspect: 1.2,
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
