import type { Config, NormalizedRect } from '../config';
import type { PoseLandmark } from './types';

export type HandSettings = Config['hands'];

export const HAND_LANDMARKS = 21;
export const MAX_HANDS = 4;

/** Muñeca, CMC del pulgar y nudillos (MCP) de índice, medio, anular y meñique. */
const WRIST = 0;
const THUMB_CMC = 1;
const MIDDLE_MCP = 9;
const PALM_POLYGON = [0, 1, 5, 9, 13, 17] as const;

/** Huesos de dedos (pulgar incluido): definen el grosor y la zona donde la mano manda. */
const FINGER_BONES = [
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
] as const;
/** Bordes de la palma. */
const PALM_BONES = [[0, 1], [1, 5], [5, 9], [9, 13], [13, 17], [17, 0]] as const;
const THUMB_BONES = 3;
/** Dedos + palma + antebrazo. */
const BONE_COUNT = FINGER_BONES.length + PALM_BONES.length + 1;
const BONE_STRIDE = 5;

/** Pose Landmarker: muñeca, meñique, índice, pulgar y hombros (MediaPipe Pose, 33 puntos). */
const POSE_HAND = {
  left: { wrist: 15, pinky: 17, index: 19, thumb: 21 },
  right: { wrist: 16, pinky: 18, index: 20, thumb: 22 },
} as const;
const POSE_LEFT_SHOULDER = 11;
const POSE_RIGHT_SHOULDER = 12;

export type HandSide = keyof typeof POSE_HAND;

/**
 * Una mano observada en un recorte de alta resolución. Coordenadas normalizadas en el espacio de
 * la cámara completa (sin espejo), igual que PersonInfo. Transitoria: nunca se persiste.
 */
export interface HandObservation {
  /** Silueta a la que pertenece (PersonInfo.id) o -1 si se deduce de la máscara. */
  personId: number;
  /** performance.now() de la captura. */
  timestamp: number;
  /** 21 puntos (x, y) normalizados en cámara; longitud 0 si el Hand Landmarker no vio la mano. */
  landmarks: Float32Array;
  score: number;
  /** Recorte analizado, normalizado en cámara. */
  roi: NormalizedRect;
  /** Confianza 0..255 de la segmentación del recorte, o null. */
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
}

export function capsuleDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Muestreo bilineal de un mapa 0..255 en coordenadas de píxel (centros en +0.5); devuelve 0..1. */
export function sampleUint8(data: Uint8Array, width: number, height: number, x: number, y: number): number {
  if (width < 2 || height < 2) return 0;
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  if (x0 < 0) x0 = 0;
  else if (x0 > width - 2) x0 = width - 2;
  if (y0 < 0) y0 = 0;
  else if (y0 > height - 2) y0 = height - 2;
  let tx = fx - x0;
  let ty = fy - y0;
  tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
  ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
  const i = y0 * width + x0;
  const top = data[i] + (data[i + 1] - data[i]) * tx;
  const bottom = data[i + width] + (data[i + width + 1] - data[i + width]) * tx;
  return (top + (bottom - top) * ty) / 255;
}

/**
 * Forma de una mano en un espacio de píxeles (el de la máscara general). A partir de los 21 puntos
 * construye cápsulas para dedos, bordes de palma y antebrazo, más el polígono de la palma.
 */
export class HandShape {
  palmLength = 0;
  fingerRadius = 0;
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;
  private readonly bones = new Float32Array(BONE_COUNT * BONE_STRIDE);
  private readonly polygon = new Float32Array(PALM_POLYGON.length * 2);

