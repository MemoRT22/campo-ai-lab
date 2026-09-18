import type { Config } from '../config';
import { clamp01, lerp, smoothstep } from '../utils/MathUtils';
import { MaskProcessor, maskSettingsFrom } from './MaskProcessor';
import type { HandObservation } from './handGeometry';
import { createVisionStatus, type VisionFrame, type VisionSource } from './types';

const WIDTH = 320;
const HEIGHT = 180;
const LOOP_SECONDS = 36;

interface Figure {
  x: number;
  feet: number;
  height: number;
  /** Ángulo de cada brazo en radianes: 0 = abajo, π = arriba. */
  armLeft: number;
  armRight: number;
  walk: number;
}

function ramp(t: number, start: number, end: number): number {
  return smoothstep(start, end, t);
}

/** Figura A: entra caminando, se acerca, levanta una mano, luego las dos, y sale. */
function figureA(t: number): Figure | null {
  if (t < 2.5 || t > 28) return null;
  const enter = ramp(t, 2.5, 6);
  const approach = ramp(t, 6.5, 10);
  const exit = ramp(t, 24, 28);
  const walking = (t < 6.2 || t > 24) ? 1 : 0;
  const wave = t > 10.5 && t < 13 ? 0.35 * Math.sin(t * 9) : 0;
  const oneUp = ramp(t, 10, 10.8) * (1 - ramp(t, 13, 13.6));
  const bothUp = ramp(t, 13.4, 14.2) * (1 - ramp(t, 15.8, 16.6));
  const idleSwing = 0.12 * Math.sin(t * 2.1);
  return {
    x: lerp(lerp(-0.2, 0.42, enter), -0.25, exit),
    feet: lerp(0.93, 1.16, approach),
    height: lerp(0.42, 0.95, approach),
    armLeft: 0.18 + idleSwing + Math.max(oneUp * 2.6 + wave, bothUp * 2.7),
    armRight: 0.18 - idleSwing + bothUp * 2.7,
    walk: walking * t * 7,
  };
}

/** Figura B: entra lejos por la derecha mientras A sigue presente. */
function figureB(t: number): Figure | null {
  if (t < 15 || t > 31) return null;
  const enter = ramp(t, 15, 19.5);
  const exit = ramp(t, 26, 31);
  const walking = (t < 19.5 || t > 26) ? 1 : 0;
  return {
    x: lerp(lerp(1.2, 0.78, enter), 1.25, exit),
    feet: 0.9,
    height: 0.46,
    armLeft: 0.2 + 0.5 * clamp01(Math.sin(t * 1.7)),
    armRight: 0.2,
    walk: walking * t * 6.5,
  };
}

/** Figura C: llega por la izquierda cuando A y B ya están; tres personas activan el modo colectivo. */
function figureC(t: number): Figure | null {
  if (t < 18 || t > 25.5) return null;
  const enter = ramp(t, 18, 21);
  const exit = ramp(t, 22.5, 25.5);
  const walking = (t < 21 || t > 22.5) ? 1 : 0;
  return {
    x: lerp(lerp(-0.2, 0.14, enter), -0.22, exit),
    feet: 0.95,
    height: 0.55,
    armLeft: 0.2 + 0.25 * clamp01(Math.sin(t * 1.3)),
    armRight: 0.18,
    walk: walking * t * 6.8,
  };
}

function limb(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, angle: number, side: number, lengths: [number, number], width: number): void {
  const bend = angle > 1.2 ? -0.25 * side : 0.15 * side;
  const ex = x + Math.sin(angle) * side * lengths[0];
  const ey = y + Math.cos(angle) * lengths[0];
  const hx = ex + Math.sin(angle + bend) * side * lengths[1];
  const hy = ey + Math.cos(angle + bend) * lengths[1];
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(ex, ey);
  ctx.lineTo(hx, hy);
  ctx.stroke();
}

