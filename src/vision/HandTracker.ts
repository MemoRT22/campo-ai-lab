import { captureRegion, type Config, type NormalizedRect } from '../config';
import { MAX_HANDS, cropToCamera, handAnchor, roiFromHand, roiFromPose, type HandObservation, type HandSide } from './handGeometry';
import type { HandsFrameMessage, HandsFromWorker, HandsInitMessage } from './handsProtocol';
import type { HandTrackerStatus, PersonInfo, PoseInfo } from './types';

const SIDES: HandSide[] = ['left', 'right'];
/** Distancia normalizada para reconocer que una observación previa es la misma mano. */
const TRACK_MATCH_DISTANCE = 0.16;
const FPS_SMOOTHING = 0.2;
/** Fallos seguidos tras los que los dedos se apagan para el resto de la sesión. */
const MAX_FAILURES = 3;

interface PendingCrop {
  roi: NormalizedRect;
  personId: number;
}

/**
 * Manos en alta resolución. Pose dice dónde mirar; de ahí se recorta el video a tamaño completo y
 * el worker devuelve 21 puntos y la segmentación del recorte.
 *
 * Nunca bloquea al resto: un solo análisis en vuelo, y si falla o se atrasa, el cuerpo sigue igual.
 */
export class HandTracker {
  readonly status: HandTrackerStatus;
  /** Última tanda de manos observadas. Se reemplaza completa: nunca mezcla tiempos distintos. */
  observations: HandObservation[] = [];

  private worker: Worker | null = null;
  private ready = false;
  private running = false;
  private inFlight = false;
  private sentAt = 0;
  private lastRequestAt = -Infinity;
  private retryAt = 0;
  private requestId = 0;
  private failures = 0;
  private pending: PendingCrop[] = [];
  private pendingTimestamp = 0;
  private lastResultAt = 0;
  private readonly roi: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

  constructor(private readonly config: Config, private readonly video: HTMLVideoElement, status: HandTrackerStatus) {
    this.status = status;
  }

  start(): void {
    if (!this.config.hands.enabled) return;
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
    this.status.state = 'off';
  }

  /** Programa el siguiente análisis si Pose ve alguna muñeca y el worker está libre. */
  update(now: number, poses: PoseInfo[], people: PersonInfo[], personMap: Uint8Array, maskWidth: number, maskHeight: number): void {
    const settings = this.config.hands;
    if (!this.running || !settings.enabled) return;
    if (!this.worker) {
      if (this.failures < MAX_FAILURES && now >= this.retryAt) this.spawnWorker();
      return;
    }
    if (!this.ready) return;
    if (this.inFlight) {
      if (now - this.sentAt > settings.workerTimeoutMs) this.restart('El worker de manos dejó de responder');
      return;
    }
    if (now - this.lastRequestAt < 1000 / settings.fps - 4) return;

    const { videoWidth, videoHeight } = this.video;
    if (videoWidth === 0 || videoHeight === 0) return;
    // Pose ve la región capturada, no el encuadre completo: los ROI viven en ese mismo espacio.
    const region = captureRegion(this.config);
    const regionWidth = region.width * videoWidth;
    const regionHeight = region.height * videoHeight;
    const crops: PendingCrop[] = [];
    for (const pose of poses) {
      for (const side of SIDES) {
        if (crops.length >= Math.min(settings.maxHands, MAX_HANDS)) break;
        const roi = this.resolveRoi(pose, side, now, regionWidth, regionHeight);
        if (!roi) continue;
        const wrist = pose.landmarks[side === 'left' ? 15 : 16];
        crops.push({ roi: { ...roi }, personId: this.personAt(wrist.x, wrist.y, people, personMap, maskWidth, maskHeight) });
      }
    }
    if (crops.length === 0) {
      if (this.observations.length > 0 && now - this.lastResultAt > settings.maxAgeMs) this.observations = [];
      return;
    }

    this.lastRequestAt = now;
    this.inFlight = true;
    this.sentAt = now;
    this.pending = crops;
    this.pendingTimestamp = now;
    const id = ++this.requestId;
    const worker = this.worker;
    Promise.all(crops.map((crop) => this.captureCrop(crop.roi, videoWidth, videoHeight)))
      .then((bitmaps) => {
        if (!this.worker || this.worker !== worker || id !== this.requestId) {
          for (const bitmap of bitmaps) bitmap.close();
          return;
        }
        const message: HandsFrameMessage = { type: 'frame', id, crops: bitmaps.map((bitmap, i) => ({ bitmap, roi: crops[i].roi })) };
        worker.postMessage(message, bitmaps);
      })
      .catch((error: unknown) => {
        if (this.worker === worker) this.inFlight = false;
        console.warn('[manos] No se pudo recortar el video', error);
      });
  }