  /**
   * `landmarks` normalizados en cámara; `scaleX/scaleY` los llevan al espacio destino.
   * `minRadius` evita dedos más finos que la retícula. Devuelve false si la mano es degenerada.
   */
  prepare(landmarks: Float32Array, scaleX: number, scaleY: number, settings: HandSettings, minRadius: number): boolean {
    if (landmarks.length < HAND_LANDMARKS * 2) return false;
    const x = (k: number) => landmarks[k * 2] * scaleX;
    const y = (k: number) => landmarks[k * 2 + 1] * scaleY;
    const palm = Math.hypot(x(MIDDLE_MCP) - x(WRIST), y(MIDDLE_MCP) - y(WRIST));
    if (!(palm > 1e-3)) return false;
    this.palmLength = palm;
    const finger = Math.max(minRadius, settings.fingerRadius * palm);
    const thumb = Math.max(minRadius, settings.thumbRadius * palm);
    this.fingerRadius = finger;

    let b = 0;
    const bones = this.bones;
    const put = (ax: number, ay: number, bx: number, by: number, radius: number) => {
      bones[b++] = ax;
      bones[b++] = ay;
      bones[b++] = bx;
      bones[b++] = by;
      bones[b++] = radius;
    };
    FINGER_BONES.forEach(([from, to], index) => put(x(from), y(from), x(to), y(to), index < THUMB_BONES ? thumb : finger));
    for (const [from, to] of PALM_BONES) put(x(from), y(from), x(to), y(to), finger);
    // Antebrazo: continúa desde la muñeca en sentido opuesto al nudillo medio.
    const dirX = (x(WRIST) - x(MIDDLE_MCP)) / palm;
    const dirY = (y(WRIST) - y(MIDDLE_MCP)) / palm;
    const forearm = settings.forearmLength * palm;
    put(x(WRIST), y(WRIST), x(WRIST) + dirX * forearm, y(WRIST) + dirY * forearm, Math.max(minRadius, settings.forearmRadius * palm));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < BONE_COUNT; k++) {
      const o = k * BONE_STRIDE;
      const r = bones[o + 4];
      minX = Math.min(minX, bones[o] - r, bones[o + 2] - r);
      maxX = Math.max(maxX, bones[o] + r, bones[o + 2] + r);
      minY = Math.min(minY, bones[o + 1] - r, bones[o + 3] - r);
      maxY = Math.max(maxY, bones[o + 1] + r, bones[o + 3] + r);
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    PALM_POLYGON.forEach((k, i) => {
      this.polygon[i * 2] = x(k);
      this.polygon[i * 2 + 1] = y(k);
    });
    return true;
  }

  /** Distancia firmada a la superficie de la mano (negativa dentro), incluido el antebrazo. */
  signedDistance(px: number, py: number): number {
    const bones = this.bones;
    let best = Infinity;
    for (let o = 0; o < bones.length; o += BONE_STRIDE) {
      const d = capsuleDistance(px, py, bones[o], bones[o + 1], bones[o + 2], bones[o + 3]) - bones[o + 4];
      if (d < best) best = d;
    }
    if (best > 0 && this.insidePalm(px, py)) best = -this.fingerRadius;
    return best;
  }

  /** Distancia a la superficie de los dedos: la mano sólo reemplaza a la máscara general cerca de ellos. */
  fingerDistance(px: number, py: number): number {
    const bones = this.bones;
    let best = Infinity;
    const end = FINGER_BONES.length * BONE_STRIDE;
    for (let o = 0; o < end; o += BONE_STRIDE) {
      const d = capsuleDistance(px, py, bones[o], bones[o + 1], bones[o + 2], bones[o + 3]) - bones[o + 4];
      if (d < best) best = d;
    }
    return best;
  }