function drawFigure(ctx: OffscreenCanvasRenderingContext2D, f: Figure): void {
  const h = f.height * HEIGHT;
  const cx = f.x * WIDTH;
  const feet = f.feet * HEIGHT;
  const hipY = feet - h * 0.48;
  const shoulderY = feet - h * 0.8;
  const stride = Math.sin(f.walk) * 0.3;

  limb(ctx, cx - h * 0.05, hipY, stride, 1, [h * 0.25, h * 0.24], h * 0.09);
  limb(ctx, cx + h * 0.05, hipY, -stride, 1, [h * 0.25, h * 0.24], h * 0.09);

  ctx.lineWidth = h * 0.2;
  ctx.beginPath();
  ctx.moveTo(cx, shoulderY + h * 0.04);
  ctx.lineTo(cx, hipY);
  ctx.stroke();

  limb(ctx, cx - h * 0.12, shoulderY + h * 0.03, f.armLeft, -1, [h * 0.17, h * 0.16], h * 0.06);
  limb(ctx, cx + h * 0.12, shoulderY + h * 0.03, f.armRight, 1, [h * 0.17, h * 0.16], h * 0.06);

  ctx.lineWidth = h * 0.07;
  ctx.beginPath();
  ctx.moveTo(cx, shoulderY);
  ctx.lineTo(cx, shoulderY - h * 0.08);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, feet - h * 0.915, h * 0.075, 0, Math.PI * 2);
  ctx.fill();
}

/** Largo de la palma y proporciones de los dedos respecto a la altura de la figura. */
const PALM_OF_HEIGHT = 0.055;
const FINGER_LENGTHS = [0.85, 0.95, 0.88, 0.7];
const FINGER_SEGMENTS = [0.45, 0.3, 0.25];

/**
 * Mano sintética de 21 puntos al final de un brazo, como la entregaría el Hand Landmarker.
 * Sólo sirve para desarrollar y calibrar los dedos sin cámara.
 */
