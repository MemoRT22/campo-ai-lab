export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Factor de interpolación independiente del framerate para una constante de tiempo `tauMs`. */
export function expAlpha(dtMs: number, tauMs: number): number {
  return tauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tauMs);
}

const REFERENCE_AREA = 1920 * 1080;
const MIN_SCREEN_SCALE = 0.7;

/**
 * Escala respecto a Full HD para que la composición se vea igual en cualquier resolución.
 * Tiene un mínimo: en una laptop los puntos no deben volverse sub-pixel.
 */
export function screenScale(width: number, height: number): number {
  return Math.max(MIN_SCREEN_SCALE, Math.sqrt((width * height) / REFERENCE_AREA));
}

/** PRNG determinista (mulberry32). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
