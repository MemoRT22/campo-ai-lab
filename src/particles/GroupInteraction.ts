import type { Config } from '../config';
import { expAlpha, smoothstep } from '../utils/MathUtils';

export type GroupSettings = Config['particles']['groupInteraction'];

export const GROUP_SINGLE = 0;
export const GROUP_PAIR = 1;
export const GROUP_COLLECTIVE = 2;
export const GROUP_MODE_LABELS = ['single', 'pair', 'collective'] as const;

export const MAX_GROUP_PEOPLE = 8;
export const MAX_CONNECTIONS = 6;
/** Por debajo de esta fuerza una conexión se considera apagada y su lugar se recicla. */
const STRENGTH_EPSILON = 0.004;
/** Fuerza desde la que una conexión cuenta como visible en debug. */
const VISIBLE_STRENGTH = 0.05;
const FRAME_MS = 1000 / 60;

/** Subconjunto de TargetField que necesita el grupo (px CSS y px/ms). */
export interface GroupPeople {
  peopleCount: number;
  peopleId: ArrayLike<number>;
  peopleX: ArrayLike<number>;
  peopleY: ArrayLike<number>;
  peopleVx: ArrayLike<number>;
  peopleVy: ArrayLike<number>;
}

export function modeForStableCount(stable: number): number {
  return stable >= 3 ? GROUP_COLLECTIVE : stable === 2 ? GROUP_PAIR : GROUP_SINGLE;
}

const pairI = new Int32Array((MAX_GROUP_PEOPLE * (MAX_GROUP_PEOPLE - 1)) / 2);
const pairJ = new Int32Array(pairI.length);
const pairD = new Float32Array(pairI.length);
const pairUsed = new Uint8Array(pairI.length);
const unionParent = new Int32Array(MAX_GROUP_PEOPLE);

function root(i: number): number {
  while (unionParent[i] !== i) i = unionParent[i];
  return i;
}

/**
 * Elige qué pares de personas se conectan. `distance` es una matriz `count × count` (fila principal).
 * Primero conecta a todos con el árbol de distancia mínima (nadie queda aislado si está a alcance) y
 * luego agrega los pares más cercanos restantes hasta `maxConnections`. O(P²) con P ≤ 8, sin allocations.
 */
export function selectPairs(
  count: number,
  distance: ArrayLike<number>,
  maxConnections: number,
  maxDistance: number,
  outA: Int32Array,
  outB: Int32Array,
): number {
  const n = Math.min(count, MAX_GROUP_PEOPLE);
  const limit = Math.min(maxConnections, outA.length, outB.length);
  let candidates = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distance[i * count + j];
      if (!(d <= maxDistance)) continue;
      // Inserción ordenada: a lo sumo 28 candidatos.
      let at = candidates++;
      while (at > 0 && pairD[at - 1] > d) {
        pairI[at] = pairI[at - 1];
        pairJ[at] = pairJ[at - 1];
        pairD[at] = pairD[at - 1];
        at--;
      }
      pairI[at] = i;
      pairJ[at] = j;
      pairD[at] = d;
    }
  }

  for (let i = 0; i < n; i++) unionParent[i] = i;
  pairUsed.fill(0);
  let selected = 0;
  for (let c = 0; c < candidates && selected < limit; c++) {
    const a = root(pairI[c]);
    const b = root(pairJ[c]);
    if (a === b) continue;
    unionParent[a] = b;
    pairUsed[c] = 1;
    outA[selected] = pairI[c];
    outB[selected] = pairJ[c];
    selected++;
  }
  for (let c = 0; c < candidates && selected < limit; c++) {
    if (pairUsed[c] === 1) continue;
    outA[selected] = pairI[c];
    outB[selected] = pairJ[c];
    selected++;
  }
  return selected;
}

