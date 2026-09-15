import type { Config, NormalizedRect } from '../config';
import { clamp, expAlpha, smoothstep } from '../utils/MathUtils';
import type { PersonInfo } from './types';

/**
 * Convierte la máscara de confianza cruda en siluetas limpias:
 * blur → suavizado temporal asimétrico → umbral con histéresis → componentes conexas
 * → filtro de área → asociación anónima entre frames → proximidad.
 *
 * Es código puro (sin DOM) para poder correr en el worker o en el hilo principal (mock).
 */

export interface MaskProcessorSettings {
  maskThreshold: number;
  maskHysteresis: number;
  smoothingAttackMs: number;
  smoothingReleaseMs: number;
  spatialBlurRadius: number;
  minPersonArea: number;
  maxPeople: number;
  presenceConfirmMs: number;
  trackMatchDistance: number;
  trackTimeoutMs: number;
  crop: NormalizedRect;
  proximity: { farSize: number; closeSize: number; smoothingMs: number };
}

export function maskSettingsFrom(config: Config): MaskProcessorSettings {
  const v = config.vision;
  return {
    maskThreshold: v.maskThreshold,
    maskHysteresis: v.maskHysteresis,
    smoothingAttackMs: v.smoothingAttackMs,
    smoothingReleaseMs: v.smoothingReleaseMs,
    spatialBlurRadius: v.spatialBlurRadius,
    minPersonArea: v.minPersonArea,
    maxPeople: v.maxPeople,
    presenceConfirmMs: v.presenceConfirmMs,
    trackMatchDistance: v.trackMatchDistance,
    trackTimeoutMs: v.trackTimeoutMs,
    crop: { ...config.camera.crop },
    proximity: { ...config.proximity },
  };
}

const MAX_COMPONENTS = 512;
const OVERFLOW_LABEL = MAX_COMPONENTS + 1;
const MAX_SLOTS = 8;
/** Un fragmento menor a esta fracción de una silueta cercana se une a ella (manos o cabeza separadas). */
const MERGE_AREA_RATIO = 0.35;
const MERGE_GAP = 0.05;

interface Track {
  id: number;
  cx: number;
  cy: number;
  proximity: number;
  firstSeen: number;
  lastSeen: number;
}

export class MaskProcessor {
  private width = 0;
  private height = 0;
  private field = new Float32Array(0);
  private blurTemp = new Float32Array(0);
  private blurOut = new Float32Array(0);
  private binary = new Uint8Array(0);
  private labels = new Int32Array(0);
  private stack = new Int32Array(0);
  private lastTimestamp = -1;

  private readonly compArea = new Int32Array(MAX_COMPONENTS + 1);
  private readonly compMinX = new Int32Array(MAX_COMPONENTS + 1);
  private readonly compMinY = new Int32Array(MAX_COMPONENTS + 1);
  private readonly compMaxX = new Int32Array(MAX_COMPONENTS + 1);
  private readonly compMaxY = new Int32Array(MAX_COMPONENTS + 1);
  private readonly compSumX = new Float64Array(MAX_COMPONENTS + 1);
  private readonly compSumY = new Float64Array(MAX_COMPONENTS + 1);
  private readonly compSlot = new Uint8Array(MAX_COMPONENTS + 1);
  private readonly candidates: number[] = [];

  private readonly slotArea = new Float64Array(MAX_SLOTS);
  private readonly slotMinX = new Float64Array(MAX_SLOTS);
  private readonly slotMinY = new Float64Array(MAX_SLOTS);
  private readonly slotMaxX = new Float64Array(MAX_SLOTS);
  private readonly slotMaxY = new Float64Array(MAX_SLOTS);
  private readonly slotSumX = new Float64Array(MAX_SLOTS);
  private readonly slotSumY = new Float64Array(MAX_SLOTS);
  private readonly slotTrack = new Int32Array(MAX_SLOTS);
  private readonly slotRawProximity = new Float64Array(MAX_SLOTS);

