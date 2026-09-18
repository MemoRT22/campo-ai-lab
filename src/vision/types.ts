import type { Delegate } from '../config';
import type { HandObservation } from './handGeometry';

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
  /** Tamaño real del bitmap entregado al pipeline antes del resize interno del modelo. */
  inputWidth?: number;
  inputHeight?: number;
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
  /** Timestamp original de la captura a partir de la cual se inferió la pose actual. */
  poseTimestamp: number | null;
  poseInferenceMs: number;
  /**
   * Manos analizadas en alta resolución, con su propio reloj: llegan a otro ritmo que la máscara y
   * cada una caduca sola. Vacío si el análisis de manos está apagado o no ve ninguna.
   */
  hands?: HandObservation[];
}

export interface TrackerStatus {
  state: 'off' | 'loading' | 'ready' | 'error';
  fps: number;
  inferenceMs: number;
  lastError: string;
}

export interface HandTrackerStatus extends TrackerStatus {
  segmentation: boolean;
  hands: number;
}

export type PoseTrackerStatus = TrackerStatus;

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

export interface CameraDiagnostics {
  label: string;
  /** Índice efímero de la cámara en esta sesión. No expone el deviceId persistente. */
  deviceIndex: number;
  requestedWidth: number;
  requestedHeight: number;
  requestedFps: number;
  deliveredWidth: number;
  deliveredHeight: number;
  deliveredFps: number;
  aspectRatio: number;
  /**
   * Del sensor al navegador: exposición, USB y buffers del driver. No se puede bajar desde el
   * código; si es alta, el retraso está antes de que la web vea nada.
   */
  captureLatencyMs: number;
}

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
  cameraInfo: CameraDiagnostics;
  /** Milisegundos entre pedir el bitmap de la cámara y recibirlo. Es coste del hilo principal. */
  captureMs: number;
  /** Capturas por segundo realmente enviadas a los modelos. */
  captureFps: number;
  pose: PoseTrackerStatus;
  hands: HandTrackerStatus;
}

export interface VisionSource {
  readonly status: VisionStatus;
  /** performance.now() del último resultado recibido del pipeline de BODY. */
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
    captureMs: 0,
    captureFps: 0,
    cameraInfo: {
      label: '',
      deviceIndex: -1,
      requestedWidth: 0,
      requestedHeight: 0,
      requestedFps: 0,
      deliveredWidth: 0,
      deliveredHeight: 0,
      deliveredFps: 0,
      aspectRatio: 0,
      captureLatencyMs: 0,
    },
    pose: { state: 'off', fps: 0, inferenceMs: 0, lastError: '' },
    hands: { state: 'off', segmentation: false, fps: 0, inferenceMs: 0, hands: 0, lastError: '' },
  };
}
