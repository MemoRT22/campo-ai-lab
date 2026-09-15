import type { Config } from '../config';
import { createRandom, expAlpha, lerp, screenScale } from '../utils/MathUtils';
import type { PersonInfo, VisionFrame } from '../vision/types';

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

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
  /** Celdas activas en orden aleatorio estable (evita sesgos de barrido al asignar). */
  activeList = new Int32Array(0);
  activeCount = 0;

  /** Personas confirmadas en pantalla (centroides en px CSS). */
  peopleCount = 0;
  readonly peopleX: Float32Array;
  readonly peopleY: Float32Array;
  readonly peopleProximity: Float32Array;
  /** Copia de la última detección para mapear gestos. */
  readonly lastPeople: PersonInfo[] = [];

  private rank = new Float32Array(0);
  private order = new Uint32Array(0);
  private cellPerson = new Int8Array(0);
  private colToMask = new Int32Array(0);
  private rowToMask = new Int32Array(0);
  private mappingKey = '';
  private mapOffsetX = 0;
  private mapOffsetY = 0;
  private mapScaleX = 1;
  private mapScaleY = 1;
  private budgetScale = 1;
  private lastUpdate = 0;

  private readonly slotKeep: Float32Array;
  private readonly slotProximity: Float32Array;
  private readonly slotCount: Int32Array;
  private readonly slotSumX: Float64Array;
  private readonly slotSumY: Float64Array;

  constructor(private readonly config: Config) {
    const slots = 8;
    this.slotKeep = new Float32Array(slots);
    this.slotProximity = new Float32Array(slots);
    this.slotCount = new Int32Array(slots);
    this.slotSumX = new Float64Array(slots);
    this.slotSumY = new Float64Array(slots);
    this.peopleX = new Float32Array(slots);
    this.peopleY = new Float32Array(slots);
    this.peopleProximity = new Float32Array(slots);
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
    this.activeList = new Int32Array(n);
    this.rank = new Float32Array(n);
    this.cellPerson = new Int8Array(n);
    this.colToMask = new Int32Array(this.cols);
    this.rowToMask = new Int32Array(this.rows);

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
    this.version++;
  }

  update(frame: VisionFrame, now: number): void {
    const cfg = this.config;
    const { far, close } = cfg.particles.particleDensity;
    this.ensureMapping(frame.width, frame.height);
    const dt = this.lastUpdate === 0 ? 33 : now - this.lastUpdate;
    this.lastUpdate = now;

    const { slotKeep, slotProximity, slotCount, slotSumX, slotSumY } = this;
    slotKeep.fill(0);
    slotCount.fill(0);
    slotSumX.fill(0);
    slotSumY.fill(0);

    this.lastPeople.length = 0;
    for (const person of frame.people) {
      this.lastPeople.push({ ...person });
      if (!person.confirmed || person.slot >= slotKeep.length) continue;
      slotProximity[person.slot] = person.proximity;
      slotKeep[person.slot] = lerp(far, close, person.proximity);
    }

    const { cols, rows, colToMask, rowToMask, cellPerson, cellX, cellY } = this;
    const map = frame.personMap;
    const maskWidth = frame.width;
    for (let r = 0; r < rows; r++) {
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
      this.peopleX[k] = slotSumX[s] / slotCount[s];
      this.peopleY[k] = slotSumY[s] / slotCount[s];
      this.peopleProximity[k] = slotProximity[s];
    }

    const { order, rank, active, activeList, cellProximity, cellEdge } = this;
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    let count = 0;
    for (let k = 0; k < this.cellCount; k++) {
      const i = order[k];
      const slot = cellPerson[i];
      if (slot < 0 || rank[i] >= slotKeep[slot]) {
        active[i] = 0;
        continue;
      }
      active[i] = 1;
      activeList[count++] = i;
      cellProximity[i] = slotProximity[slot];
      const c = i % cols;
      const r = (i - c) / cols;
      cellEdge[i] =
        c === 0 || c === lastCol || r === 0 || r === lastRow ||
        cellPerson[i - 1] !== slot || cellPerson[i + 1] !== slot ||
        cellPerson[i - cols] !== slot || cellPerson[i + cols] !== slot
          ? 1
          : 0;
    }
    this.activeCount = count;
  }

  clear(): void {
    this.active.fill(0);
    this.activeCount = 0;
    this.peopleCount = 0;
    this.lastPeople.length = 0;
  }

  /** Convierte coordenadas normalizadas de cámara a px CSS en pantalla (aplica recorte, encuadre y espejo). */
  cameraToScreen(u: number, v: number, out: { x: number; y: number }): { x: number; y: number } {
    const { crop, mirror } = this.config.camera;
    let su = (u - crop.x) / crop.width;
    if (mirror) su = 1 - su;
    out.x = this.mapOffsetX + su * this.mapScaleX;
    out.y = this.mapOffsetY + ((v - crop.y) / crop.height) * this.mapScaleY;
    return out;
  }

  private ensureMapping(maskWidth: number, maskHeight: number): void {
    const { crop, fit, mirror } = this.config.camera;
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

    for (let c = 0; c < this.cols; c++) {
      let u = (this.cellX[c] - this.mapOffsetX) / displayW;
      if (u < 0 || u >= 1) {
        this.colToMask[c] = -1;
        continue;
      }
      if (mirror) u = 1 - u;
      this.colToMask[c] = Math.min(maskWidth - 1, Math.floor((crop.x + u * crop.width) * maskWidth));
    }
    for (let r = 0; r < this.rows; r++) {
      const v = (this.cellY[r * this.cols] - this.mapOffsetY) / displayH;
      this.rowToMask[r] = v < 0 || v >= 1 ? -1 : Math.min(maskHeight - 1, Math.floor((crop.y + v * crop.height) * maskHeight));
    }
  }
}
