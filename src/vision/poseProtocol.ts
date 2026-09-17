import type { Delegate } from '../config';
import type { PoseInfo } from './types';

export interface PoseInitMessage {
  type: 'init';
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: Delegate;
  settings: import('../config').Config['vision'];
}

export interface PoseFrameMessage {
  type: 'frame';
  id: number;
  bitmap: ImageBitmap;
}

export type PoseToWorker = PoseInitMessage | PoseFrameMessage;

export interface PoseReadyMessage {
  type: 'ready';
}

export interface PoseResultMessage {
  type: 'result';
  id: number;
  poses: PoseInfo[];
  inferenceMs: number;
}

export interface PoseErrorMessage {
  type: 'error';
  message: string;
}

export type PoseFromWorker = PoseReadyMessage | PoseResultMessage | PoseErrorMessage;