/**
 * Estado social del campo: cuántas personas estables hay, en qué modo está el grupo y qué
 * conexiones existen entre ellas. Es lógica pura y determinista; ParticleSystem sólo la dibuja.
 *
 * Todo lo visible está suavizado: el modo usa histéresis temporal, cada conexión conserva su lugar
 * mientras su par exista, su fuerza sube y baja con constantes de tiempo y sus extremos siguen a
 * las personas con suavizado. Así nada salta al caminar.
 */
export class GroupInteraction {
  mode = GROUP_SINGLE;
  stableCount = 0;
  /** Actividad del campo (0..1): sube en modo colectivo, apenas con dos personas. */
  energy = 0;
  /** Conexiones con fuerza visible. */
  connectionCount = 0;

  readonly connectionIdA = new Int32Array(MAX_CONNECTIONS).fill(-1);
  readonly connectionIdB = new Int32Array(MAX_CONNECTIONS).fill(-1);
  readonly strength = new Float32Array(MAX_CONNECTIONS);
  readonly targetStrength = new Float32Array(MAX_CONNECTIONS);
  /** Extremos suavizados (centros de las personas, px CSS). */
  readonly ax = new Float32Array(MAX_CONNECTIONS);
  readonly ay = new Float32Array(MAX_CONNECTIONS);
  readonly bx = new Float32Array(MAX_CONNECTIONS);
  readonly by = new Float32Array(MAX_CONNECTIONS);
  /** Movimiento relativo suavizado entre ambas personas (0..1). */
  readonly relativeMotion = new Float32Array(MAX_CONNECTIONS);
  /** Partículas del campo que cada conexión puede usar en este momento. */
  readonly particleBudget = new Int32Array(MAX_CONNECTIONS);
  readonly seed = new Float32Array(MAX_CONNECTIONS);

  private readonly trackId = new Int32Array(MAX_GROUP_PEOPLE).fill(-1);
  private readonly trackFirst = new Float64Array(MAX_GROUP_PEOPLE);
  private readonly trackLast = new Float64Array(MAX_GROUP_PEOPLE);
  private readonly trackX = new Float32Array(MAX_GROUP_PEOPLE);
  private readonly trackY = new Float32Array(MAX_GROUP_PEOPLE);
  private readonly trackVx = new Float32Array(MAX_GROUP_PEOPLE);
  private readonly trackVy = new Float32Array(MAX_GROUP_PEOPLE);
  private readonly trackSeen = new Uint8Array(MAX_GROUP_PEOPLE);

  private readonly stableTrack = new Int32Array(MAX_GROUP_PEOPLE);
  private readonly distance = new Float32Array(MAX_GROUP_PEOPLE * MAX_GROUP_PEOPLE);
  private readonly selectedA = new Int32Array(MAX_CONNECTIONS);
  private readonly selectedB = new Int32Array(MAX_CONNECTIONS);
  private readonly connectionSelected = new Uint8Array(MAX_CONNECTIONS);

  private pendingMode = GROUP_SINGLE;
  private pendingSince = 0;
  private lastUpdate = -1;
  private seedCounter = 0;

  constructor(private readonly settings: GroupSettings) {}

