import { frameRegion, type Config } from '../config';
import { clamp01, createRandom, expAlpha, lerp, screenScale, smoothstep } from '../utils/MathUtils';
import { HandShape, MAX_HANDS, handAnchor, sampleUint8, type HandObservation } from '../vision/handGeometry';
import type { PersonInfo, VisionFrame } from '../vision/types';

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Coseno a partir del cual la dirección se considera plenamente sostenida. */
const FULL_CONFIDENCE_COSINE = 0.95;
/** Al frenar, la velocidad filtrada responde con esta fracción del suavizado normal. */
const BRAKE_SMOOTHING_FACTOR = 0.35;
/** Un borde a menos de esta distancia normalizada del recorte se considera cortado por el cuadro. */
const EDGE_CLIP_EPSILON = 0.004;

interface TrackMotion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Velocidad de traslación rígida del cuerpo (px/ms), sin el efecto de brazos. */
  tvx: number;
  tvy: number;
  predictionX: number;
  predictionY: number;
  /** Fracción de celda acumulada por traslación rígida que aún no produce un desplazamiento entero. */
  cellCarryX: number;
  cellCarryY: number;
  stableFrames: number;
  lastSeen: number;
}

/**
 * Traslación común de dos bordes opuestos. Si sólo uno se mueve (un brazo que se extiende)
 * no hay traslación; si uno está cortado por el cuadro se usa el otro.
 */
export function rigidTranslation(deltaA: number, deltaB: number, clippedA: boolean, clippedB: boolean): number {
  if (clippedA && clippedB) return 0;
  if (clippedA) return deltaB;
  if (clippedB) return deltaA;
  if (deltaA === 0 || deltaB === 0 || Math.sign(deltaA) !== Math.sign(deltaB)) return 0;
  return Math.abs(deltaA) < Math.abs(deltaB) ? deltaA : deltaB;
}

/**
 * Traduce el mapa de siluetas (espacio de cámara) a una retícula fija en pantalla.
 *
 * Cada celda es una posición estable: si la persona no se mueve, la celda y la partícula
 * que la ocupa no cambian. Sólo las celdas que se encienden o apagan provocan movimiento.
 * Esto evita el “baile” de partículas que produce remuestrear la máscara en cada frame.
 */
export class TargetField {
  /** Cambia cuando la retícula se reconstruye (resize): invalida asignaciones previas. */
  version = 0;
  width = 0;
  height = 0;
  spacing = 1;
  cols = 0;
  rows = 0;
  cellCount = 0;

  cellX = new Float32Array(0);
  cellY = new Float32Array(0);
  active = new Uint8Array(0);
  cellProximity = new Float32Array(0);
  cellEdge = new Uint8Array(0);
  /** Desplazamiento (px CSS) de cada celda de borde hacia el contorno subpíxel; 0 en el interior. */
  cellOffsetX = new Float32Array(0);
  cellOffsetY = new Float32Array(0);
  /** Manos aplicadas y celdas que gobiernan en el último frame (diagnóstico). */
  handsApplied = 0;
  handCells = 0;
  /** Track temporal dueño de cada celda activa; -1 para fondo. No es identidad persistente. */
  cellPersonId = new Int32Array(0);
  /** Celdas activas en orden aleatorio estable (evita sesgos de barrido al asignar). */
  activeList = new Int32Array(0);
  activeCount = 0;
  /** Fracción real de celdas candidatas conservadas tras densidad y presupuesto. */
  densityApplied = 0;

  /** Personas confirmadas en pantalla (centroides en px CSS). */
  peopleCount = 0;
  readonly peopleX: Float32Array;
  readonly peopleY: Float32Array;
  readonly peopleProximity: Float32Array;
  readonly peopleId: Int32Array;
  /** Desplazamiento del centro de cada track desde el frame de visión anterior, en px CSS. */
  readonly peopleDx: Float32Array;
  readonly peopleDy: Float32Array;
  /** Velocidad filtrada en px/ms y adelanto predictivo final en px CSS. */
  readonly peopleVx: Float32Array;
  readonly peopleVy: Float32Array;
  readonly peopleSpeed: Float32Array;
  readonly peoplePredictionX: Float32Array;
  readonly peoplePredictionY: Float32Array;
  readonly peoplePredictionActive: Uint8Array;
  /** Velocidad de traslación confiable (px/ms) para interpolar entre frames de visión; 0 si no es estable. */
  readonly peopleInterpolationVx: Float32Array;
  readonly peopleInterpolationVy: Float32Array;
  /**
   * Celdas enteras que el cuerpo se trasladó desde el frame anterior. Permite desplazar toda la
   * silueta a la vez en lugar de mandar partículas del borde trasero al delantero.
   */
  readonly peopleCellShiftX: Int32Array;
  readonly peopleCellShiftY: Int32Array;
  /**
   * Siluetas detectadas que aún no se confirman (px CSS). No forman cuerpo: sólo permiten que el
   * campo note la presencia unos milisegundos antes de la formación.
   */
  pendingCount = 0;
  readonly pendingX: Float32Array;
  readonly pendingY: Float32Array;
  /** Momento del último frame de visión aplicado (performance.now()). */
  lastVisionAt = 0;
  /** Copia de la última detección para mapear gestos. */
  readonly lastPeople: PersonInfo[] = [];

