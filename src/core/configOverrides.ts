import { defaultConfig, type Config, type DisplayProfile } from '../config';
import { validateConfig } from './configValidation';

const ALIASES: Record<string, string> = {
  debug: 'debugMode',
  mock: 'mockVision',
  calibrate: 'calibrationMode',
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copia la configuración por defecto y aplica parámetros de la URL.
 *   ?debug                       → debugMode = true
 *   ?camera=Logitech | ?camera=1 → cámara por nombre o índice
 *   ?vision.maskThreshold=0.5    → cualquier valor por su ruta
 *   ?camera.crop={"x":0,"y":0.1,"width":1,"height":0.9}
 */
export const CALIBRATION_STORAGE_KEY = 'campo:technical-calibration:v1';
export const CALIBRATION_PATHS = new Set([
  'displayProfile',
  'vision.maskThreshold',
  'vision.maskHysteresis',
  'vision.minPersonArea',
  'vision.smoothingAttackMs',
  'vision.smoothingReleaseMs',
  'vision.spatialBlurRadius',
  'vision.inferenceWidth',
  'vision.processingFPS',
  'vision.poseFPS',
  'vision.cropAtCapture',
  'vision.poseDetectionConfidence',
  'camera.cameraWidth',
  'camera.cameraHeight',
  'camera.frameRate',
  'camera.crop',
  'typography.scale',
  'layout.sideColumnWidth',
  'particles.particleSpacing',
  'particles.bodyParticleBudget',
  'particles.particleDensity.far',
  'particles.particleDensity.close',
  'particles.particleSize.idle',
  'particles.particleSize.far',
  'particles.particleSize.close',
  'particles.particleOpacity.far',
  'particles.particleOpacity.close',
  'particles.silhouette.contourThreshold',
  'particles.silhouette.contourHysteresis',
  'particles.silhouette.edgeSize',
  'particles.edgeBrightness',
  'particles.occlusionGraceMs',
  'particles.trackingResponseMs',
  'particles.trackingAttraction',
  'particles.trackingDamping',
  'particles.trackingSnap',
  'particles.fastMotionSnap',
  'particles.interpolationMaxMs',
  'particles.predictionMs',
  'particles.predictionMaxDistance',
  'particles.interpolationIntervalFactor',
  'particles.maxSpeed',
]);

/**
 * Preset conservador para una salida física grande. No duplica la configuración: parte de STANDARD
 * y sólo cambia los parámetros que dependen de distancia de cámara y legibilidad del display.
 */
export function applyDisplayProfile(config: Config, profile: DisplayProfile): void {
  config.displayProfile = profile;
  if (profile !== 'large') return;

  config.vision.inferenceWidth = 480;
  config.vision.maskThreshold = 0.56;
  config.vision.maskHysteresis = 0.22;
  config.vision.smoothingReleaseMs = 90;
  // Una persona a 7–8 m ocupa muy pocos píxeles del modelo: el filtro de área no puede descartarla.
  config.vision.minPersonArea = 0.0015;
  // Pose sólo alimenta los gestos; bajarla deja la GPU para la silueta, que es lo que se ve.
  config.vision.poseFPS = 10;

  // La pared es grande y la cámara está lejos: el adelanto en px tiene que crecer con ella.
  config.particles.predictionMs = 50;
  config.particles.predictionMaxDistance = 40;

  config.particles.bodyParticleBudget = 19000;
  config.particles.particleSpacing = 5.2;
  config.particles.particleDensity = { far: 1, close: 1 };
  config.particles.particleSize = { idle: 1.9, far: 2.75, close: 3.05 };
  config.particles.particleOpacity = { idle: 0.34, far: 0.78, close: 0.95 };
  config.particles.silhouette.contourThreshold = 0.47;
  config.particles.silhouette.contourHysteresis = 0.08;
  config.particles.silhouette.edgeSize = 1.12;
  config.particles.edgeBrightness = 1.48;
  config.particles.occlusionGraceMs = 150;
  config.typography.scale = 1.18;
}

export function resolveConfig(search: string, storedOverrides: Record<string, unknown> | null = readCalibrationOverrides()): Config {
  const config = structuredClone(defaultConfig);
  const params = new URLSearchParams(search);
  const storedProfile = storedOverrides?.displayProfile;
  const requestedProfile = params.get('displayProfile') ?? (typeof storedProfile === 'string' ? storedProfile : null);
  applyDisplayProfile(config, requestedProfile === 'large' ? 'large' : 'standard');

  if (storedOverrides) {
    for (const [path, value] of Object.entries(storedOverrides)) {
      if (!CALIBRATION_PATHS.has(path)) continue;
      if (path === 'displayProfile') continue;
      applyValue(config as unknown as Record<string, unknown>, path.split('.'), value);
    }
  }

  for (const [key, value] of params) {
    if (key === 'camera') {
      if (/^\d+$/.test(value)) config.camera.deviceIndex = Number(value);
      else config.camera.deviceLabel = value;
      continue;
    }
    const path = (ALIASES[key] ?? key).split('.');
    if (!applyOverride(config as unknown as Record<string, unknown>, path, value)) {
      console.warn(`[config] Parámetro ignorado: ${key}=${value}`);
    }
  }
  return validateConfig(config);
}

export function readCalibrationOverrides(): Record<string, unknown> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function saveCalibrationOverrides(values: Record<string, unknown>): void {
  const safe = Object.fromEntries(Object.entries(values).filter(([path]) => CALIBRATION_PATHS.has(path)));
  try {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(safe));
  } catch (error) {
    console.warn('[calibration] No se pudieron guardar los ajustes locales', error);
  }
}

function applyOverride(root: Record<string, unknown>, path: string[], raw: string): boolean {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = node[path[i]];
    if (FORBIDDEN_KEYS.has(path[i]) || !Object.hasOwn(node, path[i]) || typeof next !== 'object' || next === null) return false;
    node = next as Record<string, unknown>;
  }

  const key = path[path.length - 1];
  if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key)) return false;
  const current = node[key];

  switch (typeof current) {
    case 'number': {
      const parsed = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(parsed)) return false;
      node[key] = parsed;
      return true;
    }
    case 'boolean':
      node[key] = raw === '' || raw === 'true' || raw === '1';
      return true;
    case 'string':
      node[key] = raw;
      return true;
    case 'object': {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) !== Array.isArray(current)) return false;
        node[key] = Array.isArray(parsed) ? parsed : { ...(current as object), ...parsed };
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function applyValue(root: Record<string, unknown>, path: string[], value: unknown): boolean {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = node[key];
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key) || typeof next !== 'object' || next === null) return false;
    node = next as Record<string, unknown>;
  }
  const key = path.at(-1)!;
  if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key)) return false;
  const current = node[key];
  if (typeof current !== typeof value) return false;
  if (typeof current === 'object' && (current === null || value === null || Array.isArray(current) !== Array.isArray(value))) return false;
  node[key] = typeof current === 'object' && !Array.isArray(current) ? { ...current, ...(value as object) } : value;
  return true;
}
