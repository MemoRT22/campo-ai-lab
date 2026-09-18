import { captureRegion, type Config } from '../config';
import type { Experience } from '../core/Experience';
import type { InteractionManager } from '../interaction/InteractionManager';
import type { GestureRecognizer } from '../interaction/GestureRecognizer';
import { GROUP_MODE_LABELS, type GroupInteraction } from '../particles/GroupInteraction';
import type { ParticleSystem } from '../particles/ParticleSystem';
import type { TargetField } from '../particles/TargetField';
import type { PerformanceMonitor } from '../utils/PerformanceMonitor';
import type { NegativeSpaceLayout } from './NegativeSpaceLayout';
import type { VisionFrame, VisionSource } from '../vision/types';

const TEXT_INTERVAL_MS = 250;
const SLOT_TONES = [
  [236, 236, 236],
  [150, 200, 255],
  [255, 196, 140],
  [170, 240, 180],
  [230, 160, 230],
  [255, 240, 150],
  [150, 230, 230],
  [220, 180, 160],
];

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
] as const;

const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [15, 17], [15, 19], [16, 18], [16, 20],
] as const;

export interface DebugContext {
  config: Config;
  source: VisionSource;
  perf: PerformanceMonitor;
  particles: ParticleSystem;
  experience: Experience;
  interaction: InteractionManager;
  gestures: GestureRecognizer;
  field: TargetField;
  group: GroupInteraction;
  layout: NegativeSpaceLayout;
  errors: string[];
}

