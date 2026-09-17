import type { Delegate, NormalizedRect } from '../config';
import type { HandSettings } from './handGeometry';

export interface HandsInitMessage {
  type: 'init';
  /** Dos copias del mismo runtime: dos tareas de MediaPipe no pueden compartir el módulo ESM. */
  landmarkerWasmBaseUrl: string;
  segmenterWasmBaseUrl: string;
  modelUrl: string;
  segmenterModelUrl: string;
  delegate: Delegate;
  segmentation: boolean;
  settings: HandSettings;
}

export interface HandsCrop {
  bitmap: ImageBitmap;
  roi: NormalizedRect;
}

export interface HandsFrameMessage {
  type: 'frame';
  id: number;
  crops: HandsCrop[];
}

export type HandsToWorker = HandsInitMessage | HandsFrameMessage;

export interface HandsReadyMessage {
  type: 'ready';
  delegate: Delegate;
  segmentation: boolean;
}

export interface HandResult {
  /** 21 puntos (x, y) normalizados dentro del recorte; null si no se detectó la mano. */
  landmarks: Float32Array | null;
  score: number;
  /** Confianza 0..255 del recorte segmentado; null si la segmentación está apagada o falló. */
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
}

export interface HandsResultMessage {
  type: 'result';
  id: number;
  hands: HandResult[];
  inferenceMs: number;
}

export interface HandsErrorMessage {
  type: 'error';
  message: string;
  duringInit: boolean;
}

export type HandsFromWorker = HandsReadyMessage | HandsResultMessage | HandsErrorMessage;
