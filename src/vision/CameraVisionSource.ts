import type { Config } from '../config';
import { CameraManager } from './CameraManager';
import { HandTracker } from './HandTracker';
import { maskSettingsFrom } from './MaskProcessor';
import type { FrameMessage, FromWorker, InitMessage } from './protocol';
import { createVisionStatus, type VisionFrame, type VisionSource } from './types';
import { WorkerRecoveryPolicy } from './WorkerRecoveryPolicy';

/**
 * Cámara → ImageBitmap reducido → worker (segmentación + limpieza) → VisionFrame.
 * Nunca hay más de un frame en vuelo: si la inferencia se atrasa, se descartan capturas
 * en lugar de acumular latencia.
 */
export class CameraVisionSource implements VisionSource {
  readonly status = createVisionStatus();
  lastFrameAt = 0;

  private readonly camera: CameraManager;
  private readonly hands: HandTracker;
  private latestPoses: VisionFrame['poses'] = [];
  private worker: Worker | null = null;
  private workerReady = false;
  private workerRetryAt = 0;
  private workerSpawnedAt = 0;
  private readonly recovery: WorkerRecoveryPolicy;
  private inFlight = false;
  private sentAt = 0;
  private lastCaptureAt = 0;
  private recycled: ArrayBuffer | null = null;
  private recycledConfidence: ArrayBuffer | null = null;
  private hasPending = false;
  private running = false;

  private readonly frame: VisionFrame = {
    width: 0,
    height: 0,
    personMap: new Uint8Array(0),
    confidenceMap: new Uint8Array(0),
    people: [],
    timestamp: 0,
    inferenceMs: 0,
    processingMs: 0,
    poses: [],
    poseTimestamp: null,
    poseInferenceMs: 0,
    hands: [],
  };

  constructor(private readonly config: Config) {
    this.recovery = new WorkerRecoveryPolicy(config.vision.delegate, config.vision.runtimeFailureThreshold, config.camera.retryDelaysMs);
    this.camera = new CameraManager(config.camera);
    this.hands = new HandTracker(config, this.camera.video, this.status.hands);
    this.camera.onStatusChange = () => {
      this.status.camera = this.camera.status;
      this.status.cameraDetail = this.camera.detail;
      this.status.cameras = this.camera.devices;
      this.status.cameraFps = this.camera.measuredFps;
    };
  }

  get debugVideo(): HTMLVideoElement {
    return this.camera.video;
  }

  start(): void {
    this.running = true;
    this.camera.start();
    this.spawnWorker();
    this.hands.start();
  }

  stop(): void {
    this.running = false;
    this.hands.stop();
    this.camera.stop();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.status.worker = 'off';
  }

  update(now: number): void {
    if (!this.running) return;
    // Las manos van por su cuenta: su ritmo y sus fallos no afectan a la segmentación del cuerpo.
    this.hands.update(now, this.latestPoses, this.frame.people, this.frame.personMap, this.frame.width, this.frame.height);
    this.frame.hands = this.hands.observations;
    if (!this.worker) {
      if (now >= this.workerRetryAt) this.spawnWorker();
      return;
    }
    if (!this.workerReady && now - this.workerSpawnedAt > this.config.vision.workerInitTimeoutMs) {
      this.restartWorker('El pipeline de visión no terminó de iniciar a tiempo', true);
      return;
    }
    if (this.inFlight) {
      if (now - this.sentAt > this.config.vision.workerTimeoutMs) this.restartWorker('El worker de visión dejó de responder');
      return;
    }
    // Tolerancia de 4 ms para no perder capturas por desalineación con requestAnimationFrame.
    if (now - this.lastCaptureAt < 1000 / this.config.vision.processingFPS - 4) return;
    if (!this.camera.pollFrame(now) || !this.workerReady) return;
    this.capture(now);
  }

  takeFrame(): VisionFrame | null {
    if (!this.hasPending) return null;
    this.hasPending = false;
    return this.frame;
  }