function summarize(message: string): string {
  const line = message.split('\n')[0];
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function proximityLabel(value: number): string {
  return value < 0.33 ? 'FAR' : value < 0.66 ? 'MEDIUM' : 'CLOSE';
}

/** Información técnica para desarrollo. No se crea en absoluto fuera de debugMode. */
export class DebugPanel {
  private readonly el: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly cameraCanvas: HTMLCanvasElement;
  private readonly cameraCtx: CanvasRenderingContext2D;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private lastTextAt = 0;
  private lastFrame: VisionFrame | null = null;
  private latestPoses: VisionFrame['poses'] = [];
  private inferenceInput = '—';
  private maskResolution = '—';
  private peopleSummary = '—';

  constructor(root: HTMLElement, private readonly ctx: DebugContext) {
    this.el = document.createElement('aside');
    this.el.className = 'debug';
    this.cameraCanvas = document.createElement('canvas');
    this.cameraCanvas.className = 'debug__camera';
    const cameraCtx = this.cameraCanvas.getContext('2d');
    if (!cameraCtx) throw new Error('Canvas 2D no disponible');
    this.cameraCtx = cameraCtx;
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.className = 'debug__mask';
    const maskCtx = this.maskCanvas.getContext('2d');
    if (!maskCtx) throw new Error('Canvas 2D no disponible');
    this.maskCtx = maskCtx;
    this.stats = document.createElement('pre');
    this.stats.className = 'debug__stats';
    const help = document.createElement('div');
    help.className = 'debug__help';
    help.textContent = '1 mano · 2 dos manos · 3 ondas de dos personas · D panel · F pantalla completa';
    this.el.append(
      this.preview('CAMERA FRAME + ACTIVE CROP', this.cameraCanvas),
      this.preview('PROCESSED MASK', this.maskCanvas),
      this.stats,
      help,
    );
    root.appendChild(this.el);
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  drawFrame(frame: VisionFrame): void {
    this.lastFrame = frame;
    if (this.el.hidden) return;
    this.drawCamera();
    const { width, height, personMap, people } = frame;
    this.inferenceInput = `${frame.inputWidth ?? this.ctx.config.vision.inferenceWidth}×${frame.inputHeight ?? '—'}`;
    this.maskResolution = `${width}×${height}`;
    this.peopleSummary = people.length
      ? people.map((person) => `#${person.id} area ${(person.area * 100).toFixed(2)}% · prox ${person.proximity.toFixed(2)}`).join(' | ')
      : '—';
    const mirror = this.ctx.config.camera.mirror;
    if (this.maskCanvas.width !== width || this.maskCanvas.height !== height || !this.imageData) {
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.imageData = this.maskCtx.createImageData(width, height);
    }

    const data = this.imageData.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = personMap[y * width + x];
        const o = (y * width + (mirror ? width - 1 - x : x)) * 4;
        const tone = value === 0 ? null : SLOT_TONES[(value - 1) % SLOT_TONES.length];
        data[o] = tone ? tone[0] : 14;
        data[o + 1] = tone ? tone[1] : 14;
        data[o + 2] = tone ? tone[2] : 16;
        data[o + 3] = 255;
      }
    }
    const g = this.maskCtx;
    g.putImageData(this.imageData, 0, 0);
    const crop = this.ctx.config.camera.crop;
    const cropLeft = (mirror ? 1 - crop.x - crop.width : crop.x) * width;
    g.strokeStyle = '#ffd60a';
    g.setLineDash([4, 3]);
    g.strokeRect(cropLeft + 0.5, crop.y * height + 0.5, crop.width * width, crop.height * height);
    g.setLineDash([]);
    g.lineWidth = 1;
    g.font = '9px ui-monospace, monospace';
    for (const person of people) {
      const left = (mirror ? 1 - person.x1 : person.x0) * width;
      const top = person.y0 * height;
      const w = (person.x1 - person.x0) * width;
      const h = (person.y1 - person.y0) * height;
      g.strokeStyle = person.confirmed ? '#ff3b30' : '#8e8e93';
      g.strokeRect(left + 0.5, top + 0.5, w, h);
      g.fillStyle = '#ff3b30';
      g.fillText(
        `#${person.id} ${proximityLabel(person.proximity)} · area ${(person.area * 100).toFixed(2)}% · p ${person.proximity.toFixed(2)}`,
        left + 2,
        Math.max(9, top - 2),
      );
    }
    for (const hand of frame.hands ?? []) {
      const at = (index: number) => ({
        x: (mirror ? 1 - hand.landmarks[index * 2] : hand.landmarks[index * 2]) * width,
        y: hand.landmarks[index * 2 + 1] * height,
      });
      g.strokeStyle = '#30d158';
      g.setLineDash([2, 2]);
      const roiLeft = (mirror ? 1 - hand.roi.x - hand.roi.width : hand.roi.x) * width;
      g.strokeRect(roiLeft + 0.5, hand.roi.y * height + 0.5, hand.roi.width * width, hand.roi.height * height);
      g.setLineDash([]);
      if (hand.landmarks.length < 42) continue;
      for (const [from, to] of HAND_CONNECTIONS) {
        const a = at(from);
        const b = at(to);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
      g.fillStyle = '#30d158';
      for (let k = 0; k < 21; k++) {
        const point = at(k);
        g.beginPath();
        g.arc(point.x, point.y, 1.1, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (frame.poseTimestamp !== null) this.latestPoses = frame.poses;
    for (const pose of this.latestPoses) {
      g.strokeStyle = '#64d2ff';
      g.fillStyle = '#64d2ff';
      for (const [a, b] of POSE_CONNECTIONS) {
        const from = pose.landmarks[a];
        const to = pose.landmarks[b];
        if (!from || !to || from.visibility < 0.35 || to.visibility < 0.35) continue;
        g.beginPath();
        g.moveTo((mirror ? 1 - from.x : from.x) * width, from.y * height);
        g.lineTo((mirror ? 1 - to.x : to.x) * width, to.y * height);
        g.stroke();
      }
      for (const point of pose.landmarks) {
        if (point.visibility < 0.35) continue;
        g.beginPath();
        g.arc((mirror ? 1 - point.x : point.x) * width, point.y * height, 1.4, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  update(now: number): void {
    if (this.el.hidden || now - this.lastTextAt < TEXT_INTERVAL_MS) return;
    this.lastTextAt = now;
    const { perf, particles, source, experience, interaction, gestures, field, group, errors } = this.ctx;
    const status = source.status;
    const camera = status.cameraInfo;
    const gesture = interaction.lastGesture;
    const region = captureRegion(this.ctx.config);
    let predictionCount = 0;
    const motion: string[] = [];
    for (let i = 0; i < field.peopleCount; i++) {
      if (field.peoplePredictionActive[i] === 1) predictionCount++;
      motion.push(
        `#${field.peopleId[i]} ${field.peopleSpeed[i].toFixed(0)} px/s` +
        ` · pred ${Math.hypot(field.peoplePredictionX[i], field.peoplePredictionY[i]).toFixed(1)} px`,
      );
    }
    const bodyAge = this.lastFrame ? Math.max(0, now - this.lastFrame.timestamp).toFixed(0) : '—';
    const poseAge = this.lastFrame?.poseTimestamp !== null && this.lastFrame?.poseTimestamp !== undefined ? Math.max(0, now - this.lastFrame.poseTimestamp).toFixed(0) : '—';
    const handAge = this.lastFrame?.hands && this.lastFrame.hands.length > 0 ? Math.max(0, now - this.lastFrame.hands[0].timestamp).toFixed(0) : '—';

    const lines = [
      `perfil      ${this.ctx.config.displayProfile.toUpperCase()}`,
      `render      ${perf.renderFps.toFixed(0)} fps · js ${perf.frameMs.toFixed(2)} ms`,
      `cámara      ${status.cameraFps.toFixed(1)} fps medidos · ${status.camera}`,
      `captura req ${camera.requestedWidth}×${camera.requestedHeight} @ ${camera.requestedFps} · entregada ${camera.deliveredWidth || '—'}×${camera.deliveredHeight || '—'} @ ${camera.deliveredFps ? camera.deliveredFps.toFixed(0) : '—'}`,
      `dispositivo ${camera.deviceIndex >= 0 ? `#${camera.deviceIndex}` : '—'} · ${camera.label || status.cameraDetail || '—'} · aspect ${camera.aspectRatio ? camera.aspectRatio.toFixed(3) : '—'}`,
      `captura     ${status.captureFps.toFixed(1)} /s · ${status.captureMs.toFixed(1)} ms (hilo principal) · región ${(region.width * 100).toFixed(0)}×${(region.height * 100).toFixed(0)}% ${this.ctx.config.vision.cropAtCapture ? 'al capturar' : 'después de inferir'}`,
      `inferencia  input ${this.inferenceInput} · máscara ${this.maskResolution} · preset ${this.ctx.config.vision.inferenceWidth}`,
      `segmentación ${perf.segmentationFps.toFixed(1)} fps · ${perf.inferenceMs.toFixed(1)} ms inf · ${perf.maskProcessingMs.toFixed(1)} ms mask · age ${bodyAge} ms`,
      // El ritmo lo mide el propio PoseTracker: `perf.poseFps` cuenta frames de visión que llevaban
      // pose adjunta, así que siempre daba el mismo número que la segmentación.
      `pose        ${status.pose.state} · ${status.pose.fps.toFixed(1)} fps · ${perf.poseInferenceMs.toFixed(1)} ms inf · age ${poseAge} ms${status.pose.lastError ? ` · ${summarize(status.pose.lastError)}` : ''}`,
      `manos       ${status.hands.state}${status.hands.segmentation ? ' + seg' : ''} · ${status.hands.fps.toFixed(1)} fps · ${status.hands.inferenceMs.toFixed(1)} ms inf · age ${handAge} ms · ${field.handsApplied}/${status.hands.hands} vistas${status.hands.lastError ? ` · ${summarize(status.hands.lastError)}` : ''}`,
      `ajustes     threshold ${this.ctx.config.vision.maskThreshold.toFixed(2)} · hysteresis ${this.ctx.config.vision.maskHysteresis.toFixed(2)} · min area ${(this.ctx.config.vision.minPersonArea * 100).toFixed(2)}%`,
      `pipeline    ${camera.captureLatencyMs.toFixed(0)} ms sensor→web · ${perf.visionLatencyMs.toFixed(0)} ms web→partículas · ≈ ${(camera.captureLatencyMs + perf.visionLatencyMs).toFixed(0)} ms (falta la pantalla)`,
      `interpolación cada ${field.visionIntervalMs.toFixed(0)} ms de visión · ventana ${(this.ctx.config.particles.interpolationMaxMs > 0 ? Math.max(this.ctx.config.particles.interpolationMaxMs, field.visionIntervalMs * this.ctx.config.particles.interpolationIntervalFactor) : 0).toFixed(0)} ms · adelanto ${this.ctx.config.particles.predictionMs} ms`,
      `silueta     ${field.activeCount} celdas · densidad ${(field.densityApplied * 100).toFixed(0)}% · ${particles.bodyCount} BODY`,
      `partículas  ${particles.renderCount} render · ${particles.ambientCount} ambiente · ${particles.dormantCount} pool · budget ${this.ctx.config.particles.bodyParticleBudget}`,
      `tracking    ${this.ctx.config.particles.trackingResponseMs} ms · prediction ${this.ctx.config.particles.predictionMs} ms · activos ${predictionCount}`,
      `texto       lado ${this.ctx.layout.side} · ocupación izq ${(this.ctx.layout.occupancyLeft * 100).toFixed(0)}% · der ${(this.ctx.layout.occupancyRight * 100).toFixed(0)}% · arriba ${(this.ctx.layout.occupancyTop * 100).toFixed(0)}%`,
      `fases       formación ${particles.motionPhaseCounts[0]} · tracking ${particles.motionPhaseCounts[1]} · rápido ${particles.motionPhaseCounts[2]} · departure ${particles.motionPhaseCounts[3]}`,
      `formación   ${(particles.formationProgress * 100).toFixed(0)}%`,
      `cuerpo vivo núcleo ${particles.coreCount} · estela ${particles.trailCount} · borde ${particles.shedCount}`,
      `grupo       ${group.stableCount} estables · ${GROUP_MODE_LABELS[group.mode]} · ${group.connectionCount} conexiones · ${particles.bridgeParticleCount} partículas`,
      `target lag  ${particles.averageTargetDistance.toFixed(1)} px promedio · ~${particles.estimatedTargetLagMs.toFixed(0)} ms`,
      `transporte  ${particles.shiftedLastFrame} trasladadas · ${particles.transportedLastFrame} reasignadas · ${particles.releasedLastFrame} liberadas · ${particles.spawnedLastFrame} spawn · ${particles.heldLastFrame} retenidas`,
      `tracks      ${motion.length ? motion.join(' | ') : '—'}`,
      `personas    ${field.peopleCount} · ${this.peopleSummary}`,
      `estado      ${experience.state.toUpperCase()}`,
      `modelo      ${status.model}${status.delegate ? ` · ${status.delegate}` : ''}${status.labels.length ? ` · [${status.labels.join(', ')}]` : ''}`,
      `worker      ${status.worker} · fallos ${status.consecutiveFailures}${status.fallbackReason ? ` · fallback: ${summarize(status.fallbackReason)}` : ''}`,
      `gesto       ${gestures.currentGesture}${gesture ? ` · último ${gesture.type} ${Math.round(gesture.confidence * 100)}% hace ${((now - gesture.timestamp) / 1000).toFixed(1)} s` : ''}`,
    ];
    if (status.cameras.length) lines.push(`cámaras     ${status.cameras.join(' | ')}`);
    if (status.lastError) lines.push(`error       ${summarize(status.lastError)}`);
    for (const error of errors.slice(-3)) lines.push(`!           ${summarize(error)}`);
    this.stats.textContent = lines.join('\n');
  }

  private drawCamera(): void {
    const video = this.ctx.source.debugVideo;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      this.cameraCanvas.hidden = true;
      return;
    }
    this.cameraCanvas.hidden = false;
    const width = 480;
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    if (this.cameraCanvas.width !== width || this.cameraCanvas.height !== height) {
      this.cameraCanvas.width = width;
      this.cameraCanvas.height = height;
    }
    const g = this.cameraCtx;
    g.save();
    if (this.ctx.config.camera.mirror) {
      g.translate(width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(video, 0, 0, width, height);
    g.restore();
    const crop = this.ctx.config.camera.crop;
    const cropLeft = (this.ctx.config.camera.mirror ? 1 - crop.x - crop.width : crop.x) * width;
    g.strokeStyle = '#ffd60a';
    g.lineWidth = 2;
    g.setLineDash([8, 5]);
    g.strokeRect(cropLeft + 1, crop.y * height + 1, crop.width * width - 2, crop.height * height - 2);
    g.setLineDash([]);
  }

  private preview(label: string, canvas: HTMLCanvasElement): HTMLElement {
    const figure = document.createElement('figure');
    figure.className = 'debug__preview';
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    figure.append(caption, canvas);
    return figure;
  }
}
