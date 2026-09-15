import type { Delegate } from '../config';
import type { MaskProcessorSettings } from './MaskProcessor';
import type { PersonInfo, PoseInfo } from './types';

export interface InitMessage {
  type: 'init';
  wasmBaseUrl: string;
  modelUrl: string;
  poseModelUrl: string;
  poseWasmBaseUrl: string;
  delegate: Delegate;
  settings: MaskProcessorSettings;
  visionSettings: import('../config').Config['vision'];
}

export interface FrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  timestamp: number;
  /** Buffer de un personMap anterior que el worker puede reutilizar. */
  recycled: ArrayBuffer | null;
}

export type ToWorker = InitMessage | FrameMessage;

export interface ReadyMessage {
  type: 'ready';
  delegate: Delegate;
  labels: string[];
}

export interface ResultMessage {
  type: 'result';
  width: number;
  height: number;
  personMap: ArrayBuffer;
  people: PersonInfo[];
  timestamp: number;
  inferenceMs: number;
  processingMs: number;
  poses: PoseInfo[];
  poseTimestamp: number | null;
  poseInferenceMs: number;
}

export interface SkippedMessage {
  type: 'skipped';
  recycled: ArrayBuffer | null;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  fatal: boolean;
  /** Falló la inicialización (modelo o delegado), no una inferencia aislada. */
  duringInit: boolean;
}

export type FromWorker = ReadyMessage | ResultMessage | SkippedMessage | ErrorMessage;
