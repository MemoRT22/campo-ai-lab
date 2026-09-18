/**
 * Configuración central de la instalación.
 *
 * Cualquier valor se puede sobrescribir desde la URL sin recompilar, usando su ruta:
 *   ?debug=true&mock=true&camera=Logitech
 *   ?vision.maskThreshold=0.5&particles.particleSpacing=11
 */

export type Delegate = 'GPU' | 'CPU';
export type FitMode = 'cover' | 'contain';
export type DisplayProfile = 'standard' | 'large';

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const defaultConfig = {
  /** Perfil de salida: `large` conserva la arquitectura y aplica sólo overrides de instalación. */
  displayProfile: 'standard' as DisplayProfile,
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
    /**
     * Recortar en la captura en lugar de descartar píxeles después de inferir.
     * El modelo trabaja siempre a 256×144: si `camera.crop` se aplica al capturar, esos 256×144
     * se gastan sólo en la zona útil y una persona lejana gana resolución real de silueta.
     */
    cropAtCapture: true,
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

  /**
   * DEDOS — Hand Landmarker + segmentación sobre recortes de la cámara en alta resolución, guiados
   * por Pose. La máscara general (320×180) no tiene resolución para un dedo; estos recortes sí.
   * Corre en su propio worker: si se atrasa, la silueta del cuerpo no pierde ni un frame.
   */
  hands: {
    enabled: true,
    modelPath: 'models/hand_landmarker.task',
    /** Frecuencia máxima del análisis; sólo corre cuando Pose ve una muñeca. */
    fps: 20,
    maxHands: 4,
    /** Tamaño del recorte enviado a los modelos (16:9, como espera el segmentador landscape). */
    cropWidth: 320,
    cropHeight: 180,
    /** Alto del recorte: múltiplo de la palma estimada por Pose y del ancho de hombros, acotado en px de cámara. */
    roiPalmScale: 3.4,
    roiShoulderScale: 0.9,
    roiMinPx: 72,
    roiMaxPx: 420,
    /** Recorte guiado por los 21 puntos de la observación anterior, más preciso que Pose. */
    roiHandScale: 1.9,
    /**
     * Tamaño natural mínimo del recorte, en píxeles de cámara, para que valga la pena analizar la
     * mano. Por debajo no hay dedos que encontrar y el análisis sólo le quitaría GPU al cuerpo:
     * en la instalación, con personas a 3–8 m, costaba ~250 ms por tanda y aplicaba cero celdas.
     * Está en píxeles de cámara a propósito: con una cámara mejor, el mismo umbral alcanza más lejos.
     */
    minHandPx: 120,
    /** Tiempo durante el que una observación previa sirve para encuadrar la siguiente. */
    trackReuseMs: 200,
    minWristVisibility: 0.4,
    detectionConfidence: 0.45,
    presenceConfidence: 0.45,
    trackingConfidence: 0.45,
    /** Segmentar el recorte además de los landmarks: da el contorno real de la mano. */
    segmentation: true,
    /** Una observación pierde influencia entre estas edades y desaparece: los dedos nunca se congelan. */
    fadeStartMs: 90,
    maxAgeMs: 220,
    /** Grosor de dedos, pulgar y antebrazo como fracción del largo de la palma (muñeca → nudillo medio). */
    fingerRadius: 0.085,
    thumbRadius: 0.105,
    forearmRadius: 0.3,
    forearmLength: 0.7,
    /** Grosor mínimo de un dedo en celdas de la retícula: por debajo no se vería. */
    minFingerWidthCells: 1.2,
    /** La segmentación del recorte sólo cuenta dentro de este múltiplo del grosor del dedo (descarta manchas). */
    segmentationGate: 1.35,
    /** Zona alrededor de los dedos donde la mano reemplaza a la máscara general (fracción de la palma). */
    patchReach: 0.35,
    patchFeather: 0.35,
    /** Peso de la segmentación cuando no hay landmarks (mano cerrada, muy lejos). */
    segmentationOnlyWeight: 0.6,
    workerTimeoutMs: 4000,
    retryDelayMs: 6000,
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
    particleCount: 24000,
    idleParticleCount: 1050,
    /**
     * Máximo de partículas repartidas entre todas las siluetas. Al superarlo sólo se aclara el
     * interior (ver silhouette.protectEdges): con muchas personas la forma se conserva.
     */
    bodyParticleBudget: 15000,
    /**
     * Separación de la retícula de muestreo, en px de referencia a 1920×1080. Más fina que un píxel
     * de máscara (6 px): el contorno subpíxel aprovecha esa resolución.
     */
    particleSpacing: 5.5,
    /** Fracción de celdas ocupadas según proximidad. */
    particleDensity: { far: 1, close: 1 },
    particleSize: { idle: 1.7, far: 2.2, close: 2.6 },
    particleOpacity: { idle: 0.34, far: 0.68, close: 0.95 },
    /** Desorden dentro de cada celda interior (0 = retícula perfecta). El contorno nunca se desordena. */
    cellJitter: 0.5,
    /**
     * SILHOUETTE DETAIL — fidelidad del contorno. Cada celda se evalúa sobre la confianza interpolada
     * (no sobre píxeles binarios de la máscara) y las partículas del borde se colocan sobre el contorno real.
     */
    silhouette: {
      /** Confianza que define el contorno (entre maskThreshold − maskHysteresis y maskThreshold). */
      contourThreshold: 0.5,
      /** Una celda encendida sólo se apaga por debajo de contourThreshold − este valor: el borde no parpadea. */
      contourHysteresis: 0.06,
      /** 1 = el borde se coloca exactamente sobre el contorno; 0 = centro de celda. */
      edgeSnap: 1,
      /** Desplazamiento máximo del borde hacia el contorno (fracción de particleSpacing). */
      maxSnap: 0.75,
      /** Multiplicador de tamaño de las partículas de borde. 1 conserva el tamaño del interior. */
      edgeSize: 1,
      /** El presupuesto nunca elimina celdas del contorno: la forma se conserva aunque el interior se aclare. */
      protectEdges: true,
    },
    /** Amplitud del temblor vivo de cada partícula sobre el cuerpo (px). */
    particleNoise: 0.6,

    /* INITIAL FORMATION — entrada lenta y cinematográfica. */
    particleAttraction: 0.16,
    particleDamping: 0.6,
    formationDuration: 660,
    /** Retraso de formación (fracción de formationDuration), repartido según formationWow.radialStagger. */
    formationStagger: 0.4,
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
    /**
     * FORMATION WOW — anticipación → colapso → lock, por persona. Afina la formación anterior:
     * el target siempre es la posición actual de la silueta; nada se congela.
     */
    formationWow: {
      /** Multiplicador de la atracción del campo durante la ventana de formación de cada persona. */
      anticipationBoost: 1.6,
      /** Giro tangencial (fracción de la atracción) de las partículas atraídas: el campo se curva al activarse. */
      anticipationCurl: 0.6,
      /** Tras el lock el giro del campo se apaga en este tiempo: las partículas sobrantes no quedan orbitando. */
      curlReleaseMs: 400,
      /** Fracción de partículas que giran en el sentido dominante (0.5 = sin sentido dominante). */
      anticipationSwirlBias: 0.72,
      /** Atracción hacia siluetas aún no confirmadas (fracción de ambientAttraction): el campo nota la presencia antes. */
      pendingAttraction: 0.7,
      /** Resorte suave de las partículas ya asignadas que esperan su turno para colapsar. */
      waitingAttraction: 0.006,
      /** Giro durante el colapso (fracción del resorte de formación): llegan en arco, no en línea recta. */
      collapseCurl: 0.35,
      /** Brillo extra mientras viajan hacia el cuerpo (máximo a mitad del viaje). */
      collapseGlow: 0.35,
      /** 0 = retraso aleatorio; 1 = retraso según la distancia al centro del cuerpo (torso primero). */
      radialStagger: 0.65,
      /** Fracción del cuerpo formado desde la que la silueta queda fija en el perfil espejo. */
      lockThreshold: 0.8,
      /** Aceleración del enlace de las partículas restantes (y de las nuevas) tras el lock. */
      lockSpeedup: 3,
      /** Retraso aleatorio que conservan las partículas nuevas tras el lock (fracción de formationStagger). */
      lockedStaggerScale: 0.15,
      /** Pulso de brillo muy breve al fijarse la silueta. */
      lockGlow: 0.22,
      lockGlowMs: 320,
    },

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

    /**
     * LIVING BODY — capa visual sobre el núcleo. El núcleo sigue el target con los parámetros de
     * tracking; la estela y el desprendimiento son un offset de render que regresa solo al cuerpo.
     */
    livingBody: {
      /** Fracción de partículas con inercia ligera (microestela): sobre todo en el borde. */
      trailRatioEdge: 0.3,
      trailRatioInterior: 0.03,
      /** Fracción del desplazamiento del cuerpo que la partícula conserva como estela (0..1). */
      trailInertia: 0.45,
      /** Duración aproximada de la microestela (≈ 3 constantes de tiempo del regreso). */
      trailDurationMs: 200,
      trailMaxDistance: 22,
      /** Velocidad local de la partícula (px/s de referencia) donde empieza y se completa el efecto. */
      trailSpeed: { start: 220, full: 1000 },
      /** Fracción de partículas de borde que se desprenden en arco con movimiento rápido. */
      shedRatio: 0.14,
      shedForce: 0.9,
      shedDurationMs: 260,
      shedMaxDistance: 34,
      /** Estela y desprendimiento son más tenues que el núcleo. */
      effectAlpha: 0.75,
      /** Cuerpo quieto: temblor del interior (fracción de particleNoise) y flotación lenta del borde. */
      interiorNoise: 0.3,
      edgeFloat: 0.5,
      edgeFloatSpeed: 0.5,
    },

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
    /** Avance mínimo del target entre frames de visión (30 Hz → 60 Hz). 0 desactiva. */
    interpolationMaxMs: 40,
    /**
     * La ventana de interpolación se adapta al ritmo real de la visión: `intervalo × factor`.
     * Con una cámara lenta (8–15 fps) una ventana fija congelaba la silueta entre frames, que es
     * la causa de que el espejo se vea a escalones aunque el render vaya a 60. 0 desactiva.
     */
    interpolationIntervalFactor: 1.2,
    /** Tope de seguridad del avance interpolado (px a escala de referencia). */
    interpolationMaxDistance: 90,

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

    /**
     * GROUP MODE — el espacio entre personas cobra vida. Sólo usa partículas del campo: las siluetas
     * nunca ceden partículas. Usa los personId temporales; no hay identidad persistente.
     */
    groupInteraction: {
      enabled: true,
      /** Una persona cuenta para el grupo tras estar presente este tiempo. */
      stableMs: 700,
      /** Una ausencia breve no la saca del grupo. */
      dropGraceMs: 500,
      /** Histéresis del número de personas estables: tiempo sostenido para subir y para bajar de modo. */
      enterMs: 600,
      exitMs: 1200,
      /** Distancia entre centros (px de referencia) donde la conexión es plena y donde desaparece. */
      connectionDistance: { near: 420, far: 1400 },
      pairStrength: 0.75,
      collectiveStrength: 1,
      maxConnections: 4,
      /** Una conexión existente parece este factor más cercana al elegir pares (evita alternar). */
      selectionStickiness: 0.85,
      strengthAttackMs: 900,
      strengthReleaseMs: 700,
      positionSmoothingMs: 220,
      relativeSpeedSmoothingMs: 300,
      /** Presupuesto total de partículas del campo en las corrientes (2 personas / 3 o más). */
      pairParticleBudget: 180,
      collectiveParticleBudget: 440,
      /** Radio (px de referencia) alrededor de la línea entre dos personas donde se reclutan partículas. */
      recruitRadius: 380,
      recruitScanPerFrame: 900,
      /** Si faltan partículas cerca, aparecen unas pocas por frame sobre la corriente. */
      spawnPerFrame: 3,
      fadeInMs: 450,
      /** Separación de cada extremo respecto al centro de la persona (px de referencia). */
      endInset: 130,
      /** Ancho, curvatura y respiración de la corriente. */
      width: 42,
      curvature: 0.12,
      bendSpeed: 0.18,
      /** Recorrido de la corriente (fracción de su longitud por segundo) y refuerzo por movimiento relativo. */
      flowSpeed: 0.12,
      relativeSpeedBoost: 1.5,
      relativeSpeedFull: 600,
      attraction: 0.02,
      damping: 0.9,
      maxSpeed: 3.2,
      /** Brillo y tamaño de las partículas en la corriente (multiplicadores sobre el campo). */
      alpha: 2.6,
      size: 1.3,
      /** Modo colectivo: fracción de partículas que forman pequeños nodos entre personas. */
      nodeRatio: 0.22,
      nodeRadius: 26,
      nodeSpin: 0.6,
      /** Modo colectivo: el campo completo se vuelve más activo. */
      collectiveAmbientDrift: 0.8,
      collectiveTwinkle: 0.5,
      energyAttackMs: 1200,
      energyReleaseMs: 1800,
      /** Energía del campo con dos personas (fracción de la del modo colectivo). */
      pairEnergy: 0.3,
      /** ONE_HAND_UP casi simultáneo de dos personas: las ondas se encuentran. */
      resonanceWindowMs: 700,
      resonanceMaxDelayMs: 450,
      resonanceRadius: 180,
      resonanceDurationMs: 700,
      resonanceGlow: 0.6,
      resonancePush: 1.2,
      resonanceSpawnCount: 28,
      resonanceKick: 2.4,
    },
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

/** Encuadre completo: el recorte neutro. */
export const FULL_FRAME: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Región del video que se captura y se envía a los modelos.
 *
 * Con `cropAtCapture`, recortar deja de ser un filtro y pasa a ser un zoom óptico: los 256×144 del
 * segmentador se gastan sólo en la zona útil, y una persona lejana gana resolución real de silueta.
 * La región se expande hasta recuperar la proporción del encuadre porque el segmentador redimensiona
 * sin respetar el aspecto: una región estirada le deforma a las personas. Por eso sólo hay ganancia
 * si el recorte reduce ancho y alto a la vez.
 */
export function captureRegion(config: Config): NormalizedRect {
  if (!config.vision.cropAtCapture) return FULL_FRAME;
  const crop = config.camera.crop;
  const size = clampRange(Math.max(crop.width, crop.height), 0, 1);
  if (size >= 1) return FULL_FRAME;
  return {
    x: clampRange(crop.x + crop.width / 2 - size / 2, 0, 1 - size),
    y: clampRange(crop.y + crop.height / 2 - size / 2, 0, 1 - size),
    width: size,
    height: size,
  };
}

/**
 * Recorte que queda por aplicar sobre una máscara ya inferida: el recorte pedido, expresado dentro
 * de la región capturada. La zona visible es siempre `camera.crop`, se haya capturado como se haya
 * capturado.
 */
export function frameRegion(config: Config): NormalizedRect {
  const crop = config.camera.crop;
  const region = captureRegion(config);
  if (region.width >= 1 && region.height >= 1) return crop;
  return {
    x: (crop.x - region.x) / region.width,
    y: (crop.y - region.y) / region.height,
    width: crop.width / region.width,
    height: crop.height / region.height,
  };
}
