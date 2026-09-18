import { captureRegion, type Config } from '../config';
import { CameraManager } from './CameraManager';
import { HandTracker } from './HandTracker';
import { PoseTracker } from './PoseTracker';
import { maskSettingsFrom } from './MaskProcessor';
import type { FrameMessage, FromWorker, InitMessage } from './protocol';
import { createVisionStatus, type VisionFrame, type VisionSource } from './types';
import { WorkerRecoveryPolicy } from './WorkerRecoveryPolicy';

const CAPTURE_SMOOTHING = 0.15;

/**
 * Cámara → ImageBitmap reducido → worker (segmentación + limpieza) → VisionFrame.
 * Nunca hay más de un frame en vuelo: si la inferencia se atrasa, se descartan capturas
 * en lugar de acumular latencia.
 *
 * Se captura UNA sola vez por tick y el mismo bitmap alimenta cuerpo y pose: decodificar el frame
 * de la cámara es el trabajo más caro del hilo principal, y hacerlo dos veces bajaba los FPS.
 */
export class CameraVisionSource implements VisionSource {
  readonly status = createVisionStatus();
  lastFrameAt = 0;

  private readonly camera: CameraManager;
  private readonly pose: PoseTracker;
  private readonly hands: HandTracker;
  private worker: Worker | null = null;
  private workerReady = false;
  private workerRetryAt = 0;
  private workerSpawnedAt = 0;
  private readonly recovery: WorkerRecoveryPolicy;
  private inFlight = false;
  private sentAt = 0;
  private lastCaptureAt = 0;
  private lastCaptureDoneAt = 0;
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
    this.pose = new PoseTracker(config, this.status.pose);
    this.hands = new HandTracker(config, this.camera.video, this.status.hands);
    this.camera.onStatusChange = () => {
      this.status.camera = this.camera.status;
      this.status.cameraDetail = this.camera.detail;
      this.status.cameras = this.camera.devices;
      this.status.cameraFps = this.camera.measuredFps;
      this.status.cameraInfo = { ...this.camera.diagnostics };
    };
  }

  get debugVideo(): HTMLVideoElement {
    return this.camera.video;
  }

  start(): void {
    this.running = true;
    this.camera.onNewFrame = (now) => this.maybeCapture(now);
    this.camera.start();
    this.spawnWorker();
    this.pose.start();
    this.hands.start();
  }

  stop(): void {
    this.running = false;
    this.camera.onNewFrame = null;
    this.hands.stop();
    this.pose.stop();
    this.camera.stop();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.status.worker = 'off';
  }

  update(now: number): void {
    if (!this.running) return;

    this.pose.update(now);
    // Las manos van por su cuenta: su ritmo y sus fallos no afectan a la segmentación del cuerpo.
    this.hands.update(now, this.pose.observations, this.frame.people, this.frame.personMap, this.frame.width, this.frame.height);

    if (!this.worker) {
      if (now >= this.workerRetryAt) this.spawnWorker();
    } else if (!this.workerReady && now - this.workerSpawnedAt > this.config.vision.workerInitTimeoutMs) {
      this.restartWorker('El pipeline de visión no terminó de iniciar a tiempo', true);
    } else if (this.inFlight && now - this.sentAt > this.config.vision.workerTimeoutMs) {
      this.restartWorker('El worker de visión dejó de responder');
    }

    // Red de seguridad: normalmente captura `onNewFrame`, antes de este rAF. `pollFrame` evita
    // que el mismo frame de video se capture dos veces.
    this.maybeCapture(now);
  }

  /** Captura si hay frame nuevo y alguien lo quiere. Idempotente por frame de video. */
  private maybeCapture(now: number): void {
    if (!this.running) return;
    // Pose no depende del worker del cuerpo: si éste se cae, los gestos siguen vivos.
    const forBody = this.worker !== null && this.workerReady && !this.inFlight;
    const forPose = this.pose.wantsFrame(now);
    if (!forBody && !forPose) return;
    // Tolerancia de 4 ms para no perder capturas por desalineación con el reloj de la cámara.
    if (now - this.lastCaptureAt < 1000 / this.config.vision.processingFPS - 4) return;
    if (!this.camera.pollFrame(now)) return;
    this.capture(now, forBody, forPose);
  }

  takeFrame(): VisionFrame | null {
    if (!this.hasPending) return null;
    this.hasPending = false;
    this.frame.poses = this.pose.observations;
    this.frame.poseTimestamp = this.pose.timestamp;
    this.frame.poseInferenceMs = this.pose.status.inferenceMs;
    this.frame.hands = this.hands.observations;
    return this.frame;
  }

  private capture(now: number, forBody: boolean, forPose: boolean): void {
    const video = this.camera.video;
    // Recortar aquí y no después: el modelo gasta sus 256×144 sólo en la zona útil.
    const region = captureRegion(this.config);
    const sx = Math.round(region.x * video.videoWidth);
    const sy = Math.round(region.y * video.videoHeight);
    const sw = Math.max(1, Math.round(region.width * video.videoWidth));
    const sh = Math.max(1, Math.round(region.height * video.videoHeight));
    const width = this.config.vision.inferenceWidth;
    const height = Math.max(1, Math.round((width * sh) / sw));
    const worker = this.worker;
    if (forBody) {
      this.inFlight = true;
      this.status.worker = 'busy';
      this.sentAt = now;
    }
    this.lastCaptureAt = now;
    if (forPose) this.pose.reserve(now);
    const requestedAt = performance.now();

    createImageBitmap(video, sx, sy, sw, sh, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' })
      .then(async (bitmap) => {
        this.recordCapture(requestedAt);
        const usable = worker !== null && worker === this.worker && this.workerReady;
        if (forPose && (!forBody || !usable)) {
          // Nadie más quiere el frame: pose se queda con el original.
          this.pose.submit(bitmap, now);
          if (forBody && worker === this.worker) this.inFlight = false;
          return;
        }
        if (!usable) {
          bitmap.close();
          if (forBody && worker === this.worker) this.inFlight = false;
          return;
        }
        if (forPose) {
          // Copiar un bitmap ya reducido cuesta mucho menos que volver a decodificar el video.
          const copy = await createImageBitmap(bitmap).catch(() => null);
          if (copy) this.pose.submit(copy, now);
          if (worker !== this.worker || !this.workerReady) {
            bitmap.close();
            this.inFlight = false;
            return;
          }
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
        if (forBody && worker === this.worker) this.inFlight = false;
        console.warn('[vision] No se pudo capturar el frame', error);
      });
  }

  /** Coste y ritmo reales de la captura: separa "la GPU va lenta" de "la cámara entrega poco". */
  private recordCapture(requestedAt: number): void {
    const done = performance.now();
    const ms = done - requestedAt;
    this.status.captureMs += (ms - this.status.captureMs) * CAPTURE_SMOOTHING;
    if (this.lastCaptureDoneAt > 0) {
      const fps = 1000 / Math.max(1, done - this.lastCaptureDoneAt);
      this.status.captureFps += (fps - this.status.captureFps) * CAPTURE_SMOOTHING;
    }
    this.lastCaptureDoneAt = done;
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

    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const init: InitMessage = {
      type: 'init',
      wasmBaseUrl: new URL(this.config.vision.wasmPath, base).href.replace(/\/$/, ''),
      modelUrl: new URL(this.config.vision.modelPath, base).href,
      delegate: this.recovery.delegate,
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
        console.info(`[vision] Segmentación lista (${message.delegate}). Etiquetas: ${message.labels.join(', ') || '—'}`);
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
        frame.inputWidth = message.inputWidth;
        frame.inputHeight = message.inputHeight;
        frame.personMap = new Uint8Array(message.personMap);
        frame.confidenceMap = new Uint8Array(message.confidenceMap);
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