  private rank = new Float32Array(0);
  private order = new Uint32Array(0);
  private cellPerson = new Int8Array(0);
  private colToMask = new Int32Array(0);
  private rowToMask = new Int32Array(0);
  /** Coordenada continua de la máscara (px de máscara) para cada columna y fila; -1 fuera. */
  private colToMaskF = new Float32Array(0);
  private rowToMaskF = new Float32Array(0);
  /** Histéresis por celda del contorno subpíxel. */
  private cellOn = new Uint8Array(0);
  /** Mano que gobierna cada celda (índice en el análisis del frame); -1 si manda la máscara general. */
  private cellHand = new Int8Array(0);
  private readonly handShapes = Array.from({ length: MAX_HANDS }, () => new HandShape());
  private readonly handObservations: (HandObservation | null)[] = new Array(MAX_HANDS).fill(null);
  private readonly handWeight = new Float32Array(MAX_HANDS);
  private readonly handReach = new Float32Array(MAX_HANDS);
  private readonly handFeather = new Float32Array(MAX_HANDS);
  private readonly handGate = new Float32Array(MAX_HANDS);
  private readonly handHasShape = new Uint8Array(MAX_HANDS);
  private handSoft = 1;
  private handCount = 0;
  /** Px CSS de pantalla por px de máscara (con signo del espejo en X). */
  private screenPerMaskX = 1;
  private screenPerMaskY = 1;
  private mappingKey = '';
  private mapOffsetX = 0;
  private mapOffsetY = 0;
  private mapScaleX = 1;
  private mapScaleY = 1;
  private budgetScale = 1;
  private lastUpdate = 0;

  private readonly slotKeep: Float32Array;
  private readonly slotPersonId: Int32Array;
  private readonly slotProximity: Float32Array;
  private readonly slotCount: Int32Array;
  private readonly slotSumX: Float64Array;
  private readonly slotSumY: Float64Array;
  private readonly slotBox: Float32Array;
  private readonly slotClip: Uint8Array;
  private readonly trackCenters = new Map<number, TrackMotion>();
  private readonly edgePoint = { x: 0, y: 0 };

  constructor(private readonly config: Config) {
    const slots = 8;
    this.slotKeep = new Float32Array(slots);
    this.slotPersonId = new Int32Array(slots).fill(-1);
    this.slotProximity = new Float32Array(slots);
    this.slotCount = new Int32Array(slots);
    this.slotSumX = new Float64Array(slots);
    this.slotSumY = new Float64Array(slots);
    this.peopleX = new Float32Array(slots);
    this.peopleY = new Float32Array(slots);
    this.peopleProximity = new Float32Array(slots);
    this.peopleId = new Int32Array(slots).fill(-1);
    this.peopleDx = new Float32Array(slots);
    this.peopleDy = new Float32Array(slots);
    this.peopleVx = new Float32Array(slots);
    this.peopleVy = new Float32Array(slots);
    this.peopleSpeed = new Float32Array(slots);
    this.peoplePredictionX = new Float32Array(slots);
    this.peoplePredictionY = new Float32Array(slots);
    this.peoplePredictionActive = new Uint8Array(slots);
    this.peopleInterpolationVx = new Float32Array(slots);
    this.peopleInterpolationVy = new Float32Array(slots);
    this.peopleCellShiftX = new Int32Array(slots);
    this.peopleCellShiftY = new Int32Array(slots);
    this.pendingX = new Float32Array(slots);
    this.pendingY = new Float32Array(slots);
    this.slotBox = new Float32Array(slots * 4);
    this.slotClip = new Uint8Array(slots);
  }