  private tracks: Track[] = [];
  private readonly trackUsed: boolean[] = [];
  private nextTrackId = 1;

  private readonly people: PersonInfo[] = [];
  private readonly personPool: PersonInfo[] = [];

  constructor(private readonly settings: MaskProcessorSettings) {
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.personPool.push({ id: 0, slot: i, x0: 0, y0: 0, x1: 0, y1: 0, cx: 0, cy: 0, area: 0, proximity: 0, confirmed: false });
    }
  }

  process(confidence: Float32Array, width: number, height: number, timestamp: number, personMap: Uint8Array): PersonInfo[] {
    this.ensureSize(width, height);
    const s = this.settings;
    const dt = this.lastTimestamp < 0 ? 33 : clamp(timestamp - this.lastTimestamp, 0, 1000);
    this.lastTimestamp = timestamp;

    const source = s.spatialBlurRadius > 0 ? this.blur(confidence, Math.round(s.spatialBlurRadius)) : confidence;
    const attack = expAlpha(dt, s.smoothingAttackMs);
    const release = expAlpha(dt, s.smoothingReleaseMs);
    const on = s.maskThreshold;
    const off = Math.max(0.02, s.maskThreshold - s.maskHysteresis);

    const cropX0 = clamp(Math.floor(s.crop.x * width), 0, width);
    const cropY0 = clamp(Math.floor(s.crop.y * height), 0, height);
    const cropX1 = clamp(Math.ceil((s.crop.x + s.crop.width) * width), cropX0, width);
    const cropY1 = clamp(Math.ceil((s.crop.y + s.crop.height) * height), cropY0, height);

    const field = this.field;
    const binary = this.binary;
    for (let y = 0; y < height; y++) {
      const insideY = y >= cropY0 && y < cropY1;
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        const value = source[i];
        let f = field[i];
        f += (value - f) * (value > f ? attack : release);
        field[i] = f;
        binary[i] = insideY && x >= cropX0 && x < cropX1 && (f > on || (binary[i] === 1 && f > off)) ? 1 : 0;
      }
    }

    const componentCount = this.labelComponents();
    const regionW = Math.max(1, cropX1 - cropX0);
    const regionH = Math.max(1, cropY1 - cropY0);
    const slotCount = this.selectPeople(componentCount, regionW, regionH);
    this.updateTracks(slotCount, dt, timestamp);
    this.buildPeople(slotCount, regionW * regionH, timestamp);

    const labels = this.labels;
    const compSlot = this.compSlot;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      personMap[i] = label !== 0 && label <= MAX_COMPONENTS ? compSlot[label] : 0;
    }
    return this.people;
  }

  reset(): void {
    this.field.fill(0);
    this.binary.fill(0);
    this.tracks = [];
    this.lastTimestamp = -1;
  }

  private ensureSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const n = width * height;
    this.width = width;
    this.height = height;
    this.field = new Float32Array(n);
    this.blurTemp = new Float32Array(n);
    this.blurOut = new Float32Array(n);
    this.binary = new Uint8Array(n);
    this.labels = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.tracks = [];
    this.lastTimestamp = -1;
  }

  /** Box blur separable con bordes replicados. */
  private blur(src: Float32Array, radius: number): Float32Array {
    const w = this.width;
    const h = this.height;
    const tmp = this.blurTemp;
    const out = this.blurOut;
    const norm = 1 / (2 * radius + 1);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[row + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * norm;
        acc += src[row + Math.min(x + radius + 1, w - 1)] - src[row + Math.max(x - radius, 0)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc * norm;
        acc += tmp[Math.min(y + radius + 1, h - 1) * w + x] - tmp[Math.max(y - radius, 0) * w + x];
      }
    }
    return out;
  }

  /** Flood fill 4-conexo con pila preasignada. */
  private labelComponents(): number {
    const { width, height, binary, labels, stack } = this;
    const { compArea, compMinX, compMinY, compMaxX, compMaxY, compSumX, compSumY } = this;
    labels.fill(0);
    let count = 0;
    const n = width * height;

    for (let start = 0; start < n; start++) {
      if (binary[start] === 0 || labels[start] !== 0) continue;
      const id = count < MAX_COMPONENTS ? ++count : OVERFLOW_LABEL;
      let area = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let sumX = 0;
      let sumY = 0;
      let top = 0;
      stack[top++] = start;
      labels[start] = id;

      while (top > 0) {
        const p = stack[--top];
        const x = p % width;
        const y = (p - x) / width;
        area++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && binary[p - 1] === 1 && labels[p - 1] === 0) {
          labels[p - 1] = id;
          stack[top++] = p - 1;
        }
        if (x < width - 1 && binary[p + 1] === 1 && labels[p + 1] === 0) {
          labels[p + 1] = id;
          stack[top++] = p + 1;
        }
        if (y > 0 && binary[p - width] === 1 && labels[p - width] === 0) {
          labels[p - width] = id;
          stack[top++] = p - width;
        }
        if (y < height - 1 && binary[p + width] === 1 && labels[p + width] === 0) {
          labels[p + width] = id;
          stack[top++] = p + width;
        }
      }

      if (id !== OVERFLOW_LABEL) {
        compArea[id] = area;
        compMinX[id] = minX;
        compMinY[id] = minY;
        compMaxX[id] = maxX;
        compMaxY[id] = maxY;
        compSumX[id] = sumX;
        compSumY[id] = sumY;
      }
    }
    return count;
  }

  private selectPeople(componentCount: number, regionW: number, regionH: number): number {
    const s = this.settings;
    const { width, height, compArea, compSlot, candidates } = this;
    const minArea = s.minPersonArea * regionW * regionH;
    const maxPeople = Math.min(s.maxPeople, MAX_SLOTS);

    candidates.length = 0;
    for (let label = 1; label <= componentCount; label++) {
      compSlot[label] = 0;
      if (compArea[label] >= minArea * 0.2) candidates.push(label);
    }
    candidates.sort((a, b) => compArea[b] - compArea[a]);

    let slots = 0;
    for (const label of candidates) {
      const area = compArea[label];

      let mergeSlot = -1;
      let bestGap = MERGE_GAP;
      for (let k = 0; k < slots; k++) {
        if (area >= this.slotArea[k] * MERGE_AREA_RATIO) continue;
        const dx = Math.max(0, this.compMinX[label] - this.slotMaxX[k], this.slotMinX[k] - this.compMaxX[label]) / width;
        const dy = Math.max(0, this.compMinY[label] - this.slotMaxY[k], this.slotMinY[k] - this.compMaxY[label]) / height;
        const gap = Math.max(dx, dy);
        if (gap <= bestGap) {
          bestGap = gap;
          mergeSlot = k;
        }
      }

      if (mergeSlot >= 0) {
        const k = mergeSlot;
        this.slotArea[k] += area;
        this.slotSumX[k] += this.compSumX[label];
        this.slotSumY[k] += this.compSumY[label];
        this.slotMinX[k] = Math.min(this.slotMinX[k], this.compMinX[label]);
        this.slotMinY[k] = Math.min(this.slotMinY[k], this.compMinY[label]);
        this.slotMaxX[k] = Math.max(this.slotMaxX[k], this.compMaxX[label]);
        this.slotMaxY[k] = Math.max(this.slotMaxY[k], this.compMaxY[label]);
        compSlot[label] = k + 1;
        continue;
      }

      if (area < minArea || slots >= maxPeople) continue;
      const k = slots++;
      this.slotArea[k] = area;
      this.slotSumX[k] = this.compSumX[label];
      this.slotSumY[k] = this.compSumY[label];
      this.slotMinX[k] = this.compMinX[label];
      this.slotMinY[k] = this.compMinY[label];
      this.slotMaxX[k] = this.compMaxX[label];
      this.slotMaxY[k] = this.compMaxY[label];
      compSlot[label] = k + 1;
    }

    const { farSize, closeSize } = s.proximity;
    for (let k = 0; k < slots; k++) {
      // El alto aparente domina; el área cubre a quien está tan cerca que el cuadro corta su cuerpo.
      const heightFraction = (this.slotMaxY[k] - this.slotMinY[k] + 1) / regionH;
      const areaFraction = this.slotArea[k] / (regionW * regionH);
      const size = Math.max(heightFraction, Math.sqrt(areaFraction) * 1.4);
      this.slotRawProximity[k] = smoothstep(farSize, closeSize, size);
    }
    return slots;
  }

  /** Asociación voraz por distancia de centroides. Sin identidad: sólo continuidad visual. */
  private updateTracks(slotCount: number, dt: number, timestamp: number): void {
    const s = this.settings;
    const tracks = this.tracks;
    const used = this.trackUsed;
    used.length = tracks.length;
    used.fill(false);
    for (let k = 0; k < slotCount; k++) this.slotTrack[k] = -1;

    const maxDistance = s.trackMatchDistance;
    for (let iteration = 0; iteration < slotCount; iteration++) {
      let bestSlot = -1;
      let bestTrack = -1;
      let bestDistance = maxDistance;
      for (let k = 0; k < slotCount; k++) {
        if (this.slotTrack[k] !== -1) continue;
        const cx = this.slotSumX[k] / this.slotArea[k] / this.width;
        const cy = this.slotSumY[k] / this.slotArea[k] / this.height;
        for (let t = 0; t < tracks.length; t++) {
          if (used[t]) continue;
          const distance = Math.hypot(tracks[t].cx - cx, tracks[t].cy - cy);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestSlot = k;
            bestTrack = t;
          }
        }
      }
      if (bestSlot < 0) break;
      this.slotTrack[bestSlot] = bestTrack;
      used[bestTrack] = true;
    }

    const proximityAlpha = expAlpha(dt, s.proximity.smoothingMs);
    for (let k = 0; k < slotCount; k++) {
      const cx = this.slotSumX[k] / this.slotArea[k] / this.width;
      const cy = this.slotSumY[k] / this.slotArea[k] / this.height;
      const raw = this.slotRawProximity[k];
      let index = this.slotTrack[k];
      if (index === -1) {
        index = tracks.length;
        tracks.push({ id: this.nextTrackId++, cx, cy, proximity: raw, firstSeen: timestamp, lastSeen: timestamp });
        used.push(true);
        this.slotTrack[k] = index;
      } else {
        const track = tracks[index];
        track.cx = cx;
        track.cy = cy;
        track.proximity += (raw - track.proximity) * proximityAlpha;
        track.lastSeen = timestamp;
      }
    }

    // Se eliminan al final para no invalidar los índices guardados en slotTrack.
    for (let t = tracks.length - 1; t >= 0; t--) {
      if (timestamp - tracks[t].lastSeen <= s.trackTimeoutMs) continue;
      tracks.splice(t, 1);
      for (let k = 0; k < slotCount; k++) if (this.slotTrack[k] > t) this.slotTrack[k]--;
    }
  }

  private buildPeople(slotCount: number, regionArea: number, timestamp: number): void {
    const { width, height, people } = this;
    people.length = 0;
    for (let k = 0; k < slotCount; k++) {
      const track = this.tracks[this.slotTrack[k]];
      const person = this.personPool[k];
      person.id = track.id;
      person.slot = k;
      person.x0 = this.slotMinX[k] / width;
      person.y0 = this.slotMinY[k] / height;
      person.x1 = (this.slotMaxX[k] + 1) / width;
      person.y1 = (this.slotMaxY[k] + 1) / height;
      person.cx = this.slotSumX[k] / this.slotArea[k] / width;
      person.cy = this.slotSumY[k] / this.slotArea[k] / height;
      person.area = this.slotArea[k] / regionArea;
      person.proximity = track.proximity;
      person.confirmed = timestamp - track.firstSeen >= this.settings.presenceConfirmMs;
      people.push(person);
    }
  }
}