  private insidePalm(px: number, py: number): boolean {
    const polygon = this.polygon;
    const n = polygon.length / 2;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i * 2];
      const yi = polygon[i * 2 + 1];
      const xj = polygon[j * 2];
      const yj = polygon[j * 2 + 1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}

/**
 * Recorte con la relación de aspecto del modelo, centrado en (cx, cy) y con alto `side` (px de
 * cámara). Se desplaza para quedar dentro del cuadro. Escribe en `out` (normalizado).
 */
export function fitRoi(cx: number, cy: number, side: number, aspect: number, cameraWidth: number, cameraHeight: number, out: NormalizedRect): NormalizedRect {
  let height = Math.min(side, cameraHeight);
  let width = height * aspect;
  if (width > cameraWidth) {
    width = cameraWidth;
    height = width / aspect;
  }
  const left = Math.min(Math.max(cx * cameraWidth - width / 2, 0), cameraWidth - width);
  const top = Math.min(Math.max(cy * cameraHeight - height / 2, 0), cameraHeight - height);
  out.x = left / cameraWidth;
  out.y = top / cameraHeight;
  out.width = width / cameraWidth;
  out.height = height / cameraHeight;
  return out;
}

/**
 * Recorte de una mano a partir de Pose. El tamaño combina la palma estimada (muñeca → índice/meñique)
 * y el ancho de hombros, porque los puntos de mano de Pose son ruidosos. null si la muñeca no se ve.
 */
export function roiFromPose(
  pose: PoseLandmark[],
  side: HandSide,
  cameraWidth: number,
  cameraHeight: number,
  settings: HandSettings,
  out: NormalizedRect,
): NormalizedRect | null {
  const points = POSE_HAND[side];
  const wrist = pose[points.wrist];
  const index = pose[points.index];
  const pinky = pose[points.pinky];
  if (!wrist || !index || !pinky || wrist.visibility < settings.minWristVisibility) return null;
  const knuckleX = (index.x + pinky.x) / 2;
  const knuckleY = (index.y + pinky.y) / 2;
  const palm = Math.hypot((knuckleX - wrist.x) * cameraWidth, (knuckleY - wrist.y) * cameraHeight);
  const leftShoulder = pose[POSE_LEFT_SHOULDER];
  const rightShoulder = pose[POSE_RIGHT_SHOULDER];
  const shoulders = leftShoulder && rightShoulder
    ? Math.hypot((leftShoulder.x - rightShoulder.x) * cameraWidth, (leftShoulder.y - rightShoulder.y) * cameraHeight)
    : 0;
  // Tamaño natural antes de acotarlo: es la medida honesta de cuánta mano hay en el sensor.
  const natural = Math.max(settings.roiPalmScale * palm, settings.roiShoulderScale * shoulders);
  if (natural < settings.minHandPx) return null;
  const size = Math.min(settings.roiMaxPx, Math.max(settings.roiMinPx, natural));
  // El centro de la mano está más allá de la muñeca, hacia los nudillos.
  const cx = wrist.x + (knuckleX - wrist.x) * 1.2;
  const cy = wrist.y + (knuckleY - wrist.y) * 1.2;
  return fitRoi(cx, cy, size, settings.cropWidth / settings.cropHeight, cameraWidth, cameraHeight, out);
}

/** Recorte a partir de los 21 puntos de una observación anterior: sigue a la mano con más precisión que Pose. */
export function roiFromHand(landmarks: Float32Array, cameraWidth: number, cameraHeight: number, settings: HandSettings, out: NormalizedRect): NormalizedRect | null {
  if (landmarks.length < HAND_LANDMARKS * 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < HAND_LANDMARKS; k++) {
    minX = Math.min(minX, landmarks[k * 2]);
    maxX = Math.max(maxX, landmarks[k * 2]);
    minY = Math.min(minY, landmarks[k * 2 + 1]);
    maxY = Math.max(maxY, landmarks[k * 2 + 1]);
  }
  const extent = Math.max((maxX - minX) * cameraWidth, (maxY - minY) * cameraHeight);
  const size = Math.min(settings.roiMaxPx, Math.max(settings.roiMinPx, settings.roiHandScale * extent));
  return fitRoi((minX + maxX) / 2, (minY + maxY) / 2, size, settings.cropWidth / settings.cropHeight, cameraWidth, cameraHeight, out);
}

/** Pasa puntos normalizados de un recorte a coordenadas normalizadas de la cámara completa. */
export function cropToCamera(points: Float32Array, roi: NormalizedRect): Float32Array {
  for (let i = 0; i < points.length; i += 2) {
    points[i] = roi.x + points[i] * roi.width;
    points[i + 1] = roi.y + points[i + 1] * roi.height;
  }
  return points;
}

/** Posición de la muñeca de una observación (o el centro del recorte si no hay landmarks). */
export function handAnchor(hand: HandObservation): { x: number; y: number } {
  if (hand.landmarks.length >= 2) return { x: hand.landmarks[0], y: hand.landmarks[1] };
  return { x: hand.roi.x + hand.roi.width / 2, y: hand.roi.y + hand.roi.height / 2 };
}

export { THUMB_CMC };
