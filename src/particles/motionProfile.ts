import type { Config } from '../config';
import { smoothstep } from '../utils/MathUtils';

/**
 * Fases de movimiento de una partícula de cuerpo. Cada una usa sus propios tiempos:
 *   formation  entra desde el campo con un resorte suave (cinematográfico)
 *   tracking   cuerpo ya formado: resorte firme + acercamiento directo (espejo)
 *   fast       caminar rápido / transporte reciente: más firme, con leve estela
 *   departure  el track desapareció: suelta el target y conserva su momentum
 */
export const MOTION_PHASES = ['formation', 'tracking', 'fast', 'departure'] as const;
export type MotionPhase = (typeof MOTION_PHASES)[number];

type MotionSettings = Pick<Config['particles'], 'trackingBondThreshold' | 'fastMotionSpeed' | 'trackingResponseMs'>;

/** 0 mientras la partícula se forma; 1 cuando su enlace supera el umbral de seguimiento. */
export function trackingWeight(bond: number, settings: MotionSettings): number {
  return smoothstep(settings.trackingBondThreshold, 1, bond);
}

/** Cuánto del perfil rápido corresponde a la velocidad del track (px/s de pantalla). */
export function speedFastBlend(trackSpeed: number, settings: MotionSettings, screenScale: number): number {
  const { start, full } = settings.fastMotionSpeed;
  return smoothstep(start * screenScale, full * screenScale, trackSpeed);
}

/** Tras un transporte BODY → BODY la partícula usa el perfil rápido y lo suelta linealmente. */
export function retargetFastBlend(retargetAgeMs: number, settings: MotionSettings): number {
  return retargetAgeMs >= 0 && retargetAgeMs < settings.trackingResponseMs ? 1 - retargetAgeMs / settings.trackingResponseMs : 0;
}

export function motionPhaseIndex(formed: number, fast: number, departing: boolean): number {
  if (departing) return 3;
  if (formed < 0.5) return 0;
  return fast >= 0.5 ? 2 : 1;
}

/** Convierte un factor por frame de 60 Hz a un paso de integración de `frames` frames. */
export function perFrameFactor(factor: number, frames: number): number {
  return 1 - Math.pow(1 - factor, frames);
}
