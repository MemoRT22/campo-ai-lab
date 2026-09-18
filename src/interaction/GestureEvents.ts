/**
 * Contrato entre reconocimiento de gestos y reacción visual.
 *
 * GestureRecognizer los emite desde Pose; debug también puede simularlos con 1 y 2.
 */

export type GestureType = 'ONE_HAND_UP' | 'BOTH_HANDS_UP';

export interface GesturePoint {
  /** Coordenadas normalizadas en el espacio de la cámara, igual que PersonInfo. */
  x: number;
  y: number;
}

export interface GestureEvent {
  type: GestureType;
  /** Id anónimo de la silueta (PersonInfo.id), o -1 si no se pudo asociar. */
  personId: number;
  points: GesturePoint[];
  timestamp: number;
  confidence: number;
  source: 'pose' | 'simulated';
}
