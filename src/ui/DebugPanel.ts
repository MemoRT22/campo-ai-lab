import type { Config } from '../config';
import type { Experience } from '../core/Experience';
import type { InteractionManager } from '../interaction/InteractionManager';
import type { GestureRecognizer } from '../interaction/GestureRecognizer';
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
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private imageData: ImageData | null = null;
  private lastTextAt = 0;
  private videoAttached = false;
  private latestPoses: VisionFrame['poses'] = [];

  constructor(root: HTMLElement, private readonly ctx: DebugContext) {
    this.el = document.createElement('aside');
    this.el.className = 'debug';
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.className = 'debug__mask';
    const maskCtx = this.maskCanvas.getContext('2d');
    if (!maskCtx) throw new Error('Canvas 2D no disponible');
    this.maskCtx = maskCtx;
    this.stats = document.createElement('pre');
    this.stats.className = 'debug__stats';
    const help = document.createElement('div');
    help.className = 'debug__help';
    help.textContent = '1 mano · 2 dos manos · D panel · F pantalla completa';
    this.el.append(this.maskCanvas, this.stats, help);
    root.appendChild(this.el);
  }

  toggle(): void {
    this.el.hidden = !this.el.hidden;
  }

  drawFrame(frame: VisionFrame): void {
    if (this.el.hidden) return;
    this.attachVideo();
    const { width, height, personMap, people } = frame;
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
      g.fillText(`#${person.id} ${proximityLabel(person.proximity)} ${person.proximity.toFixed(2)}`, left + 2, Math.max(9, top - 2));
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
    this.attachVideo();
    const { perf, particles, source, experience, interaction, gestures, field, errors } = this.ctx;
    const status = source.status;
    const gesture = interaction.lastGesture;
    let predictionCount = 0;
    const motion: string[] = [];
    for (let i = 0; i < field.peopleCount; i++) {
      if (field.peoplePredictionActive[i] === 1) predictionCount++;
      motion.push(
        `#${field.peopleId[i]} ${field.peopleSpeed[i].toFixed(0)} px/s` +
        ` · pred ${Math.hypot(field.peoplePredictionX[i], field.peoplePredictionY[i]).toFixed(1)} px`,
      );
    }
    const lines = [
      `render      ${perf.renderFps.toFixed(0)} fps · js ${perf.frameMs.toFixed(2)} ms`,
      `cámara      ${status.cameraFps.toFixed(1)} fps · ${status.camera}${status.cameraDetail ? ` · ${status.cameraDetail}` : ''}`,
      `segmentación ${perf.segmentationFps.toFixed(1)} fps · ${perf.inferenceMs.toFixed(1)} ms`,
      `pose        ${perf.poseFps.toFixed(1)} fps · ${perf.poseInferenceMs.toFixed(1)} ms`,
      `máscara     ${perf.maskProcessingMs.toFixed(1)} ms`,
      `pipeline    ${perf.visionLatencyMs.toFixed(0)} ms (captura → resultado; no motion-to-photon)`,
      `partículas  ${particles.renderCount} visibles · ${particles.bodyCount} cuerpo · ${particles.ambientCount} ambiente · ${particles.dormantCount} pool`,
      `tracking    ${this.ctx.config.particles.trackingResponseMs} ms · prediction ${this.ctx.config.particles.predictionMs} ms · activos ${predictionCount}`,
      `texto       lado ${this.ctx.layout.side} · ocupación izq ${(this.ctx.layout.occupancyLeft * 100).toFixed(0)}% · der ${(this.ctx.layout.occupancyRight * 100).toFixed(0)}% · arriba ${(this.ctx.layout.occupancyTop * 100).toFixed(0)}%`,
      `fases       formación ${particles.motionPhaseCounts[0]} · tracking ${particles.motionPhaseCounts[1]} · rápido ${particles.motionPhaseCounts[2]} · departure ${particles.motionPhaseCounts[3]}`,
      `target lag  ${particles.averageTargetDistance.toFixed(1)} px promedio · ~${particles.estimatedTargetLagMs.toFixed(0)} ms`,
      `transporte  ${particles.shiftedLastFrame} trasladadas · ${particles.transportedLastFrame} reasignadas · ${particles.releasedLastFrame} liberadas · ${particles.spawnedLastFrame} spawn · ${particles.heldLastFrame} retenidas`,
      `tracks      ${motion.length ? motion.join(' | ') : '—'}`,
      `personas    ${field.peopleCount}`,
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

  private attachVideo(): void {
    const video = this.ctx.source.debugVideo;
    if (this.videoAttached || !video) return;
    this.videoAttached = true;
    video.classList.add('debug__video');
    if (this.ctx.config.camera.mirror) video.classList.add('is-mirrored');
    this.el.prepend(video);
  }
}
