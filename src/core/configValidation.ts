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
  'particles.ambientMotionInfluence': { min: 0, max: 1 },
  'particles.ambientCohesion': { min: 0, max: 0.001 },
  'particles.waveOrganicWarp': { min: 0, max: 0.5 },
  'particles.revealExpansion': { min: 0, max: 100 },
  'particles.revealSuspension': { min: 0, max: 0.8 },
  'typography.scale': { min: 0.25, max: 5 },
  'proximity.farSize': { min: 0, max: 1 },
  'proximity.closeSize': { min: 0, max: 2 },
  'experience.gestureCooldown': { min: 0, max: 10000 },
  'experience.idlePromptDurationMs': { min: 500, max: 30000 },
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