  /** El ROI está normalizado dentro de la región capturada; el recorte se toma del video completo. */
  private captureCrop(roi: NormalizedRect, videoWidth: number, videoHeight: number): Promise<ImageBitmap> {
    const { cropWidth, cropHeight } = this.config.hands;
    const region = captureRegion(this.config);
    return createImageBitmap(
      this.video,
      Math.round((region.x + roi.x * region.width) * videoWidth),
      Math.round((region.y + roi.y * region.height) * videoHeight),
      Math.max(1, Math.round(roi.width * region.width * videoWidth)),
      Math.max(1, Math.round(roi.height * region.height * videoHeight)),
      { resizeWidth: cropWidth, resizeHeight: cropHeight, resizeQuality: 'medium' },
    );
  }

  /** Prefiere encuadrar con los puntos de la mano anterior; si no hay, usa Pose. */
  private resolveRoi(pose: PoseInfo, side: HandSide, now: number, regionWidth: number, regionHeight: number): NormalizedRect | null {
    const settings = this.config.hands;
    const poseRoi = roiFromPose(pose.landmarks, side, regionWidth, regionHeight, settings, this.roi);
    if (!poseRoi) return null;
    const wrist = pose.landmarks[side === 'left' ? 15 : 16];
    for (const previous of this.observations) {
      if (previous.landmarks.length === 0 || now - previous.timestamp > settings.trackReuseMs) continue;
      const anchor = handAnchor(previous);
      if (Math.hypot(anchor.x - wrist.x, anchor.y - wrist.y) > TRACK_MATCH_DISTANCE) continue;
      const tracked = roiFromHand(previous.landmarks, regionWidth, regionHeight, settings, this.roi);
      if (tracked) return tracked;
      break;
    }
    return poseRoi;
  }

  /** Silueta a la que pertenece la muñeca, según la máscara general; -1 si no se puede asociar. */
  private personAt(x: number, y: number, people: PersonInfo[], personMap: Uint8Array, maskWidth: number, maskHeight: number): number {
    if (maskWidth > 0 && personMap.length === maskWidth * maskHeight) {
      const mx = Math.min(maskWidth - 1, Math.max(0, Math.round(x * maskWidth)));
      const my = Math.min(maskHeight - 1, Math.max(0, Math.round(y * maskHeight)));
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = mx + dx;
          const sy = my + dy;
          if (sx < 0 || sy < 0 || sx >= maskWidth || sy >= maskHeight) continue;
          const slot = personMap[sy * maskWidth + sx] - 1;
          if (slot < 0) continue;
          const person = people.find((candidate) => candidate.slot === slot && candidate.confirmed);
          if (person) return person.id;
        }
      }
    }
    // Sin máscara útil: la caja que contiene la muñeca.
    for (const person of people) {
      if (person.confirmed && x >= person.x0 && x <= person.x1 && y >= person.y0 && y <= person.y1) return person.id;
    }
    return -1;
  }

  private spawnWorker(): void {
    const { hands, vision } = this.config;
    this.status.state = 'loading';
    const worker = new Worker(new URL('./hands.worker.ts', import.meta.url), { type: 'module', name: 'campo-hands' });
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === this.worker) this.restart(event.message || 'Error al cargar el worker de manos');
    });
    this.worker = worker;
    this.ready = false;
    this.inFlight = false;

    const base = new URL(import.meta.env.BASE_URL, window.location.href);
    const init: HandsInitMessage = {
      type: 'init',
      landmarkerWasmBaseUrl: new URL(vision.wasmPath, base).href.replace(/\/$/, ''),
      segmenterWasmBaseUrl: new URL(vision.poseWasmPath, base).href.replace(/\/$/, ''),
      modelUrl: new URL(hands.modelPath, base).href,
      segmenterModelUrl: new URL(vision.modelPath, base).href,
      delegate: vision.delegate,
      segmentation: hands.segmentation,
      settings: hands,
    };
    worker.postMessage(init);
  }

  private restart(reason: string): void {
    console.warn(`[manos] ${reason}`);
    this.failures++;
    this.status.state = 'error';
    // Los dedos son un extra: si no arrancan, la instalación sigue con la silueta del cuerpo.
    this.status.lastError = this.failures >= MAX_FAILURES ? `${reason} · dedos desactivados` : reason;
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.inFlight = false;
    this.observations = [];
    this.retryAt = performance.now() + this.config.hands.retryDelayMs;
  }

  private readonly handleMessage = (event: MessageEvent<HandsFromWorker>): void => {
    const message = event.data;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.failures = 0;
        this.status.state = 'ready';
        this.status.segmentation = message.segmentation;
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
        const observations: HandObservation[] = [];
        message.hands.forEach((hand, index) => {
          const crop = this.pending[index];
          if (!crop || (!hand.landmarks && !hand.mask)) return;
          observations.push({
            personId: crop.personId,
            timestamp: this.pendingTimestamp,
            landmarks: hand.landmarks ? cropToCamera(hand.landmarks, crop.roi) : new Float32Array(0),
            score: hand.score,
            roi: crop.roi,
            mask: hand.mask,
            maskWidth: hand.maskWidth,
            maskHeight: hand.maskHeight,
          });
        });
        this.observations = observations;
        this.status.hands = observations.length;
        break;
      }
      case 'error':
        this.restart(message.message);
        break;
    }
  };
}
