import { defaultConfig, type Config, type NormalizedRect } from '../config';

type NumberRule = { min: number; max: number; integer?: boolean; fallback?: boolean };

const NUMBER_RULES: Record<string, NumberRule> = {
  'camera.cameraWidth': { min: 160, max: 7680, integer: true, fallback: true },
  'camera.cameraHeight': { min: 120, max: 4320, integer: true, fallback: true },
  'camera.frameRate': { min: 1, max: 120 },
  'camera.deviceIndex': { min: -1, max: 64, integer: true },
  'camera.frozenFrameTimeoutMs': { min: 500, max: 60000 },
  'vision.processingFPS': { min: 1, max: 60 },
  'vision.poseFPS': { min: 1, max: 30 },
  'vision.inferenceWidth': { min: 128, max: 1280, integer: true, fallback: true },
  'vision.maskThreshold': { min: 0, max: 1 },
  'vision.maskHysteresis': { min: 0, max: 1 },
  'vision.smoothingAttackMs': { min: 0, max: 2000 },
  'vision.smoothingReleaseMs': { min: 0, max: 5000 },
  'vision.spatialBlurRadius': { min: 0, max: 8, integer: true },
  'vision.minPersonArea': { min: 0, max: 1 },
  'vision.maxPeople': { min: 1, max: 4, integer: true },
  'vision.presenceConfirmMs': { min: 0, max: 5000 },
  'vision.trackMatchDistance': { min: 0.01, max: 1 },
  'vision.trackTimeoutMs': { min: 50, max: 10000 },
  'vision.staleFrameMs': { min: 100, max: 30000 },
  'vision.workerTimeoutMs': { min: 250, max: 60000 },
  'vision.workerInitTimeoutMs': { min: 1000, max: 120000 },
  'vision.runtimeFailureThreshold': { min: 1, max: 20, integer: true },
  'vision.poseDetectionConfidence': { min: 0, max: 1 },
  'vision.posePresenceConfidence': { min: 0, max: 1 },
  'vision.poseTrackingConfidence': { min: 0, max: 1 },
  'gestures.minVisibility': { min: 0, max: 1 },
  'gestures.raiseMargin': { min: 0.01, max: 0.5 },
  'gestures.lowerMargin': { min: 0, max: 0.49 },
  'gestures.smoothingMs': { min: 0, max: 2000 },
  'gestures.oneHandHoldMs': { min: 100, max: 2000 },
  'gestures.bothHandsHoldMs': { min: 100, max: 3000 },
  'gestures.absenceGraceMs': { min: 0, max: 3000 },
  'particles.particleCount': { min: 100, max: 100000, integer: true, fallback: true },
  'particles.idleParticleCount': { min: 0, max: 100000, integer: true },
  'particles.bodyParticleBudget': { min: 0, max: 100000, integer: true },
  'particles.particleSpacing': { min: 2, max: 80 },
  'particles.particleDensity.far': { min: 0.05, max: 1 },
  'particles.particleDensity.close': { min: 0.05, max: 1 },
  'particles.particleSize.idle': { min: 0.2, max: 12 },
  'particles.particleSize.far': { min: 0.2, max: 12 },
  'particles.particleSize.close': { min: 0.2, max: 12 },
  'particles.particleOpacity.idle': { min: 0, max: 1 },
  'particles.particleOpacity.far': { min: 0, max: 1 },
  'particles.particleOpacity.close': { min: 0, max: 1 },
  'particles.edgeBrightness': { min: 0.5, max: 4 },
  'particles.cellJitter': { min: 0, max: 1 },
  'particles.silhouette.contourThreshold': { min: 0.05, max: 0.95 },
  'particles.silhouette.contourHysteresis': { min: 0, max: 0.3 },
  'particles.silhouette.edgeSnap': { min: 0, max: 1 },
  'particles.silhouette.maxSnap': { min: 0, max: 1.5 },
  'particles.silhouette.edgeSize': { min: 0.5, max: 2 },
  'particles.particleAttraction': { min: 0, max: 2 },
  'particles.particleDamping': { min: 0.1, max: 0.99 },
  'particles.trackingAttraction': { min: 0, max: 2 },
  'particles.trackingDamping': { min: 0.1, max: 0.99 },
  'particles.trackingResponseMs': { min: 16, max: 1000 },
  'particles.predictionMs': { min: 0, max: 120 },
  'particles.predictionMaxDistance': { min: 0, max: 120 },
  'particles.predictionSmoothingMs': { min: 0, max: 1000 },
  'particles.interpolationIntervalFactor': { min: 0, max: 3 },
  'particles.interpolationMaxDistance': { min: 0, max: 300 },
  'particles.occlusionGraceMs': { min: 0, max: 1000 },
  'particles.trackingSearchRadius': { min: 20, max: 1000 },
  'particles.maxSpeed': { min: 1, max: 200 },
  'particles.formationMaxSpeed': { min: 1, max: 200 },
  // Umbrales de smoothstep: nunca iguales a su otro extremo (evita divisiones por cero).
  'particles.trackingBondThreshold': { min: 0.5, max: 0.98 },
  'particles.trackingSnap': { min: 0, max: 0.9 },
  'particles.fastMotionSpeed.start': { min: 0, max: 5000 },
  'particles.fastMotionSpeed.full': { min: 1, max: 10000 },
  'particles.fastMotionAttraction': { min: 0, max: 2 },
  'particles.fastMotionDamping': { min: 0.1, max: 0.99 },
  'particles.fastMotionSnap': { min: 0, max: 0.9 },
  'particles.formationWow.anticipationBoost': { min: 0, max: 5 },
  'particles.formationWow.anticipationCurl': { min: 0, max: 3 },
  'particles.formationWow.curlReleaseMs': { min: 1, max: 5000 },
  'particles.formationWow.anticipationSwirlBias': { min: 0, max: 1 },
  'particles.formationWow.pendingAttraction': { min: 0, max: 3 },
  'particles.formationWow.waitingAttraction': { min: 0, max: 0.1 },
  'particles.formationWow.collapseCurl': { min: 0, max: 2 },
  'particles.formationWow.collapseGlow': { min: 0, max: 2 },
  'particles.formationWow.radialStagger': { min: 0, max: 1 },
  'particles.formationWow.lockThreshold': { min: 0.3, max: 1 },
  'particles.formationWow.lockSpeedup': { min: 1, max: 10 },
  'particles.formationWow.lockedStaggerScale': { min: 0, max: 1 },
  'particles.formationWow.lockGlow': { min: 0, max: 2 },
  'particles.formationWow.lockGlowMs': { min: 1, max: 3000 },
  'particles.livingBody.trailRatioEdge': { min: 0, max: 1 },
  'particles.livingBody.trailRatioInterior': { min: 0, max: 0.5 },
  'particles.livingBody.trailInertia': { min: 0, max: 1 },
  'particles.livingBody.trailDurationMs': { min: 16, max: 1000 },
  'particles.livingBody.trailMaxDistance': { min: 0, max: 200 },
  'particles.livingBody.trailSpeed.start': { min: 0, max: 5000 },
  'particles.livingBody.trailSpeed.full': { min: 1, max: 10000 },
  'particles.livingBody.shedRatio': { min: 0, max: 1 },
  'particles.livingBody.shedForce': { min: 0, max: 10 },
  'particles.livingBody.shedDurationMs': { min: 16, max: 1000 },
  'particles.livingBody.shedMaxDistance': { min: 0, max: 200 },
  'particles.livingBody.effectAlpha': { min: 0, max: 2 },
  'particles.livingBody.interiorNoise': { min: 0, max: 3 },
  'particles.livingBody.edgeFloat': { min: 0, max: 6 },
  'particles.livingBody.edgeFloatSpeed': { min: 0, max: 4 },
  'particles.groupInteraction.stableMs': { min: 0, max: 10000 },
  'particles.groupInteraction.dropGraceMs': { min: 0, max: 5000 },
  'particles.groupInteraction.enterMs': { min: 0, max: 10000 },
  'particles.groupInteraction.exitMs': { min: 0, max: 10000 },
  'particles.groupInteraction.connectionDistance.near': { min: 0, max: 5000 },
  'particles.groupInteraction.connectionDistance.far': { min: 1, max: 10000 },
  'particles.groupInteraction.pairStrength': { min: 0, max: 1 },
  'particles.groupInteraction.collectiveStrength': { min: 0, max: 1 },
  'particles.groupInteraction.maxConnections': { min: 1, max: 6, integer: true },
  'particles.groupInteraction.selectionStickiness': { min: 0.1, max: 1 },
  'particles.groupInteraction.strengthAttackMs': { min: 0, max: 10000 },
  'particles.groupInteraction.strengthReleaseMs': { min: 0, max: 10000 },
  'particles.groupInteraction.positionSmoothingMs': { min: 0, max: 5000 },
  'particles.groupInteraction.relativeSpeedSmoothingMs': { min: 0, max: 5000 },
  'particles.groupInteraction.pairParticleBudget': { min: 0, max: 5000, integer: true },
  'particles.groupInteraction.collectiveParticleBudget': { min: 0, max: 5000, integer: true },
  'particles.groupInteraction.recruitRadius': { min: 0, max: 3000 },
  'particles.groupInteraction.recruitScanPerFrame': { min: 1, max: 100000, integer: true },
  'particles.groupInteraction.spawnPerFrame': { min: 0, max: 100, integer: true },
  'particles.groupInteraction.fadeInMs': { min: 1, max: 10000 },
  'particles.groupInteraction.endInset': { min: 0, max: 1000 },
  'particles.groupInteraction.width': { min: 0, max: 400 },
  'particles.groupInteraction.curvature': { min: 0, max: 1 },
  'particles.groupInteraction.bendSpeed': { min: 0, max: 5 },
  'particles.groupInteraction.flowSpeed': { min: 0, max: 5 },
  'particles.groupInteraction.relativeSpeedBoost': { min: 0, max: 10 },
  'particles.groupInteraction.relativeSpeedFull': { min: 1, max: 10000 },
  'particles.groupInteraction.attraction': { min: 0, max: 1 },
  'particles.groupInteraction.damping': { min: 0.1, max: 0.999 },
  'particles.groupInteraction.maxSpeed': { min: 0.1, max: 100 },
  'particles.groupInteraction.alpha': { min: 0, max: 5 },
  'particles.groupInteraction.size': { min: 0.1, max: 4 },
  'particles.groupInteraction.nodeRatio': { min: 0, max: 1 },
  'particles.groupInteraction.nodeRadius': { min: 0, max: 400 },
  'particles.groupInteraction.nodeSpin': { min: 0, max: 10 },
  'particles.groupInteraction.collectiveAmbientDrift': { min: 0, max: 5 },
  'particles.groupInteraction.collectiveTwinkle': { min: 0, max: 5 },
  'particles.groupInteraction.energyAttackMs': { min: 0, max: 10000 },
  'particles.groupInteraction.energyReleaseMs': { min: 0, max: 10000 },
  'particles.groupInteraction.pairEnergy': { min: 0, max: 1 },
  'particles.groupInteraction.resonanceWindowMs': { min: 0, max: 5000 },
  'particles.groupInteraction.resonanceMaxDelayMs': { min: 0, max: 5000 },
  'particles.groupInteraction.resonanceRadius': { min: 1, max: 2000 },
  'particles.groupInteraction.resonanceDurationMs': { min: 16, max: 10000 },
  'particles.groupInteraction.resonanceGlow': { min: 0, max: 2 },
  'particles.groupInteraction.resonancePush': { min: 0, max: 20 },
  'particles.groupInteraction.resonanceSpawnCount': { min: 0, max: 500, integer: true },
  'particles.groupInteraction.resonanceKick': { min: 0, max: 50 },
  'particles.predictionStableFrames': { min: 1, max: 30, integer: true },
  'particles.predictionMinSpeed': { min: 0, max: 1000 },
  'particles.predictionMaxTrackSpeed': { min: 100, max: 20000 },
  'particles.predictionTurnCosine': { min: -1, max: 0.94 },
  'particles.predictionReversalCosine': { min: -1, max: 0.5 },
  'particles.predictionBrakeRatio': { min: 0, max: 1 },
  'particles.predictionVerticalFactor': { min: 0, max: 1 },
  'particles.predictionRiseMs': { min: 0, max: 1000 },
  'particles.interpolationMaxMs': { min: 0, max: 250 },
  'particles.departureLetGoMs': { min: 1, max: 1000 },
  'particles.gestureSnapRelief': { min: 0, max: 4 },
  'particles.ambientMotionInfluence': { min: 0, max: 1 },
  'particles.ambientCohesion': { min: 0, max: 0.001 },
  'particles.waveOrganicWarp': { min: 0, max: 0.5 },
  'particles.waveSpeed': { min: 0.01, max: 5 },
  'particles.waveWidth': { min: 1, max: 1000 },
  'particles.waveStrength': { min: 0, max: 20 },
  'particles.waveMaxRadius': { min: 10, max: 2000 },
  'particles.waveAmbientFactor': { min: 0, max: 1 },
  'particles.waveGlow': { min: 0, max: 2 },
  'particles.waveGlowRadius': { min: 1, max: 1000 },
  'particles.gestureExciteSize': { min: 0, max: 4 },
  'particles.gestureExciteAlpha': { min: 0, max: 1 },
  'particles.gestureExciteDecayMs': { min: 1, max: 10000 },
  'particles.revealExpandMs': { min: 1, max: 5000 },
  'particles.revealSuspendMs': { min: 0, max: 5000 },
  'particles.revealRecoverMs': { min: 1, max: 5000 },
  'particles.textParticleRatio': { min: 0, max: 0.5 },
  'particles.textParticleMaxTargets': { min: 0, max: 4000, integer: true },
  'particles.textParticleAlpha': { min: 0, max: 1 },
  'particles.textParticleSize': { min: 0.1, max: 3 },
  'particles.textParticleGlow': { min: 0, max: 2 },
  'particles.textTravelAttraction': { min: 0.001, max: 2 },
  'particles.revealTravelMs': { min: 1, max: 10000 },
  'particles.revealHoldMs': { min: 0, max: 30000 },
  'particles.revealReturnMs': { min: 1, max: 10000 },
  'particles.brandTravelMs': { min: 1, max: 10000 },
  'particles.brandReturnMs': { min: 1, max: 10000 },
  'experience.revealDurationMs': { min: 500, max: 30000 },
  'experience.revealTextDelayMs': { min: 0, max: 5000 },
  'experience.brandAfterRevealMs': { min: 0, max: 30000 },
  'experience.brandDurationMs': { min: 500, max: 60000 },
  'particles.revealExpansion': { min: 0, max: 100 },
  'particles.revealSuspension': { min: 0, max: 0.8 },
  'typography.scale': { min: 0.25, max: 5 },
  'layout.sideColumnWidth': { min: 0.1, max: 0.45 },
  'layout.columnFill': { min: 0.3, max: 1 },
  'layout.textBandTop': { min: 0, max: 0.9 },
  'layout.textBandBottom': { min: 0.1, max: 1 },
  'layout.topBand.top': { min: 0, max: 0.9 },
  'layout.topBand.bottom': { min: 0.05, max: 1 },
  'layout.topBand.width': { min: 0.1, max: 1 },
  'layout.maxOccupancy': { min: 0, max: 1 },
  'layout.switchMargin': { min: 0, max: 1 },
  'layout.occupancySmoothingMs': { min: 0, max: 5000 },
  'layout.minSideAspect': { min: 0.5, max: 4 },
  'hands.fps': { min: 1, max: 60 },
  'hands.maxHands': { min: 1, max: 4, integer: true },
  'hands.cropWidth': { min: 64, max: 1024, integer: true, fallback: true },
  'hands.cropHeight': { min: 64, max: 1024, integer: true, fallback: true },
  'hands.roiPalmScale': { min: 1, max: 10 },
  'hands.roiShoulderScale': { min: 0, max: 5 },
  'hands.roiMinPx': { min: 16, max: 2000 },
  'hands.roiMaxPx': { min: 32, max: 4000 },
  'hands.roiHandScale': { min: 1, max: 6 },
  'hands.trackReuseMs': { min: 0, max: 2000 },
  'hands.minWristVisibility': { min: 0, max: 1 },
  'hands.detectionConfidence': { min: 0, max: 1 },
  'hands.presenceConfidence': { min: 0, max: 1 },
  'hands.trackingConfidence': { min: 0, max: 1 },
  'hands.fadeStartMs': { min: 0, max: 5000 },
  'hands.maxAgeMs': { min: 16, max: 5000 },
  'hands.fingerRadius': { min: 0.01, max: 0.5 },
  'hands.thumbRadius': { min: 0.01, max: 0.5 },
  'hands.forearmRadius': { min: 0.01, max: 1 },
  'hands.forearmLength': { min: 0, max: 3 },
  'hands.minFingerWidthCells': { min: 0, max: 5 },
  'hands.segmentationGate': { min: 1, max: 4 },
  'hands.patchReach': { min: 0, max: 3 },
  'hands.patchFeather': { min: 0.01, max: 3 },
  'hands.segmentationOnlyWeight': { min: 0, max: 1 },
  'hands.workerTimeoutMs': { min: 250, max: 60000 },
  'hands.retryDelayMs': { min: 100, max: 120000 },
  'proximity.farSize': { min: 0, max: 1 },
  'proximity.closeSize': { min: 0, max: 2 },
  'experience.gestureCooldown': { min: 0, max: 10000 },
  'experience.idlePromptDurationMs': { min: 500, max: 30000 },
  'experience.idlePromptIntervalMs': { min: 1000, max: 600000 },
  'particles.formationAttractionRadius': { min: 0, max: 3000 },
  'particles.formationAttractionInnerRadius': { min: 1, max: 1000 },
  'particles.formationAttractionWindowMs': { min: 0, max: 30000 },
  'particles.formationAttractionFadeMs': { min: 1, max: 30000 },
  'particles.formationSearchRings': { min: 1, max: 16, integer: true },
  'particles.formationAnticipationGlow': { min: 0, max: 3 },
  'particles.departureStaggerMs': { min: 0, max: 800 },
  'particles.departureCohesionDamping': { min: 0.5, max: 0.999 },
  'particles.magneticResidualAttraction': { min: 0, max: 1 },
  'particles.magneticRadius': { min: 1, max: 2000 },
  'particles.magneticDeflection': { min: 0, max: 1 },
  'particles.idleTwinkle': { min: 0, max: 1 },
  'particles.ambientCohesionRadius': { min: 1, max: 3000 },
  'particles.idleWellSpeed': { min: 0, max: 2 },
  'particles.idleWellWander': { min: 0, max: 0.4 },
};

