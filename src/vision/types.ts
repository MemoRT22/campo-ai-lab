import type { Delegate } from '../config';

/**
 * Una silueta detectada en el frame actual. No contiene identidad: `id` sólo asocia
 * la misma mancha entre frames consecutivos y se descarta al perderla.
 */
export interface PersonInfo {
  id: number;
  /** Valor con el que aparece en `personMap` menos 1. Puede cambiar entre frames. */
  slot: number;
  /** Caja envolvente normalizada [0, 1] en el espacio de la cámara (sin espejo). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  /** Fracción de la región útil ocupada. */
  area: number;
  /** 0 = lejos, 1 = cerca. Suavizado en el tiempo. */
  proximity: number;
  /** Persistió lo suficiente para no ser ruido. */
  confirmed: boolean;
}

export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** Landmarks transitorios de una pose; nunca se persisten ni salen de la máquina. */
export interface PoseInfo {
  landmarks: PoseLandmark[];
}

export interface VisionFrame {
  width: number;
  height: number;
  /** 0 = fondo, n = people[n − 1]. Válido sólo hasta la siguiente llamada a takeFrame(). */
  personMap: Uint8Array;
  /**
   * Confianza suavizada 0..255 del mismo tamaño que `personMap`. Si falta, la silueta se muestrea
   * como máscara binaria (sin contorno subpíxel).
   */
  confidenceMap?: Uint8Array;
  people: PersonInfo[];
  /** performance.now() del hilo principal en el momento de la captura. */
  timestamp: number;
  inferenceMs: number;
  processingMs: number;
  poses: PoseInfo[];
  /** null cuando este resultado sólo ejecutó segmentación. */
  poseTimestamp: number | null;
  poseInferenceMs: number;
}

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'live'
  | 'reconnecting'
  | 'denied'
  | 'not-found'
  | 'busy'
  | 'unsupported'
  | 'error';

export type ModelStatus = 'off' | 'loading' | 'ready' | 'error';
export type WorkerStatus = 'off' | 'starting' | 'ready' | 'busy' | 'backoff';

export interface VisionStatus {
  camera: CameraStatus;
  cameraDetail: string;
  cameras: string[];
  model: ModelStatus;
  delegate: Delegate | null;
  labels: string[];
  lastError: string;
  worker: WorkerStatus;
  consecutiveFailures: number;
  fallbackReason: string;
  cameraFps: number;
}

export interface VisionSource {
  readonly status: VisionStatus;
  /** performance.now() del último resultado recibido. */
  readonly lastFrameAt: number;
  /** Sólo para el panel de debug. */
  readonly debugVideo: HTMLVideoElement | null;
  start(): void;
  update(now: number): void;
  takeFrame(): VisionFrame | null;
  stop(): void;
}

export function createVisionStatus(): VisionStatus {
  return {
    camera: 'idle',
    cameraDetail: '',
    cameras: [],
    model: 'off',
    delegate: null,
    labels: [],
    lastError: '',
    worker: 'off',
    consecutiveFailures: 0,
    fallbackReason: '',
    cameraFps: 0,
  };
}