function mockHand(cx: number, feet: number, h: number, angle: number, side: number, spread: number, timestamp: number): HandObservation {
  const shoulderY = feet - h * 0.8 + h * 0.03;
  const shoulderX = cx + side * h * 0.12;
  const bend = angle > 1.2 ? -0.25 * side : 0.15 * side;
  const elbowX = shoulderX + Math.sin(angle) * side * h * 0.17;
  const elbowY = shoulderY + Math.cos(angle) * h * 0.17;
  const wristX = elbowX + Math.sin(angle + bend) * side * h * 0.16;
  const wristY = elbowY + Math.cos(angle + bend) * h * 0.16;
  const length = Math.hypot(wristX - elbowX, wristY - elbowY) || 1;
  const dirX = (wristX - elbowX) / length;
  const dirY = (wristY - elbowY) / length;
  const perpX = -dirY;
  const perpY = dirX;
  const palm = h * PALM_OF_HEIGHT;
  const width = palm * 0.8;

  const points = new Float32Array(42);
  const put = (index: number, x: number, y: number) => {
    points[index * 2] = x / WIDTH;
    points[index * 2 + 1] = y / HEIGHT;
  };
  put(0, wristX, wristY);
  // Pulgar: sale del lateral de la palma, más abierto que los dedos.
  const thumbAngle = 1.0 + spread * 0.6;
  let tx = wristX + dirX * palm * 0.25 + perpX * width * 0.42;
  let ty = wristY + dirY * palm * 0.25 + perpY * width * 0.42;
  put(1, tx, ty);
  for (let s = 0; s < 3; s++) {
    const a = thumbAngle * (1 - s * 0.15);
    const segment = palm * [0.35, 0.3, 0.25][s];
    tx += (dirX * Math.cos(a) + perpX * Math.sin(a)) * segment;
    ty += (dirY * Math.cos(a) + perpY * Math.sin(a)) * segment;
    put(2 + s, tx, ty);
  }
  // Índice, medio, anular y meñique, abiertos en abanico.
  const offsets = [0.38, 0.13, -0.13, -0.38];
  for (let f = 0; f < 4; f++) {
    const knuckleX = wristX + dirX * palm + perpX * width * offsets[f];
    const knuckleY = wristY + dirY * palm + perpY * width * offsets[f];
    put(5 + f * 4, knuckleX, knuckleY);
    const fan = spread * offsets[f] * 2.2;
    let px = knuckleX;
    let py = knuckleY;
    for (let s = 0; s < 3; s++) {
      const segment = palm * FINGER_LENGTHS[f] * FINGER_SEGMENTS[s];
      px += (dirX * Math.cos(fan) + perpX * Math.sin(fan)) * segment;
      py += (dirY * Math.cos(fan) + perpY * Math.sin(fan)) * segment;
      put(6 + f * 4 + s, px, py);
    }
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (let k = 0; k < 21; k++) {
    minX = Math.min(minX, points[k * 2]);
    maxX = Math.max(maxX, points[k * 2]);
    minY = Math.min(minY, points[k * 2 + 1]);
    maxY = Math.max(maxY, points[k * 2 + 1]);
  }
  return {
    personId: -1,
    timestamp,
    landmarks: points,
    score: 1,
    roi: { x: minX, y: minY, width: Math.max(0.01, maxX - minX), height: Math.max(0.01, maxY - minY) },
    mask: null,
    maskWidth: 0,
    maskHeight: 0,
  };
}

/**
 * Siluetas sintéticas en el espacio de la cámara, procesadas con el mismo MaskProcessor
 * que la ruta real. Sirve para afinar partículas y transiciones sin cámara ni voluntarios.
 */
export class MockVisionSource implements VisionSource {
  readonly status = createVisionStatus();
  readonly debugVideo = null;
  lastFrameAt = 0;

  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly confidence = new Float32Array(WIDTH * HEIGHT);
  private readonly processor: MaskProcessor;
  private readonly frame: VisionFrame;
  /** Reloj propio que avanza con los frames: si la pestaña se pausa, el guion también. */
  private clock = 0;
  private lastUpdate = 0;
  private lastEmit = -Infinity;
  private hasPending = false;

  constructor(private readonly config: Config) {
    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D no disponible');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.ctx = ctx;
    this.processor = new MaskProcessor(maskSettingsFrom(config));
    this.frame = {
      inputWidth: WIDTH,
      inputHeight: HEIGHT,
      width: WIDTH,
      height: HEIGHT,
      personMap: new Uint8Array(WIDTH * HEIGHT),
      confidenceMap: new Uint8Array(WIDTH * HEIGHT),
      people: [],
      timestamp: 0,
      inferenceMs: 0,
      processingMs: 0,
      poses: [],
      poseTimestamp: null,
      poseInferenceMs: 0,
      hands: [],
    };
    this.status.camera = 'live';
    this.status.cameraDetail = 'Fuente sintética (mock)';
    this.status.cameraInfo = {
      label: 'Fuente sintética',
      deviceIndex: -1,
      requestedWidth: WIDTH,
      requestedHeight: HEIGHT,
      requestedFps: config.vision.processingFPS,
      deliveredWidth: WIDTH,
      deliveredHeight: HEIGHT,
      deliveredFps: config.vision.processingFPS,
      aspectRatio: WIDTH / HEIGHT,
      captureLatencyMs: 0,
    };
    this.status.model = 'ready';
  }

  start(): void {
    this.lastUpdate = performance.now();
  }

  stop(): void {}

  update(now: number): void {
    this.clock += Math.min(now - this.lastUpdate, 100);
    this.lastUpdate = now;
    if (this.clock - this.lastEmit < 1000 / this.config.vision.processingFPS - 4) return;
    this.lastEmit = this.clock;

    const t = (this.clock / 1000) % LOOP_SECONDS;
    const ctx = this.ctx;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.filter = 'blur(1px)';
    const a = figureA(t);
    const b = figureB(t);
    const c = figureC(t);
    if (a) drawFigure(ctx, a);
    if (b) drawFigure(ctx, b);
    if (c) drawFigure(ctx, c);

    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const confidence = this.confidence;
    for (let i = 0; i < confidence.length; i++) confidence[i] = pixels[i * 4] / 255;

    const spread = 0.12 + 0.16 * (0.5 + 0.5 * Math.sin(this.clock * 0.0022));
    const hands: HandObservation[] = [];
    for (const figure of [a, b, c]) {
      if (!figure || !this.config.hands.enabled) continue;
      const height = figure.height * HEIGHT;
      const cx = figure.x * WIDTH;
      const feet = figure.feet * HEIGHT;
      hands.push(mockHand(cx, feet, height, figure.armLeft, -1, spread, now));
      hands.push(mockHand(cx, feet, height, figure.armRight, 1, spread, now));
    }
    this.frame.hands = hands;

    const started = performance.now();
    this.frame.people = this.processor.process(confidence, WIDTH, HEIGHT, now, this.frame.personMap, this.frame.confidenceMap);
    this.frame.processingMs = performance.now() - started;
    this.frame.timestamp = now;
    this.hasPending = true;
    this.lastFrameAt = now;
  }

  takeFrame(): VisionFrame | null {
    if (!this.hasPending) return null;
    this.hasPending = false;
    return this.frame;
  }
}