function get(root: object, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) node = (node as Record<string, unknown>)[key];
  return node;
}

function set(root: object, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = root as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] as Record<string, unknown>;
  node[parts.at(-1)!] = value;
}

function normalizeRect(value: NormalizedRect, fallback: NormalizedRect): NormalizedRect {
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) return { ...fallback };
  const x = Math.min(1, Math.max(0, value.x));
  const y = Math.min(1, Math.max(0, value.y));
  const width = Math.min(1 - x, Math.max(0.01, value.width));
  const height = Math.min(1 - y, Math.max(0.01, value.height));
  return { x, y, width, height };
}

/** Última barrera antes de usar configuración: nunca deja pasar NaN, infinitos o rangos peligrosos. */
export function validateConfig(input: Config): Config {
  const config = structuredClone(input);
  if (config.displayProfile !== 'standard' && config.displayProfile !== 'large') config.displayProfile = defaultConfig.displayProfile;
  replaceNonFinite(config, defaultConfig);
  for (const [path, rule] of Object.entries(NUMBER_RULES)) {
    const value = get(config, path);
    const fallback = get(defaultConfig, path) as number;
    let normalized = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    if (rule.fallback && (normalized < rule.min || normalized > rule.max)) normalized = fallback;
    else normalized = Math.min(rule.max, Math.max(rule.min, normalized));
    if (rule.integer) normalized = Math.round(normalized);
    set(config, path, normalized);
  }

  config.camera.crop = normalizeRect(config.camera.crop, defaultConfig.camera.crop);
  // Sin cámara no hay nada que recortar al capturar: la silueta sintética ya llega completa.
  if (config.mockVision) config.vision.cropAtCapture = false;
  const delays = config.camera.retryDelaysMs;
  config.camera.retryDelaysMs = Array.isArray(delays)
    ? delays.filter((value) => Number.isFinite(value) && value >= 100 && value <= 300000).map((value) => Math.round(value))
    : [];
  if (config.camera.retryDelaysMs.length === 0) config.camera.retryDelaysMs = [...defaultConfig.camera.retryDelaysMs];

  config.gestures.lowerMargin = Math.min(config.gestures.lowerMargin, config.gestures.raiseMargin - 0.005);
  config.vision.poseFPS = Math.min(config.vision.poseFPS, config.vision.processingFPS);
  config.particles.idleParticleCount = Math.min(config.particles.idleParticleCount, config.particles.particleCount);
  config.particles.bodyParticleBudget = Math.min(config.particles.bodyParticleBudget, config.particles.particleCount);
  if (config.layout.textBandBottom <= config.layout.textBandTop) {
    config.layout.textBandTop = defaultConfig.layout.textBandTop;
    config.layout.textBandBottom = defaultConfig.layout.textBandBottom;
  }
  if (config.layout.topBand.bottom <= config.layout.topBand.top) config.layout.topBand = { ...defaultConfig.layout.topBand };
  if (config.particles.fastMotionSpeed.full <= config.particles.fastMotionSpeed.start) {
    config.particles.fastMotionSpeed = { ...defaultConfig.particles.fastMotionSpeed };
  }
  const living = config.particles.livingBody;
  if (living.trailSpeed.full <= living.trailSpeed.start) living.trailSpeed = { ...defaultConfig.particles.livingBody.trailSpeed };
  const group = config.particles.groupInteraction;
  if (group.connectionDistance.far <= group.connectionDistance.near) {
    group.connectionDistance = { ...defaultConfig.particles.groupInteraction.connectionDistance };
  }
  if (config.proximity.closeSize <= config.proximity.farSize) {
    config.proximity.farSize = defaultConfig.proximity.farSize;
    config.proximity.closeSize = defaultConfig.proximity.closeSize;
  }
  if (config.hands.roiMaxPx <= config.hands.roiMinPx) {
    config.hands.roiMinPx = defaultConfig.hands.roiMinPx;
    config.hands.roiMaxPx = defaultConfig.hands.roiMaxPx;
  }
  if (config.hands.maxAgeMs <= config.hands.fadeStartMs) config.hands.fadeStartMs = config.hands.maxAgeMs * 0.5;
  if (config.calibrationMode) config.debugMode = true;
  return config;
}

function replaceNonFinite(value: unknown, fallback: unknown): void {
  if (!value || typeof value !== 'object' || !fallback || typeof fallback !== 'object') return;
  const target = value as Record<string, unknown>;
  const defaults = fallback as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const expected = defaults[key];
    const current = target[key];
    if (typeof expected === 'number' && (typeof current !== 'number' || !Number.isFinite(current))) target[key] = expected;
    else if (typeof expected === 'object') replaceNonFinite(current, expected);
  }
}