  private capture(now: number): void {
    const video = this.camera.video;
    const width = this.config.vision.inferenceWidth;
    const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    const worker = this.worker;
    this.inFlight = true;
    this.status.worker = 'busy';
    this.sentAt = now;
    this.lastCaptureAt = now;

    createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' })
      .then((bitmap) => {
        if (!worker || worker !== this.worker || !this.workerReady) {
          bitmap.close();
          if (worker === this.worker) this.inFlight = false;
          return;
        }
        const recycled = this.recycled;
        const recycledConfidence = this.recycledConfidence;
        this.recycled = null;
        this.recycledConfidence = null;
        const message: FrameMessage = { type: 'frame', bitmap, timestamp: now, recycled, recycledConfidence };
        const transfer: Transferable[] = [bitmap];
        if (recycled) transfer.push(recycled);
        if (recycledConfidence) transfer.push(recycledConfidence);
        worker.postMessage(message, transfer);
      })
      .catch((error: unknown) => {
        if (worker === this.worker) this.inFlight = false;
        console.warn('[vision] No se pudo capturar el frame', error);
      });
  }

  private spawnWorker(): void {
    this.status.model = 'loading';
    this.status.worker = 'starting';
    const worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module', name: 'campo-vision' });
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === this.worker) this.restartWorker(event.message || 'Error al cargar el worker de visión', !this.workerReady);
    });
    this.worker = worker;
    this.workerReady = false;
    this.workerSpawnedAt = performance.now();
    this.inFlight = false;

    const { vision } = this.config;
    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const init: InitMessage = {
      type: 'init',
      wasmBaseUrl: new URL(vision.wasmPath, base).href.replace(/\/$/, ''),
      poseWasmBaseUrl: new URL(vision.poseWasmPath, base).href.replace(/\/$/, ''),
      modelUrl: new URL(vision.modelPath, base).href,
      poseModelUrl: new URL(vision.poseModelPath, base).href,
      delegate: this.recovery.delegate,
      settings: maskSettingsFrom(this.config),
      visionSettings: vision,
    };
    worker.postMessage(init);
  }

  private restartWorker(reason: string, duringInit = false): void {
    console.error(`[vision] ${reason}`);
    this.status.lastError = reason;
    this.status.model = 'error';
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.inFlight = false;
    this.recycled = null;
    this.recycledConfidence = null;
    this.hasPending = false;
    this.lastFrameAt = 0;

    const decision = this.recovery.failure(reason, duringInit);
    this.workerRetryAt = performance.now() + decision.delayMs;
    this.status.worker = decision.delayMs > 0 ? 'backoff' : 'off';
    this.status.consecutiveFailures = this.recovery.consecutiveFailures;
    this.status.fallbackReason = this.recovery.fallbackReason;
    this.status.delegate = decision.delegate;
  }

  private handleMessage = (event: MessageEvent<FromWorker>): void => {
    if (event.target !== this.worker) return;
    const message = event.data;
    switch (message.type) {
      case 'ready':
        this.workerReady = true;
        this.status.model = 'ready';
        this.status.delegate = message.delegate;
        this.status.worker = 'ready';
        this.status.labels = message.labels;
        console.info(`[vision] Segmentación + Pose listas (${message.delegate}). Etiquetas: ${message.labels.join(', ') || '—'}`);
        break;
      case 'result': {
        this.inFlight = false;
        this.recovery.success();
        this.status.consecutiveFailures = 0;
        this.status.worker = 'ready';
        const frame = this.frame;
        // El frame anterior ya fue consumido en un requestAnimationFrame previo: su buffer se reutiliza.
        if (frame.personMap.byteLength > 0) this.recycled = frame.personMap.buffer as ArrayBuffer;
        if (frame.confidenceMap && frame.confidenceMap.byteLength > 0) this.recycledConfidence = frame.confidenceMap.buffer as ArrayBuffer;
        frame.width = message.width;
        frame.height = message.height;
        frame.personMap = new Uint8Array(message.personMap);
        frame.confidenceMap = new Uint8Array(message.confidenceMap);
        frame.people = message.people;
        frame.timestamp = message.timestamp;
        frame.inferenceMs = message.inferenceMs;
        frame.processingMs = message.processingMs;
        frame.poses = message.poses;
        if (message.poseTimestamp !== null) this.latestPoses = message.poses;
        frame.poseTimestamp = message.poseTimestamp;
        frame.poseInferenceMs = message.poseInferenceMs;
        this.hasPending = true;
        this.lastFrameAt = performance.now();
        break;
      }
      case 'skipped':
        this.inFlight = false;
        this.status.worker = 'ready';
        if (message.recycled) this.recycled = message.recycled;
        if (message.recycledConfidence) this.recycledConfidence = message.recycledConfidence;
        break;
      case 'error':
        this.status.lastError = message.message;
        if (message.fatal) this.restartWorker(message.message, message.duringInit);
        else this.restartWorker(message.message, false);
        break;
    }
  };
}
