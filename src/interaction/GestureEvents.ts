/**
 * Contrato entre reconocimiento de gestos y reacción visual.
 *
 * Fase 4: un GestureRecognizer basado en pose landmarks emitirá estos eventos.
 * Mientras tanto, el modo debug los simula con las teclas 1 y 2.
 */

export type GestureType = 'hand-raised' | 'both-hands-raised';

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
  source: 'pose' | 'simulated';
}