  update(people: GroupPeople, now: number, scale: number): void {
    const s = this.settings;
    const dt = this.lastUpdate < 0 ? FRAME_MS : Math.max(0, now - this.lastUpdate);
    this.lastUpdate = now;

    this.updateTracks(people, now);

    let stable = 0;
    for (let t = 0; t < MAX_GROUP_PEOPLE; t++) {
      if (this.trackId[t] >= 0 && now - this.trackFirst[t] >= s.stableMs) this.stableTrack[stable++] = t;
    }
    this.stableCount = stable;
    this.updateMode(s.enabled ? modeForStableCount(stable) : GROUP_SINGLE, now);

    this.connectionSelected.fill(0);
    if (this.mode >= GROUP_PAIR && stable >= 2) this.selectConnections(stable, scale);

    // Las conexiones no elegidas siguen a sus personas mientras existan y se apagan con suavidad.
    const positionAlpha = expAlpha(dt, s.positionSmoothingMs);
    const relativeAlpha = expAlpha(dt, s.relativeSpeedSmoothingMs);
    let live = 0;
    let visible = 0;
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      if (this.connectionIdA[c] < 0) continue;
      if (this.connectionSelected[c] === 0) this.targetStrength[c] = 0;
      const ta = this.trackIndex(this.connectionIdA[c]);
      const tb = this.trackIndex(this.connectionIdB[c]);
      if (ta >= 0 && tb >= 0) {
        this.ax[c] += (this.trackX[ta] - this.ax[c]) * positionAlpha;
        this.ay[c] += (this.trackY[ta] - this.ay[c]) * positionAlpha;
        this.bx[c] += (this.trackX[tb] - this.bx[c]) * positionAlpha;
        this.by[c] += (this.trackY[tb] - this.by[c]) * positionAlpha;
        const relative = Math.hypot(this.trackVx[ta] - this.trackVx[tb], this.trackVy[ta] - this.trackVy[tb]) * 1000;
        const motion = smoothstep(0, s.relativeSpeedFull * scale, relative);
        this.relativeMotion[c] += (motion - this.relativeMotion[c]) * relativeAlpha;
      } else {
        this.targetStrength[c] = 0;
      }
      const target = this.targetStrength[c];
      const rising = target > this.strength[c];
      this.strength[c] += (target - this.strength[c]) * expAlpha(dt, rising ? s.strengthAttackMs : s.strengthReleaseMs);
      if (this.connectionSelected[c] === 0 && this.strength[c] < STRENGTH_EPSILON) {
        this.freeConnection(c);
        continue;
      }
      live++;
      if (this.strength[c] >= VISIBLE_STRENGTH) visible++;
    }
    this.connectionCount = visible;

