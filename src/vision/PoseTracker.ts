import type { Config } from '../config';
import type { PoseFromWorker, PoseInitMessage, PoseFrameMessage } from './poseProtocol';
import type { PoseTrackerStatus, PoseInfo } from './types';

const FPS_SMOOTHING = 0.2;
const MAX_FAILURES = 3;

/**
 * Gestiona el pipeline de Pose en un worker dedicado.
 * Permite que Pose corra a sus propios FPS sin bloquear la segmentación del cuerpo.
 *
 * No captura video: recibe el mismo bitmap que ya se capturó para el cuerpo. Decodificar el frame
 * de la cámara dos veces por tick era el trabajo más caro del hilo principal.
 */
export class PoseTracker {
  readonly status: PoseTrackerStatus;
  observations: PoseInfo[] = [];
  timestamp: number | null = null;

  private worker: Worker | null = null;
  private ready = false;
  private running = false;
  private inFlight = false;
  private sentAt = 0;
  private lastRequestAt = -Infinity;
  private retryAt = 0;
  private requestId = 0;
  private failures = 0;
  private lastResultAt = 0;
  private pendingTimestamp = 0;

  constructor(private readonly config: Config, status: PoseTrackerStatus) {
    this.status = status;
  }

  start(): void {
    this.running = true;
    this.spawnWorker();
  }

  stop(): void {
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.inFlight = false;
    this.observations = [];
    this.timestamp = null;
    this.status.state = 'off';
  }

  update(now: number): void {
    const settings = this.config.vision;
    if (!this.running) return;
    if (!this.worker) {
      if (this.failures < MAX_FAILURES && now >= this.retryAt) this.spawnWorker();
      return;
    }
    if (!this.ready) return;
    if (this.inFlight && now - this.sentAt > settings.workerTimeoutMs) this.restart('El worker de pose dejó de responder');
  }

  /** true si toca un frame de pose. El origen captura una sola vez y comparte ese bitmap. */
  wantsFrame(now: number): boolean {
    if (!this.running || !this.worker || !this.ready || this.inFlight) return false;
    return now - this.lastRequestAt >= 1000 / this.config.vision.poseFPS - 4;
  }

  /** Marca que ya hay una captura en camino para pose, antes de que el bitmap exista. */
  reserve(now: number): void {
    this.lastRequestAt = now;
  }

  /** Toma la propiedad del bitmap: lo transfiere al worker o lo cierra. */
  submit(bitmap: ImageBitmap, now: number): void {
    const worker = this.worker;
    if (!worker || !this.ready || this.inFlight) {
      bitmap.close();
      return;
    }
    this.lastRequestAt = now;
    this.inFlight = true;
    this.sentAt = now;
    this.pendingTimestamp = now;
    const id = ++this.requestId;
    const message: PoseFrameMessage = { type: 'frame', id, bitmap };
    worker.postMessage(message, [bitmap]);
  }

  private spawnWorker(): void {
    const { vision } = this.config;
    this.status.state = 'loading';
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module', name: 'campo-pose' });
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === this.worker) this.restart(event.message || 'Error al cargar el worker de pose');
    });
    this.worker = worker;
    this.ready = false;
    this.inFlight = false;

    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const init: PoseInitMessage = {
      type: 'init',
      wasmBaseUrl: new URL(vision.poseWasmPath, base).href.replace(/\/$/, ''),
      modelUrl: new URL(vision.poseModelPath, base).href,
      delegate: vision.delegate,
      settings: vision,
    };
    worker.postMessage(init);
  }

  private restart(reason: string): void {
    console.warn(`[pose] ${reason}`);
    this.failures++;
    this.status.state = 'error';
    this.status.lastError = this.failures >= MAX_FAILURES ? `${reason} · pose desactivado` : reason;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.inFlight = false;
    this.retryAt = performance.now() + 5000;
  }

  private readonly handleMessage = (event: MessageEvent<PoseFromWorker>): void => {
    const message = event.data;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.failures = 0;
        this.status.state = 'ready';
        break;
      case 'result': {
        this.inFlight = false;
        if (message.id !== this.requestId) break;
        const now = performance.now();
        if (this.lastResultAt > 0) {
          const fps = 1000 / Math.max(1, now - this.lastResultAt);
          this.status.fps += (fps - this.status.fps) * FPS_SMOOTHING;
        }
        this.lastResultAt = now;
        this.status.inferenceMs = message.inferenceMs;
        this.observations = message.poses;
        this.timestamp = this.pendingTimestamp;
        break;
      }
      case 'error':
        this.restart(message.message);
        break;
    }
  };
}
