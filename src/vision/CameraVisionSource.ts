import type { Config, Delegate } from '../config';
import { CameraManager } from './CameraManager';
import { maskSettingsFrom } from './MaskProcessor';
import type { FrameMessage, FromWorker, InitMessage } from './protocol';
import { createVisionStatus, type VisionFrame, type VisionSource } from './types';

/**
 * Cámara → ImageBitmap reducido → worker (segmentación + limpieza) → VisionFrame.
 * Nunca hay más de un frame en vuelo: si la inferencia se atrasa, se descartan capturas
 * en lugar de acumular latencia.
 */
export class CameraVisionSource implements VisionSource {
  readonly status = createVisionStatus();
  lastFrameAt = 0;

  private readonly camera: CameraManager;
  private worker: Worker | null = null;
  private workerReady = false;
  private workerFailures = 0;
  private workerRetryAt = 0;
  private workerSpawnedAt = 0;
  private delegate: Delegate;
  private inFlight = false;
  private sentAt = 0;
  private lastCaptureAt = 0;
  private recycled: ArrayBuffer | null = null;
  private hasPending = false;
  private running = false;

  private readonly frame: VisionFrame = {
    width: 0,
    height: 0,
    personMap: new Uint8Array(0),
    people: [],
    timestamp: 0,
    inferenceMs: 0,
    processingMs: 0,
  };

  constructor(private readonly config: Config) {
    this.delegate = config.vision.delegate;
    this.camera = new CameraManager(config.camera);
    this.camera.onStatusChange = () => {
      this.status.camera = this.camera.status;
      this.status.cameraDetail = this.camera.detail;
      this.status.cameras = this.camera.devices;
    };
  }

  get debugVideo(): HTMLVideoElement {
    return this.camera.video;
  }

  start(): void {
    this.running = true;
    this.camera.start();
    this.spawnWorker();
  }

  stop(): void {
    this.running = false;
    this.camera.stop();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
  }

  update(now: number): void {
    if (!this.running) return;
    if (!this.worker) {
      if (now >= this.workerRetryAt) this.spawnWorker();
      return;
    }
    if (!this.workerReady && now - this.workerSpawnedAt > this.config.vision.workerInitTimeoutMs) {
      this.restartWorker('El segmentador no terminó de iniciar a tiempo', true);
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
    this.sentAt = now;
    this.lastCaptureAt = now;

    createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' })
      .then((bitmap) => {
        if (!worker || worker !== this.worker || !this.workerReady) {
          bitmap.close();
          this.inFlight = false;
          return;
        }
        const recycled = this.recycled;
        this.recycled = null;
        const message: FrameMessage = { type: 'frame', bitmap, timestamp: now, recycled };
        worker.postMessage(message, recycled ? [bitmap, recycled] : [bitmap]);
      })
      .catch((error: unknown) => {
        this.inFlight = false;
        console.warn('[vision] No se pudo capturar el frame', error);
      });
  }

  private spawnWorker(): void {
    this.status.model = 'loading';
    const worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module', name: 'campo-vision' });
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === this.worker) this.restartWorker(event.message || 'Error al cargar el worker de visión');
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
      modelUrl: new URL(vision.modelPath, base).href,
      delegate: this.delegate,
      settings: maskSettingsFrom(this.config),
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

    const preferred = this.config.vision.delegate;
    if (duringInit && this.delegate === 'GPU') {
      // Sin GPU utilizable: reintentar de inmediato en CPU con un worker limpio.
      this.delegate = 'CPU';
      this.workerRetryAt = 0;
      return;
    }
    // Tras un fallo en CPU se vuelve a probar el delegado preferido en el siguiente intento.
    this.delegate = preferred;
    this.workerFailures++;
    const delays = this.config.camera.retryDelaysMs;
    this.workerRetryAt = performance.now() + delays[Math.min(this.workerFailures - 1, delays.length - 1)];
  }

  private handleMessage = (event: MessageEvent<FromWorker>): void => {
    if (event.target !== this.worker) return;
    const message = event.data;
    switch (message.type) {
      case 'ready':
        this.workerReady = true;
        this.workerFailures = 0;
        this.status.model = 'ready';
        this.status.delegate = message.delegate;
        this.status.labels = message.labels;
        console.info(`[vision] Segmentador listo (${message.delegate}). Etiquetas: ${message.labels.join(', ') || '—'}`);
        break;
      case 'result': {
        this.inFlight = false;
        const frame = this.frame;
        // El frame anterior ya fue consumido en un requestAnimationFrame previo: su buffer se reutiliza.
        if (frame.personMap.byteLength > 0) this.recycled = frame.personMap.buffer as ArrayBuffer;
        frame.width = message.width;
        frame.height = message.height;
        frame.personMap = new Uint8Array(message.personMap);
        frame.people = message.people;
        frame.timestamp = message.timestamp;
        frame.inferenceMs = message.inferenceMs;
        frame.processingMs = message.processingMs;
        this.hasPending = true;
        this.lastFrameAt = performance.now();
        break;
      }
      case 'skipped':
        this.inFlight = false;
        if (message.recycled) this.recycled = message.recycled;
        break;
      case 'error':
        this.status.lastError = message.message;
        if (message.fatal) this.restartWorker(message.message, message.duringInit);
        else {
          console.warn(`[vision] ${message.message}`);
          this.inFlight = false;
        }
        break;
    }
  };
}