  resize(width: number, height: number): void {
    const { particleSpacing } = this.config.particles;
    this.width = width;
    this.height = height;
    this.spacing = particleSpacing * screenScale(width, height);
    this.cols = Math.max(1, Math.floor(width / this.spacing));
    this.rows = Math.max(1, Math.floor(height / this.spacing));
    this.cellCount = this.cols * this.rows;

    const n = this.cellCount;
    this.cellX = new Float32Array(n);
    this.cellY = new Float32Array(n);
    this.active = new Uint8Array(n);
    this.cellProximity = new Float32Array(n);
    this.cellEdge = new Uint8Array(n);
    this.cellOffsetX = new Float32Array(n);
    this.cellOffsetY = new Float32Array(n);
    this.cellOn = new Uint8Array(n);
    this.cellHand = new Int8Array(n).fill(-1);
    this.cellPersonId = new Int32Array(n).fill(-1);
    this.activeList = new Int32Array(n);
    this.rank = new Float32Array(n);
    this.cellPerson = new Int8Array(n);
    this.colToMask = new Int32Array(this.cols);
    this.rowToMask = new Int32Array(this.rows);
    this.colToMaskF = new Float32Array(this.cols);
    this.rowToMaskF = new Float32Array(this.rows);

    const offsetX = (width - (this.cols - 1) * this.spacing) / 2;
    const offsetY = (height - (this.rows - 1) * this.spacing) / 2;
    const random = createRandom(0xce11);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        this.cellX[i] = offsetX + c * this.spacing;
        this.cellY[i] = offsetY + r * this.spacing;
        // Bayer con jitter: al decimar por proximidad las celdas restantes quedan repartidas.
        this.rank[i] = (BAYER_4[(r & 3) * 4 + (c & 3)] + random()) / 16;
      }
    }

    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.order = Uint32Array.from(order);
    this.mappingKey = '';
    this.activeCount = 0;
    this.peopleCount = 0;
    this.pendingCount = 0;
    this.peopleId.fill(-1);
    this.peopleVx.fill(0);
    this.peopleVy.fill(0);
    this.peopleSpeed.fill(0);
    this.peoplePredictionX.fill(0);
    this.peoplePredictionY.fill(0);
    this.peoplePredictionActive.fill(0);
    this.peopleInterpolationVx.fill(0);
    this.peopleInterpolationVy.fill(0);
    this.peopleCellShiftX.fill(0);
    this.peopleCellShiftY.fill(0);
    this.trackCenters.clear();
    this.version++;
  }

  update(frame: VisionFrame, now: number): void {
    const cfg = this.config;
    const { far, close } = cfg.particles.particleDensity;
    this.ensureMapping(frame.width, frame.height);
    const dt = this.lastUpdate === 0 ? 33 : now - this.lastUpdate;
    this.lastUpdate = now;
    this.lastVisionAt = now;

    const { slotKeep, slotProximity, slotCount, slotSumX, slotSumY } = this;
    slotKeep.fill(0);
    this.slotPersonId.fill(-1);
    slotCount.fill(0);
    slotSumX.fill(0);
    slotSumY.fill(0);

    this.lastPeople.length = 0;
    const crop = frameRegion(cfg);
    this.pendingCount = 0;
    for (const person of frame.people) {
      this.lastPeople.push({ ...person });
      if (!person.confirmed && this.pendingCount < this.pendingX.length) {
        const point = this.cameraToScreen(person.cx, person.cy, this.edgePoint);
        this.pendingX[this.pendingCount] = point.x;
        this.pendingY[this.pendingCount] = point.y;
        this.pendingCount++;
      }
      if (!person.confirmed || person.slot >= slotKeep.length) continue;
      slotProximity[person.slot] = person.proximity;
      slotKeep[person.slot] = lerp(far, close, person.proximity);
      this.slotPersonId[person.slot] = person.id;
      this.storeScreenBox(person, person.slot, crop);
    }

    const { cols, rows, colToMask, rowToMask, cellPerson, cellX, cellY } = this;
    const map = frame.personMap;
    const maskWidth = frame.width;
    const confidence = frame.confidenceMap;
    if (confidence && confidence.length === map.length && frame.width > 1 && frame.height > 1) {
      this.sampleContour(frame, confidence);
      this.applyHands(frame, confidence, now);
    } else for (let r = 0; r < rows; r++) {
      const my = rowToMask[r];
      const rowStart = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = rowStart + c;
        const mx = colToMask[c];
        if (mx < 0 || my < 0) {
          cellPerson[i] = -1;
          continue;
        }
        const value = map[my * maskWidth + mx];
        const slot = value - 1;
        if (value === 0 || slotKeep[slot] === 0) {
          cellPerson[i] = -1;
          continue;
        }
        cellPerson[i] = slot;
        slotCount[slot]++;
        slotSumX[slot] += cellX[i];
        slotSumY[slot] += cellY[i];
      }
    }

    let demand = 0;
    for (let s = 0; s < slotKeep.length; s++) demand += slotCount[s] * slotKeep[s];
    const budget = cfg.particles.bodyParticleBudget;
    const targetScale = demand > budget ? budget / demand : 1;
    // Reducir rápido para respetar el presupuesto; crecer despacio para que la densidad no salte.
    this.budgetScale += (targetScale - this.budgetScale) * expAlpha(dt, targetScale < this.budgetScale ? 60 : 500);

    this.peopleCount = 0;
    for (let s = 0; s < slotKeep.length; s++) {
      slotKeep[s] *= this.budgetScale;
      if (slotCount[s] === 0) continue;
      const k = this.peopleCount++;
      const x = slotSumX[s] / slotCount[s];
      const y = slotSumY[s] / slotCount[s];
      const id = this.slotPersonId[s];
      this.peopleProximity[k] = slotProximity[s];
      this.updateTrackMotion(k, s, id, x, y, now);
    }
    for (const [id, center] of this.trackCenters) {
      if (now - center.lastSeen > cfg.vision.trackTimeoutMs * 2) this.trackCenters.delete(id);
    }

    let candidateCells = 0;
    for (let s = 0; s < slotCount.length; s++) candidateCells += slotCount[s];
    const { order, rank, active, activeList, cellProximity, cellEdge, cellOffsetX, cellOffsetY } = this;
    const { protectEdges, edgeSnap } = cfg.particles.silhouette;
    const snapContour = confidence !== undefined && confidence.length === map.length && edgeSnap > 0;
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    let count = 0;
    for (let k = 0; k < this.cellCount; k++) {
      const i = order[k];
      const slot = cellPerson[i];
      if (slot < 0) {
        active[i] = 0;
        this.cellPersonId[i] = -1;
        continue;
      }
      const c = i % cols;
      const r = (i - c) / cols;
      const edge =
        c === 0 || c === lastCol || r === 0 || r === lastRow ||
        cellPerson[i - 1] !== slot || cellPerson[i + 1] !== slot ||
        cellPerson[i - cols] !== slot || cellPerson[i + cols] !== slot;
      // El presupuesto aclara el interior, nunca el contorno.
      if (rank[i] >= slotKeep[slot] && !(edge && protectEdges)) {
        active[i] = 0;
        this.cellPersonId[i] = -1;
        continue;
      }
      active[i] = 1;
      this.cellPersonId[i] = this.slotPersonId[slot];
      activeList[count++] = i;
      cellProximity[i] = slotProximity[slot];
      cellEdge[i] = edge ? 1 : 0;
      if (edge && snapContour && confidence) {
        if (this.cellHand[i] >= 0) this.snapToHand(i, c, r, frame.width, frame.height, confidence);
        else this.snapToContour(i, c, r, frame.width, frame.height, confidence);
      }
      else {
        cellOffsetX[i] = 0;
        cellOffsetY[i] = 0;
      }
    }
    this.activeCount = count;
    this.densityApplied = candidateCells > 0 ? count / candidateCells : 0;
  }

  clear(): void {
    this.active.fill(0);
    this.cellOn.fill(0);
    this.cellHand.fill(-1);
    this.handsApplied = 0;
    this.handCells = 0;
    this.activeCount = 0;
    this.densityApplied = 0;
    this.peopleCount = 0;
    this.pendingCount = 0;
    this.peopleId.fill(-1);
    this.peopleVx.fill(0);
    this.peopleVy.fill(0);
    this.peopleSpeed.fill(0);
    this.peoplePredictionX.fill(0);
    this.peoplePredictionY.fill(0);
    this.peoplePredictionActive.fill(0);
    this.peopleInterpolationVx.fill(0);
    this.peopleInterpolationVy.fill(0);
    this.peopleCellShiftX.fill(0);
    this.peopleCellShiftY.fill(0);
    this.cellPersonId.fill(-1);
    this.trackCenters.clear();
    this.lastPeople.length = 0;
  }

  personIndex(id: number): number {
    for (let i = 0; i < this.peopleCount; i++) if (this.peopleId[i] === id) return i;
    return -1;
  }

  /** Edad desde la última observación del track; Infinity si ya no existe. */
  trackAge(id: number, now: number): number {
    const track = this.trackCenters.get(id);
    return track ? now - track.lastSeen : Infinity;
  }

  /** Convierte coordenadas normalizadas de cámara a px CSS en pantalla (aplica recorte, encuadre y espejo). */
  cameraToScreen(u: number, v: number, out: { x: number; y: number }): { x: number; y: number } {
    const crop = frameRegion(this.config);
    const { mirror } = this.config.camera;
    let su = (u - crop.x) / crop.width;
    if (mirror) su = 1 - su;
    out.x = this.mapOffsetX + su * this.mapScaleX;
    out.y = this.mapOffsetY + ((v - crop.y) / crop.height) * this.mapScaleY;
    return out;
  }

  /** Caja de la persona en px CSS de pantalla y qué bordes están cortados por el recorte. */
  private storeScreenBox(person: PersonInfo, slot: number, crop: Config['camera']['crop']): void {
    const a = this.cameraToScreen(person.x0, person.y0, this.edgePoint);
    const ax = a.x;
    const ay = a.y;
    const b = this.cameraToScreen(person.x1, person.y1, this.edgePoint);
    const o = slot * 4;
    this.slotBox[o] = Math.min(ax, b.x);
    this.slotBox[o + 1] = Math.max(ax, b.x);
    this.slotBox[o + 2] = Math.min(ay, b.y);
    this.slotBox[o + 3] = Math.max(ay, b.y);
    const clipX0 = person.x0 <= crop.x + EDGE_CLIP_EPSILON;
    const clipX1 = person.x1 >= crop.x + crop.width - EDGE_CLIP_EPSILON;
    const mirror = this.config.camera.mirror;
    // Bits: 1 izquierda, 2 derecha, 4 arriba, 8 abajo (en pantalla).
    this.slotClip[slot] =
      ((mirror ? clipX1 : clipX0) ? 1 : 0) |
      ((mirror ? clipX0 : clipX1) ? 2 : 0) |
      (person.y0 <= crop.y + EDGE_CLIP_EPSILON ? 4 : 0) |
      (person.y1 >= crop.y + crop.height - EDGE_CLIP_EPSILON ? 8 : 0);
  }

  /**
   * Velocidad del centro (tamaño aparente, magnetismo, perfil rápido) y velocidad de traslación
   * rígida (predicción e interpolación). La predicción sólo existe para tracks estables, se atenúa
   * al girar o frenar, crece suavemente y se corta de inmediato.
   */
  private updateTrackMotion(k: number, slot: number, id: number, x: number, y: number, now: number): void {
    const p = this.config.particles;
    const scale = screenScale(this.width, this.height);
    const o = slot * 4;
    const left = this.slotBox[o];
    const right = this.slotBox[o + 1];
    const top = this.slotBox[o + 2];
    const bottom = this.slotBox[o + 3];
    const clip = this.slotClip[slot];

    const previous = this.trackCenters.get(id);
    const elapsed = previous ? Math.max(1, now - previous.lastSeen) : 0;
    const dx = previous ? x - previous.x : 0;
    const dy = previous ? y - previous.y : 0;
    const rawVx = previous ? dx / elapsed : 0;
    const rawVy = previous ? dy / elapsed : 0;
    const rawSpeed = Math.hypot(rawVx, rawVy) * 1000;
    const jump = previous === undefined || elapsed > this.config.vision.trackTimeoutMs || rawSpeed > p.predictionMaxTrackSpeed * scale;

    let vx = 0;
    let vy = 0;
    let tvx = 0;
    let tvy = 0;
    let translationX = 0;
    let translationY = 0;
    let stableFrames = 1;
    let reversal = false;
    let directionConfidence = 1;
    let brakeFactor = 1;

    if (previous && !jump) {
      const alpha = expAlpha(elapsed, p.predictionSmoothingMs);
      vx = lerp(previous.vx, rawVx, alpha);
      vy = lerp(previous.vy, rawVy, alpha);

      translationX = rigidTranslation(left - previous.left, right - previous.right, (clip & 1) !== 0, (clip & 2) !== 0);
      translationY = rigidTranslation(top - previous.top, bottom - previous.bottom, (clip & 4) !== 0, (clip & 8) !== 0);
      const rawTvx = translationX / elapsed;
      const rawTvy = translationY / elapsed;
      const rawTSpeed = Math.hypot(rawTvx, rawTvy) * 1000;
      const previousTSpeed = Math.hypot(previous.tvx, previous.tvy) * 1000;
      const minSpeed = p.predictionMinSpeed * scale;
      const cosine = rawTSpeed > minSpeed && previousTSpeed > minSpeed
        ? (rawTvx * previous.tvx + rawTvy * previous.tvy) / ((rawTSpeed / 1000) * (previousTSpeed / 1000))
        : 1;
      reversal = cosine < p.predictionReversalCosine;
      const braking = previousTSpeed > minSpeed && rawTSpeed < previousTSpeed * p.predictionBrakeRatio;

      if (reversal) {
        // Cambiar de dirección invalida el adelanto: se reinicia la estabilidad.
        tvx = rawTvx;
        tvy = rawTvy;
      } else {
        const translationAlpha = expAlpha(elapsed, braking ? p.predictionSmoothingMs * BRAKE_SMOOTHING_FACTOR : p.predictionSmoothingMs);
        tvx = lerp(previous.tvx, rawTvx, translationAlpha);
        tvy = lerp(previous.tvy, rawTvy, translationAlpha);
        stableFrames = Math.min(255, previous.stableFrames + 1);
        directionConfidence = smoothstep(p.predictionTurnCosine, FULL_CONFIDENCE_COSINE, cosine);
        if (braking) brakeFactor = clamp01(rawTSpeed / (previousTSpeed * p.predictionBrakeRatio));
      }
    }

    const translationSpeed = Math.hypot(tvx, tvy) * 1000;
    const stable = !jump && !reversal && stableFrames >= p.predictionStableFrames && translationSpeed >= p.predictionMinSpeed * scale;
    const confidence = stable ? directionConfidence * brakeFactor : 0;
    const canPredict = p.predictionMs > 0 && confidence > 0;

    let targetX = canPredict ? tvx * p.predictionMs * confidence : 0;
    let targetY = canPredict ? tvy * p.predictionMs * confidence * p.predictionVerticalFactor : 0;
    const maxPrediction = p.predictionMaxDistance * scale;
    const targetDistance = Math.hypot(targetX, targetY);
    if (targetDistance > maxPrediction) {
      targetX *= maxPrediction / targetDistance;
      targetY *= maxPrediction / targetDistance;
    }
    let predictionX = targetX;
    let predictionY = targetY;
    if (previous && canPredict && targetDistance > Math.hypot(previous.predictionX, previous.predictionY)) {
      const rise = expAlpha(elapsed, p.predictionRiseMs);
      predictionX = lerp(previous.predictionX, targetX, rise);
      predictionY = lerp(previous.predictionY, targetY, rise);
    }

    this.peopleX[k] = x;
    this.peopleY[k] = y;
    this.peopleId[k] = id;
    this.peopleDx[k] = dx;
    this.peopleDy[k] = dy;
    this.peopleVx[k] = vx;
    this.peopleVy[k] = vy;
    this.peopleSpeed[k] = Math.hypot(vx, vy) * 1000;
    this.peoplePredictionX[k] = predictionX;
    this.peoplePredictionY[k] = predictionY;
    this.peoplePredictionActive[k] = canPredict ? 1 : 0;
    this.peopleInterpolationVx[k] = tvx * confidence;
    this.peopleInterpolationVy[k] = tvy * confidence * p.predictionVerticalFactor;

    const motion: TrackMotion = previous ?? {
      x, y, vx: 0, vy: 0, left, right, top, bottom, tvx: 0, tvy: 0, predictionX: 0, predictionY: 0,
      cellCarryX: 0, cellCarryY: 0, stableFrames: 1, lastSeen: now,
    };
    if (jump) {
      motion.cellCarryX = 0;
      motion.cellCarryY = 0;
    } else {
      motion.cellCarryX += translationX / this.spacing;
      motion.cellCarryY += translationY / this.spacing;
    }
    const shiftX = Math.trunc(motion.cellCarryX);
    const shiftY = Math.trunc(motion.cellCarryY);
    motion.cellCarryX -= shiftX;
    motion.cellCarryY -= shiftY;
    this.peopleCellShiftX[k] = shiftX;
    this.peopleCellShiftY[k] = shiftY;
    motion.x = x;
    motion.y = y;
    motion.vx = vx;
    motion.vy = vy;
    motion.left = left;
    motion.right = right;
    motion.top = top;
    motion.bottom = bottom;
    motion.tvx = tvx;
    motion.tvy = tvy;
    motion.predictionX = predictionX;
    motion.predictionY = predictionY;
    motion.stableFrames = stableFrames;
    motion.lastSeen = now;
    if (!previous) this.trackCenters.set(id, motion);
  }

  /**
   * Contorno subpíxel: cada celda interpola la confianza suavizada de la máscara (bilineal) en su
   * posición exacta. Así el borde sigue la forma real en lugar de escalones de píxeles de máscara,
   * aunque la retícula sea más fina que la máscara. Cada celda tiene histéresis propia.
   */
  private sampleContour(frame: VisionFrame, confidence: Uint8Array): void {
    const { cols, rows, colToMaskF, rowToMaskF, cellPerson, cellX, cellY, cellOn, slotKeep, slotCount, slotSumX, slotSumY } = this;
    const { contourThreshold, contourHysteresis } = this.config.particles.silhouette;
    const onLevel = contourThreshold * 255;
    const holdLevel = Math.max(0, contourThreshold - contourHysteresis) * 255;
    const map = frame.personMap;
    const width = frame.width;
    const lastX = width - 2;
    const lastY = frame.height - 2;

    for (let r = 0; r < rows; r++) {
      const my = rowToMaskF[r];
      const rowStart = r * cols;
      if (my < 0) {
        for (let c = 0; c < cols; c++) {
          cellPerson[rowStart + c] = -1;
          cellOn[rowStart + c] = 0;
        }
        continue;
      }
      const fy = my - 0.5;
      let y0 = Math.floor(fy);
      if (y0 < 0) y0 = 0;
      else if (y0 > lastY) y0 = lastY;
      let ty = fy - y0;
      ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;

      for (let c = 0; c < cols; c++) {
        const i = rowStart + c;
        const mx = colToMaskF[c];
        if (mx < 0) {
          cellPerson[i] = -1;
          cellOn[i] = 0;
          continue;
        }
        const fx = mx - 0.5;
        let x0 = Math.floor(fx);
        if (x0 < 0) x0 = 0;
        else if (x0 > lastX) x0 = lastX;
        let tx = fx - x0;
        tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;

        const i00 = y0 * width + x0;
        const i10 = i00 + 1;
        const i01 = i00 + width;
        const i11 = i01 + 1;
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const value = confidence[i00] * w00 + confidence[i10] * w10 + confidence[i01] * w01 + confidence[i11] * w11;
        if (value < (cellOn[i] === 1 ? holdLevel : onLevel)) {
          cellPerson[i] = -1;
          cellOn[i] = 0;
          continue;
        }

        // La silueta dueña es la etiqueta confirmada con más peso entre los cuatro vecinos.
        let slot = -1;
        let best = 0;
        let label = map[i00];
        if (label !== 0 && slotKeep[label - 1] > 0 && w00 > best) { slot = label - 1; best = w00; }
        label = map[i10];
        if (label !== 0 && slotKeep[label - 1] > 0 && w10 > best) { slot = label - 1; best = w10; }
        label = map[i01];
        if (label !== 0 && slotKeep[label - 1] > 0 && w01 > best) { slot = label - 1; best = w01; }
        label = map[i11];
        if (label !== 0 && slotKeep[label - 1] > 0 && w11 > best) slot = label - 1;
        if (slot < 0) {
          cellPerson[i] = -1;
          cellOn[i] = 0;
          continue;
        }
        cellOn[i] = 1;
        cellPerson[i] = slot;
        slotCount[slot]++;
        slotSumX[slot] += cellX[i];
        slotSumY[slot] += cellY[i];
      }
    }
  }

  /**
   * Sustituye la máscara general por la mano analizada en alta resolución, sólo cerca de los dedos.
   * Ahí la forma viene de los 21 puntos y de la segmentación del recorte; más allá (antebrazo, cuerpo)
   * la máscara general sigue mandando, así que la mano nunca se separa del brazo.
   */
  private applyHands(frame: VisionFrame, confidence: Uint8Array, now: number): void {
    const settings = this.config.hands;
    this.cellHand.fill(-1);
    this.handsApplied = 0;
    this.handCells = 0;
    this.handCount = 0;
    const observations = frame.hands;
    if (!settings.enabled || !observations || observations.length === 0) return;

    const maskWidth = frame.width;
    const maskHeight = frame.height;
    const { contourThreshold, contourHysteresis } = this.config.particles.silhouette;
    const holdLevel = Math.max(0, contourThreshold - contourHysteresis);
    // Un dedo no puede ser más fino que la retícula, o no se vería.
    const spacingInMask = this.spacing / Math.max(1e-6, Math.abs(this.screenPerMaskX));
    const minRadius = Math.max(0.05, settings.minFingerWidthCells * spacingInMask * 0.5);
    this.handSoft = Math.max(0.15, spacingInMask * 0.5);
    const { cols, rows, colToMaskF, rowToMaskF, cellPerson, cellOn, cellX, cellY, slotCount, slotSumX, slotSumY } = this;

    for (const hand of observations) {
      if (this.handCount >= MAX_HANDS) break;
      const weight = 1 - smoothstep(settings.fadeStartMs, settings.maxAgeMs, now - hand.timestamp);
      if (weight <= 0.01) continue;
      const slot = this.slotForHand(hand, frame, maskWidth, maskHeight);
      if (slot < 0) continue;

      const h = this.handCount;
      const shape = this.handShapes[h];
      const hasShape = hand.landmarks.length >= 42 && shape.prepare(hand.landmarks, maskWidth, maskHeight, settings, minRadius);
      const hasMask = hand.mask !== null && hand.maskWidth > 1 && hand.mask.length === hand.maskWidth * hand.maskHeight;
      if (!hasShape && !hasMask) continue;

      this.handObservations[h] = hand;
      this.handHasShape[h] = hasShape ? 1 : 0;
      this.handWeight[h] = weight * (hasShape ? 1 : settings.segmentationOnlyWeight);
      this.handReach[h] = hasShape ? settings.patchReach * shape.palmLength : 0;
      this.handFeather[h] = hasShape ? Math.max(0.1, settings.patchFeather * shape.palmLength) : 0;
      this.handGate[h] = hasShape ? (settings.segmentationGate - 1) * shape.fingerRadius : 0;

      const margin = this.handReach[h] + this.handFeather[h] + this.handSoft;
      const x0 = hasShape ? shape.minX - margin : hand.roi.x * maskWidth;
      const x1 = hasShape ? shape.maxX + margin : (hand.roi.x + hand.roi.width) * maskWidth;
      const y0 = hasShape ? shape.minY - margin : hand.roi.y * maskHeight;
      const y1 = hasShape ? shape.maxY + margin : (hand.roi.y + hand.roi.height) * maskHeight;
      this.handCount++;
      this.handsApplied++;

      for (let r = 0; r < rows; r++) {
        const my = rowToMaskF[r];
        if (my < y0 || my > y1) continue;
        const rowStart = r * cols;
        for (let c = 0; c < cols; c++) {
          const mx = colToMaskF[c];
          if (mx < x0 || mx > x1) continue;
          const i = rowStart + c;
          const value = this.evaluateHand(h, mx, my, confidence, maskWidth, maskHeight);
          const previous = cellPerson[i];
          const on = value >= (cellOn[i] === 1 ? holdLevel : contourThreshold);
          const next = on ? slot : -1;
          if (next !== previous) {
            if (previous >= 0) {
              slotCount[previous]--;
              slotSumX[previous] -= cellX[i];
              slotSumY[previous] -= cellY[i];
            }
            if (next >= 0) {
              slotCount[next]++;
              slotSumX[next] += cellX[i];
              slotSumY[next] += cellY[i];
            }
            cellPerson[i] = next;
          }
          cellOn[i] = on ? 1 : 0;
          this.cellHand[i] = h;
          this.handCells++;
        }
      }
    }
  }

  /**
   * Confianza combinada en un punto (px de máscara): la mano pesa junto a los dedos y se desvanece
   * hacia el resto del cuerpo. Con landmarks, la segmentación del recorte sólo cuenta cerca del
   * esqueleto, así que una mancha del fondo no engorda la mano.
   */
  private evaluateHand(h: number, mx: number, my: number, confidence: Uint8Array, maskWidth: number, maskHeight: number): number {
    const coarse = sampleUint8(confidence, maskWidth, maskHeight, mx, my);
    const hand = this.handObservations[h];
    if (!hand) return coarse;
    const soft = this.handSoft;

    if (this.handHasShape[h] === 1) {
      const shape = this.handShapes[h];
      const local = 1 - smoothstep(this.handReach[h], this.handReach[h] + this.handFeather[h], shape.fingerDistance(mx, my));
      if (local <= 0) return coarse;
      const distance = shape.signedDistance(mx, my);
      let value = clamp01(0.5 - distance / soft);
      if (hand.mask) {
        const gate = clamp01(0.5 - (distance - this.handGate[h]) / soft);
        value = Math.max(value, this.sampleHandMask(hand, mx, my, maskWidth, maskHeight) * gate);
      }
      return coarse + (value - coarse) * (this.handWeight[h] * local);
    }

    // Sin landmarks sólo hay recorte segmentado: manda en el centro y se funde en sus bordes.
    const u = (mx / maskWidth - hand.roi.x) / hand.roi.width;
    const v = (my / maskHeight - hand.roi.y) / hand.roi.height;
    const fade = Math.min(smoothstep(0, 0.18, u) * smoothstep(0, 0.18, 1 - u), smoothstep(0, 0.18, v) * smoothstep(0, 0.18, 1 - v));
    if (fade <= 0) return coarse;
    const seg = this.sampleHandMask(hand, mx, my, maskWidth, maskHeight);
    return coarse + (seg - coarse) * (this.handWeight[h] * fade);
  }

  private sampleHandMask(hand: HandObservation, mx: number, my: number, maskWidth: number, maskHeight: number): number {
    if (!hand.mask) return 0;
    const u = (mx / maskWidth - hand.roi.x) / hand.roi.width;
    const v = (my / maskHeight - hand.roi.y) / hand.roi.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return sampleUint8(hand.mask, hand.maskWidth, hand.maskHeight, u * hand.maskWidth, v * hand.maskHeight);
  }

  /** Silueta dueña de una mano: su personId si llegó asociado, o la etiqueta de la máscara en la muñeca. */
  private slotForHand(hand: HandObservation, frame: VisionFrame, maskWidth: number, maskHeight: number): number {
    if (hand.personId >= 0) {
      for (let s = 0; s < this.slotPersonId.length; s++) {
        if (this.slotPersonId[s] === hand.personId && this.slotKeep[s] > 0) return s;
      }
      return -1;
    }
    const anchor = handAnchor(hand);
    const mx = Math.min(maskWidth - 1, Math.max(0, Math.round(anchor.x * maskWidth)));
    const my = Math.min(maskHeight - 1, Math.max(0, Math.round(anchor.y * maskHeight)));
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const sx = mx + dx;
        const sy = my + dy;
        if (sx < 0 || sy < 0 || sx >= maskWidth || sy >= maskHeight) continue;
        const slot = frame.personMap[sy * maskWidth + sx] - 1;
        if (slot >= 0 && this.slotKeep[slot] > 0) return slot;
      }
    }
    return -1;
  }

  /** Igual que snapToContour, pero sobre la confianza combinada con la mano (gradiente numérico). */
  private snapToHand(i: number, c: number, r: number, maskWidth: number, maskHeight: number, confidence: Uint8Array): void {
    const h = this.cellHand[i];
    const { contourThreshold, edgeSnap, maxSnap } = this.config.particles.silhouette;
    const mx = this.colToMaskF[c];
    const my = this.rowToMaskF[r];
    const step = Math.max(0.05, this.handSoft * 0.5);
    const value = this.evaluateHand(h, mx, my, confidence, maskWidth, maskHeight);
    const gx = (this.evaluateHand(h, mx + step, my, confidence, maskWidth, maskHeight) - value) / step;
    const gy = (this.evaluateHand(h, mx, my + step, confidence, maskWidth, maskHeight) - value) / step;
    const gradientSq = gx * gx + gy * gy;
    if (gradientSq < 1e-6) {
      this.cellOffsetX[i] = 0;
      this.cellOffsetY[i] = 0;
      return;
    }
    const advance = ((contourThreshold - value) / gradientSq) * edgeSnap;
    let ox = gx * advance * this.screenPerMaskX;
    let oy = gy * advance * this.screenPerMaskY;
    const limit = maxSnap * this.spacing;
    const distance = Math.hypot(ox, oy);
    if (distance > limit) {
      ox *= limit / distance;
      oy *= limit / distance;
    }
    this.cellOffsetX[i] = ox;
    this.cellOffsetY[i] = oy;
  }

  /**
   * Coloca una celda de borde sobre el contorno: un paso de Newton sobre la confianza bilineal
   * (a lo largo del gradiente) hasta `contourThreshold`, limitado a una fracción de la separación.
   */
  private snapToContour(i: number, c: number, r: number, width: number, height: number, confidence: Uint8Array): void {
    const { contourThreshold, edgeSnap, maxSnap } = this.config.particles.silhouette;
    const fx = this.colToMaskF[c] - 0.5;
    const fy = this.rowToMaskF[r] - 0.5;
    const x0 = Math.min(width - 2, Math.max(0, Math.floor(fx)));
    const y0 = Math.min(height - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const i00 = y0 * width + x0;
    const c00 = confidence[i00] / 255;
    const c10 = confidence[i00 + 1] / 255;
    const c01 = confidence[i00 + width] / 255;
    const c11 = confidence[i00 + width + 1] / 255;
    const value = c00 * (1 - tx) * (1 - ty) + c10 * tx * (1 - ty) + c01 * (1 - tx) * ty + c11 * tx * ty;
    // Gradiente en px de máscara.
    const gx = (c10 - c00) * (1 - ty) + (c11 - c01) * ty;
    const gy = (c01 - c00) * (1 - tx) + (c11 - c10) * tx;
    const gradientSq = gx * gx + gy * gy;
    if (gradientSq < 1e-6) {
      this.cellOffsetX[i] = 0;
      this.cellOffsetY[i] = 0;
      return;
    }
    const step = ((contourThreshold - value) / gradientSq) * edgeSnap;
    let ox = gx * step * this.screenPerMaskX;
    let oy = gy * step * this.screenPerMaskY;
    const limit = maxSnap * this.spacing;
    const distance = Math.hypot(ox, oy);
    if (distance > limit) {
      ox *= limit / distance;
      oy *= limit / distance;
    }
    this.cellOffsetX[i] = ox;
    this.cellOffsetY[i] = oy;
  }

  private ensureMapping(maskWidth: number, maskHeight: number): void {
    const crop = frameRegion(this.config);
    const { fit, mirror } = this.config.camera;
    const key = `${this.version}:${maskWidth}x${maskHeight}`;
    if (key === this.mappingKey) return;
    this.mappingKey = key;

    const regionW = maskWidth * crop.width;
    const regionH = maskHeight * crop.height;
    const scale = fit === 'cover'
      ? Math.max(this.width / regionW, this.height / regionH)
      : Math.min(this.width / regionW, this.height / regionH);
    const displayW = regionW * scale;
    const displayH = regionH * scale;
    this.mapOffsetX = (this.width - displayW) / 2;
    this.mapOffsetY = (this.height - displayH) / 2;
    this.mapScaleX = displayW;
    this.mapScaleY = displayH;

    this.screenPerMaskX = (displayW / (crop.width * maskWidth)) * (mirror ? -1 : 1);
    this.screenPerMaskY = displayH / (crop.height * maskHeight);
    for (let c = 0; c < this.cols; c++) {
      let u = (this.cellX[c] - this.mapOffsetX) / displayW;
      if (u < 0 || u >= 1) {
        this.colToMask[c] = -1;
        this.colToMaskF[c] = -1;
        continue;
      }
      if (mirror) u = 1 - u;
      const maskX = (crop.x + u * crop.width) * maskWidth;
      this.colToMask[c] = Math.min(maskWidth - 1, Math.floor(maskX));
      this.colToMaskF[c] = maskX;
    }
    for (let r = 0; r < this.rows; r++) {
      const v = (this.cellY[r * this.cols] - this.mapOffsetY) / displayH;
      const maskY = (crop.y + v * crop.height) * maskHeight;
      this.rowToMask[r] = v < 0 || v >= 1 ? -1 : Math.min(maskHeight - 1, Math.floor(maskY));
      this.rowToMaskF[r] = v < 0 || v >= 1 ? -1 : maskY;
    }
  }
}
