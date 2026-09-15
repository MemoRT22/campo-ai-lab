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
  'particles.particleAttraction': { min: 0, max: 2 },
  'particles.particleDamping': { min: 0.1, max: 0.99 },
  'particles.trackingAttraction': { min: 0, max: 2 },
  'particles.trackingDamping': { min: 0.1, max: 0.99 },
  'particles.trackingResponseMs': { min: 16, max: 1000 },
  'particles.predictionMs': { min: 0, max: 120 },
  'particles.predictionMaxDistance': { min: 0, max: 120 },
  'particles.predictionSmoothingMs': { min: 0, max: 1000 },
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
  'particles.fastMotionTrailRatio': { min: 0, max: 0.5 },
  'particles.fastMotionTrail': { min: 0, max: 1 },
  'particles.predictionStableFrames': { min: 1, max: 30, integer: true },
  'particles.predictionMinSpeed': { min: 0, max: 1000 },
  'particles.predictionMaxTrackSpeed': { min: 100, max: 20000 },
  'particles.predictionTurnCosine': { min: -1, max: 0.94 },
  'particles.predictionReversalCosine': { min: -1, max: 0.5 },
  'particles.predictionBrakeRatio': { min: 0, max: 1 },
  'particles.predictionVerticalFactor': { min: 0, max: 1 },
  'particles.predictionRiseMs': { min: 0, max: 1000 },
  'particles.interpolationMaxMs': { min: 0, max: 100 },
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
  if (config.proximity.closeSize <= config.proximity.farSize) {
    config.proximity.farSize = defaultConfig.proximity.farSize;
    config.proximity.closeSize = defaultConfig.proximity.closeSize;
  }
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