    // Con modo individual las conexiones restantes se apagan con el presupuesto de pareja.
    const budget = this.mode === GROUP_COLLECTIVE ? s.collectiveParticleBudget : s.pairParticleBudget;
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      this.particleBudget[c] = this.connectionIdA[c] < 0 ? 0 : Math.floor((budget * Math.min(1, this.strength[c])) / Math.max(1, live));
    }

    const targetEnergy = this.mode === GROUP_COLLECTIVE ? 1 : this.mode === GROUP_PAIR ? s.pairEnergy : 0;
    this.energy += (targetEnergy - this.energy) * expAlpha(dt, targetEnergy > this.energy ? s.energyAttackMs : s.energyReleaseMs);
  }

  /** Fuerza objetivo de una conexión según la distancia entre centros: nada lejos, plena cerca. */
  proximityStrength(distance: number, scale: number): number {
    const { near, far } = this.settings.connectionDistance;
    return 1 - smoothstep(near * scale, far * scale, distance);
  }

  reset(): void {
    this.mode = GROUP_SINGLE;
    this.pendingMode = GROUP_SINGLE;
    this.stableCount = 0;
    this.energy = 0;
    this.connectionCount = 0;
    this.trackId.fill(-1);
    for (let c = 0; c < MAX_CONNECTIONS; c++) this.freeConnection(c);
  }

  private updateTracks(people: GroupPeople, now: number): void {
    const s = this.settings;
    this.trackSeen.fill(0);
    const count = Math.min(people.peopleCount, MAX_GROUP_PEOPLE);
    for (let k = 0; k < count; k++) {
      const id = people.peopleId[k];
      let t = this.trackIndex(id);
      if (t < 0) {
        for (let free = 0; free < MAX_GROUP_PEOPLE; free++) {
          if (this.trackId[free] >= 0) continue;
          t = free;
          this.trackId[t] = id;
          this.trackFirst[t] = now;
          break;
        }
      }
      if (t < 0) continue;
      this.trackSeen[t] = 1;
      this.trackLast[t] = now;
      this.trackX[t] = people.peopleX[k];
      this.trackY[t] = people.peopleY[k];
      this.trackVx[t] = people.peopleVx[k];
      this.trackVy[t] = people.peopleVy[k];
    }
    for (let t = 0; t < MAX_GROUP_PEOPLE; t++) {
      if (this.trackId[t] < 0 || this.trackSeen[t] === 1) continue;
      // Ausente: conserva su última posición durante la gracia y deja de moverse.
      this.trackVx[t] = 0;
      this.trackVy[t] = 0;
      if (now - this.trackLast[t] > s.dropGraceMs) this.trackId[t] = -1;
    }
  }

  private updateMode(raw: number, now: number): void {
    if (raw === this.mode) {
      this.pendingMode = raw;
      return;
    }
    if (raw !== this.pendingMode) {
      this.pendingMode = raw;
      this.pendingSince = now;
    }
    const wait = raw > this.mode ? this.settings.enterMs : this.settings.exitMs;
    if (now - this.pendingSince >= wait) this.mode = raw;
  }

  private selectConnections(stable: number, scale: number): void {
    const s = this.settings;
    const { distance, stableTrack } = this;
    for (let i = 0; i < stable; i++) {
      for (let j = i + 1; j < stable; j++) {
        const ti = stableTrack[i];
        const tj = stableTrack[j];
        let d = Math.hypot(this.trackX[ti] - this.trackX[tj], this.trackY[ti] - this.trackY[tj]);
        if (this.findConnection(this.trackId[ti], this.trackId[tj]) >= 0) d *= s.selectionStickiness;
        distance[i * stable + j] = d;
        distance[j * stable + i] = d;
      }
    }
    const max = this.mode === GROUP_COLLECTIVE ? s.maxConnections : 1;
    const count = selectPairs(stable, distance, max, s.connectionDistance.far * scale, this.selectedA, this.selectedB);
    const level = this.mode === GROUP_COLLECTIVE ? s.collectiveStrength : s.pairStrength;

    for (let k = 0; k < count; k++) {
      const ta = stableTrack[this.selectedA[k]];
      const tb = stableTrack[this.selectedB[k]];
      let c = this.findConnection(this.trackId[ta], this.trackId[tb]);
      if (c < 0) c = this.allocateConnection(ta, tb);
      if (c < 0) continue;
      this.connectionSelected[c] = 1;
      const realDistance = Math.hypot(this.trackX[ta] - this.trackX[tb], this.trackY[ta] - this.trackY[tb]);
      this.targetStrength[c] = level * this.proximityStrength(realDistance, scale);
    }
  }

  private allocateConnection(ta: number, tb: number): number {
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      if (this.connectionIdA[c] >= 0) continue;
      this.connectionIdA[c] = this.trackId[ta];
      this.connectionIdB[c] = this.trackId[tb];
      this.ax[c] = this.trackX[ta];
      this.ay[c] = this.trackY[ta];
      this.bx[c] = this.trackX[tb];
      this.by[c] = this.trackY[tb];
      this.strength[c] = 0;
      this.relativeMotion[c] = 0;
      this.seed[c] = ((this.seedCounter++ * 0.618034) % 1) * 1000;
      return c;
    }
    return -1;
  }

  private freeConnection(c: number): void {
    this.connectionIdA[c] = -1;
    this.connectionIdB[c] = -1;
    this.strength[c] = 0;
    this.targetStrength[c] = 0;
    this.particleBudget[c] = 0;
  }

  private findConnection(idA: number, idB: number): number {
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      const a = this.connectionIdA[c];
      const b = this.connectionIdB[c];
      if ((a === idA && b === idB) || (a === idB && b === idA)) return c;
    }
    return -1;
  }

  private trackIndex(id: number): number {
    for (let t = 0; t < MAX_GROUP_PEOPLE; t++) if (this.trackId[t] === id) return t;
    return -1;
  }
}
