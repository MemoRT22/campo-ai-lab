import type { Config } from '../config';
import { TAU, clamp01, createRandom, lerp, screenScale, smoothstep } from '../utils/MathUtils';
import { FlowField } from './FlowField';
import { FormationTracker } from './FormationTracker';
import { MAX_CONNECTIONS, type GroupInteraction } from './GroupInteraction';
import { motionPhaseIndex, perFrameFactor, retargetFastBlend, speedFastBlend, trackingWeight } from './motionProfile';
import type { TargetField } from './TargetField';

const DORMANT = 0;
const AMBIENT = 1;
const BODY = 2;

export const RENDER_STRIDE = 4;

const FRAME_MS = 1000 / 60;
const BIN_SIZE = 64;
const MAX_WAVES = 6;
const GLOW_SMOOTHING_MS = 120;
/** Enlace mínimo para que una partícula del cuerpo pueda viajar al texto. */
const TEXT_MIN_BOND = 0.72;
const IDLE_FADE_IN_MS = 2600;
const POPULATION_INTERVAL_MS = 200;
const WRAP_MARGIN = 24;
/** Personas simultáneas que puede entregar TargetField. */
const PERSON_SLOTS = 8;
/** Offset visual (px de referencia) desde el que una partícula cuenta como estela o desprendida. */
const EFFECT_VISIBLE_PX = 0.75;
/** Fracción de la corriente en cada extremo donde las partículas aparecen y se desvanecen. */
const BRIDGE_END_FADE = 0.12;
/** Por debajo de esta amplitud (px CSS) el temblor no se percibe y no se calcula. */
const MIN_VISIBLE_NOISE_PX = 0.25;
/** Fuerza de conexión bajo la cual una partícula regresa al campo. */
const BRIDGE_RELEASE_STRENGTH = 0.01;
/** Márgenes de la corriente donde se permite reclutar (evita tomar partículas junto a los cuerpos). */
const BRIDGE_RECRUIT_MIN_T = 0.05;
const BRIDGE_RECRUIT_MAX_T = 0.95;

export interface TextFlightTiming {
  /** Momento en que empieza el viaje (puede esperar a la suspensión de la silueta). */
  startAt: number;
  travelMs: number;
  holdMs: number;
  returnMs: number;
}

type ParticleSettings = Config['particles'];

/**
 * Sistema de partículas en estructura de arreglos (typed arrays): sin objetos por partícula,
 * sin allocations por frame y con acceso secuencial a memoria.
 *
 * Cada partícula está en uno de tres modos:
 *   DORMANT  invisible, disponible en el pool.
 *   AMBIENT  flota en el campo; incluye partículas recién liberadas que aún se dispersan.
 *   BODY     ocupa una celda de una silueta y es atraída por un resorte hacia ella.
 *
 * `bond` (0..1) es la continuidad entre modos: sube al formar el cuerpo y baja al dispersarse.
 * Controla la fuerza del resorte y la mezcla visual entre partícula ambiental y corporal.
 */
export class ParticleSystem {
  readonly capacity: number;
  readonly renderData: Float32Array;
  renderCount = 0;
  bodyCount = 0;
  ambientCount = 0;
  /** Diagnóstico del último frame de visión. */
  transportedLastFrame = 0;
  formedLastFrame = 0;
  spawnedLastFrame = 0;
  releasedLastFrame = 0;
  heldLastFrame = 0;
  /** Partículas que ya dejaron el cuerpo pero aún conservan forma y momentum antes de desprenderse. */
  detachingCount = 0;
  /** Partículas que acompañaron una traslación rígida del cuerpo en el último frame de visión. */
  shiftedLastFrame = 0;
  averageTargetDistance = 0;
  estimatedTargetLagMs = 0;
  /** Partículas de cuerpo por fase en el último frame: formation, tracking, fast, departure. */
  readonly motionPhaseCounts = new Int32Array(4);
  /** LIVING BODY: núcleo espejo, microestela y desprendimiento de borde visibles en el último frame. */
  coreCount = 0;
  trailCount = 0;
  shedCount = 0;
  /** FORMATION WOW: progreso de la persona menos formada que aún no se fija (1 = todas fijas). */
  formationProgress = 1;
  /** GROUP MODE: partículas del campo que forman corrientes entre personas. */
  bridgeParticleCount = 0;
  readonly formation = new FormationTracker();

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly jitterX: Float32Array;
  private readonly jitterY: Float32Array;
  private readonly seed: Float32Array;
  private readonly phase: Float32Array;
  private readonly life: Float32Array;
  private readonly lifeTarget: Float32Array;
  private readonly fadeMs: Float32Array;
  private readonly bond: Float32Array;
  private readonly glow: Float32Array;
  private readonly proximity: Float32Array;
  private readonly excite: Float32Array;
  private readonly releasedAt: Float64Array;
  /** Momento en que una partícula liberada por departure se desprende; 0 si ya se desprendió. */
  private readonly detachAt: Float64Array;
  /** Track temporal al que pertenece una partícula BODY; -1 fuera del cuerpo. */
  private readonly particlePersonId: Int32Array;
  /** Inicio del resorte rápido tras un transporte BODY → BODY. */
  private readonly retargetedAt: Float64Array;
  private readonly cell: Int32Array;
  private readonly mode: Uint8Array;
  private readonly dormantStack: Int32Array;
  private readonly transportCandidates: Int32Array;
  /** 0 fuera de la traslación, 1 desplazada, 2 intentará conservar su celda anterior. */
  private readonly shiftState: Uint8Array;
  private readonly missingByPerson = new Int32Array(8);
  private readonly personFastBlend = new Float32Array(8);
  private readonly personInterpolationX = new Float32Array(8);
  private readonly personInterpolationY = new Float32Array(8);
  /** Índice de la partícula dentro del grupo que viaja al texto; -1 si no participa. */
  private readonly revealTarget: Int32Array;
  /** Posición de partida cuando un vuelo continúa desde el texto anterior (reveal → marca). */
  private readonly flightFrom: Float32Array;
  private readonly flightUsesFrom: Uint8Array;
  /** Offset visual (estela/desprendimiento) sobre la posición del núcleo; nunca altera el target. */
  private readonly offX: Float32Array;
  private readonly offY: Float32Array;
  private readonly offVx: Float32Array;
  private readonly offVy: Float32Array;
  /** Conexión de grupo a la que pertenece una partícula del campo; -1 si flota libre. */
  private readonly bridgeSlot: Int8Array;
  /** Posición (0..1) a lo largo de la corriente. */
  private readonly bridgeT: Float32Array;
  private dormantTop = 0;

  private readonly personRadius = new Float32Array(PERSON_SLOTS);
  private readonly personCells = new Int32Array(PERSON_SLOTS);
  private readonly personPhase = new Float32Array(PERSON_SLOTS);
  private readonly personAttraction = new Float32Array(PERSON_SLOTS);
  private readonly personCurl = new Float32Array(PERSON_SLOTS);
  private readonly personLockSpeed = new Float32Array(PERSON_SLOTS);
  private readonly personLockPulse = new Float32Array(PERSON_SLOTS);
  private readonly personBody = new Int32Array(PERSON_SLOTS);
  private readonly personFormed = new Int32Array(PERSON_SLOTS);

  private group: GroupInteraction | null = null;
  private readonly bridgeCount = new Int32Array(MAX_CONNECTIONS);
  private readonly bridgeNeed = new Int32Array(MAX_CONNECTIONS);
  private readonly bridgeStartX = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeStartY = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeDirX = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeDirY = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeSpan = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeBend = new Float32Array(MAX_CONNECTIONS);
  private readonly bridgeFlow = new Float32Array(MAX_CONNECTIONS);
  private recruitCursor = 0;
  private recruitSweep = 0;
  private bridgeSpawnAllowed = false;

  private resonanceX = 0;
  private resonanceY = 0;
  private resonanceStart = -Infinity;
  private resonanceSpawned = true;

  private field: TargetField | null = null;
  private fieldVersion = -1;
  private cellOwner = new Int32Array(0);

  private width = 1;
  private height = 1;
  private scale = 1;
  private binSize = BIN_SIZE;
  private binCols = 1;
  private binRows = 1;
  private binStart = new Int32Array(2);
  private binCursor = new Int32Array(1);
  private readonly binItems: Int32Array;

  private readonly flow = new FlowField();
  private readonly random = createRandom(0xa11ce);
  private lastPopulationAt = -Infinity;
  private populationCursor = 0;

  private readonly waveX = new Float32Array(MAX_WAVES);
  private readonly waveY = new Float32Array(MAX_WAVES);
  private readonly waveStart = new Float64Array(MAX_WAVES).fill(-Infinity);
  private readonly waveStrength = new Float32Array(MAX_WAVES);
  /** La onda se ancla a la persona que hizo el gesto: si camina, la onda la acompaña. */
  private readonly wavePersonId = new Int32Array(MAX_WAVES).fill(-1);
  private readonly waveOffsetX = new Float32Array(MAX_WAVES);
  private readonly waveOffsetY = new Float32Array(MAX_WAVES);
  private readonly waveOriginX = new Float32Array(MAX_WAVES);
  private readonly waveOriginY = new Float32Array(MAX_WAVES);
  private waveCursor = 0;
  private lastWaveAt = -Infinity;
  private celebrationStart = -Infinity;
  private celebrationDuration = 0;
  private celebrationStrength = 0;
  private revealTargets = new Float32Array(0);
  private revealTargetCount = 0;
  private flightActive = false;
  private flightStart = 0;
  private flightTravel = 1;
  private flightHold = 0;
  private flightReturn = 1;

  constructor(private readonly settings: ParticleSettings) {
    const n = settings.particleCount;
    this.capacity = n;
    this.renderData = new Float32Array(n * RENDER_STRIDE);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.jitterX = new Float32Array(n);
    this.jitterY = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.life = new Float32Array(n);
    this.lifeTarget = new Float32Array(n);
    this.fadeMs = new Float32Array(n).fill(IDLE_FADE_IN_MS);
    this.bond = new Float32Array(n);
    this.glow = new Float32Array(n);
    this.proximity = new Float32Array(n);
    this.excite = new Float32Array(n);
    this.releasedAt = new Float64Array(n);
    this.detachAt = new Float64Array(n);
    this.particlePersonId = new Int32Array(n).fill(-1);
    this.retargetedAt = new Float64Array(n).fill(-Infinity);
    this.cell = new Int32Array(n).fill(-1);
    this.mode = new Uint8Array(n);
    this.dormantStack = new Int32Array(n);
    this.transportCandidates = new Int32Array(n);
    this.shiftState = new Uint8Array(n);
    this.revealTarget = new Int32Array(n).fill(-1);
    this.flightFrom = new Float32Array(n * 2);
    this.flightUsesFrom = new Uint8Array(n);
    this.offX = new Float32Array(n);
    this.offY = new Float32Array(n);
    this.offVx = new Float32Array(n);
    this.offVy = new Float32Array(n);
    this.bridgeSlot = new Int8Array(n).fill(-1);
    this.bridgeT = new Float32Array(n);
    this.binItems = new Int32Array(n);

    const jitter = settings.cellJitter * 0.5;
    for (let i = 0; i < n; i++) {
      this.seed[i] = this.random();
      this.phase[i] = this.random() * TAU;
      this.jitterX[i] = (this.random() * 2 - 1) * jitter;
      this.jitterY[i] = (this.random() * 2 - 1) * jitter;
      this.dormantStack[this.dormantTop++] = n - 1 - i;
    }
  }

  get dormantCount(): number {
    return this.dormantTop;
  }

  /** Estado social que dibujan las partículas del campo entre personas. */
  setGroup(group: GroupInteraction | null): void {
    this.group = group;
  }

  /**
   * Dos ondas de mano de personas distintas se encuentran en (x, y) tras `delayMs`: brillo breve,
   * dispersión controlada y un pulso pequeño de partículas del campo. Los cuerpos no se tocan.
   */
  resonate(x: number, y: number, delayMs: number, now: number): void {
    this.resonanceX = x;
    this.resonanceY = y;
    this.resonanceStart = now + Math.max(0, delayMs);
    this.resonanceSpawned = false;
  }

  /** Puntos tipográficos absolutos (px CSS) hacia los que viaja el grupo de partículas del texto. */
  setRevealTargets(targets: Float32Array): void {
    this.revealTargets = new Float32Array(targets);
    this.revealTargetCount = targets.length / 2;
  }

  /** Momento en que la silueta termina de expandirse y suspenderse tras BOTH_HANDS_UP. */
  get celebrationPeakAt(): number {
    return this.celebrationStart + this.settings.revealExpandMs + this.settings.revealSuspendMs;
  }

  /**
   * Una fracción del cuerpo viaja a un texto y regresa. Las partículas conservan su celda: el
   * tracking nunca se detiene y la persona puede seguir moviéndose. Si ya estaban sobre un texto
   * (reveal), viajan directamente al nuevo (marca) sin volver primero al cuerpo.
   */
  startTextFlight(targets: Float32Array, now: number, timing: TextFlightTiming): void {
    const continuing = this.flightActive && this.flightBlendAt(now) > 0.3;
    this.setRevealTargets(targets);
    let selected = 0;
    for (let p = 0; p < this.capacity; p++) if (this.mode[p] === BODY && this.revealTarget[p] >= 0) selected++;
    if (selected === 0) this.selectTextParticles();
    for (let p = 0; p < this.capacity; p++) {
      const from = continuing && this.revealTarget[p] >= 0 ? 1 : 0;
      this.flightUsesFrom[p] = from;
      if (from) {
        this.flightFrom[p * 2] = this.px[p];
        this.flightFrom[p * 2 + 1] = this.py[p];
      }
    }
    this.flightActive = targets.length > 0;
    this.flightStart = timing.startAt;
    this.flightTravel = Math.max(1, timing.travelMs);
    this.flightHold = Math.max(0, timing.holdMs);
    this.flightReturn = Math.max(1, timing.returnMs);
  }

  resize(width: number, height: number): void {
    const sx = width / this.width;
    const sy = height / this.height;
    for (let i = 0; i < this.capacity; i++) {
      this.px[i] *= sx;
      this.py[i] *= sy;
    }
    this.width = width;
    this.height = height;
    this.scale = screenScale(width, height);
    this.flow.resize(width, height);

    this.binSize = BIN_SIZE * this.scale;
    this.binCols = Math.max(1, Math.ceil(width / this.binSize));
    this.binRows = Math.max(1, Math.ceil(height / this.binSize));
    this.binStart = new Int32Array(this.binCols * this.binRows + 1);
    this.binCursor = new Int32Array(this.binCols * this.binRows);
  }

  /**
   * Aplica un nuevo estado de siluetas.
   *
   * Primero conserva propietarios válidos y transporta BODY → BODY dentro del mismo track.
   * Sólo después usa el pool ambiental para formación y libera candidatos sin destino.
   */
  applyTargets(field: TargetField, now: number): void {
    this.field = field;
    if (field.version !== this.fieldVersion) this.rebuildOwnership(field, now);
    this.formation.sync(field.peopleId, field.peopleCount, now);

    this.transportedLastFrame = 0;
    this.formedLastFrame = 0;
    this.spawnedLastFrame = 0;
    this.releasedLastFrame = 0;
    this.heldLastFrame = 0;
    this.shiftedLastFrame = this.shiftOwnership(field, now);

    const { mode, cell, life, cellOwner, capacity, particlePersonId, transportCandidates } = this;
    const { active, cellPersonId } = field;
    let candidateCount = 0;

    // Una celda sólo se conserva si sigue activa para el mismo track temporal. Los demás
    // BODY permanecen intactos mientras buscamos destino: todavía no son ambiente.
    for (let p = 0; p < capacity; p++) {
      if (mode[p] !== BODY) continue;
      const c = cell[p];
      if (c >= 0 && active[c] === 1 && cellPersonId[c] === particlePersonId[p] && cellOwner[c] === p) continue;
      // Una omisión aislada del segmentador no equivale a departure. Conservamos el
      // target anterior durante una ventana corta; clear() elimina el track y no pasa aquí.
      if (c >= 0 && active[c] === 0 && field.personIndex(particlePersonId[p]) < 0 && field.trackAge(particlePersonId[p], now) <= this.settings.occlusionGraceMs) {
        this.heldLastFrame++;
        continue;
      }
      if (c >= 0) cellOwner[c] = -1;
      transportCandidates[candidateCount++] = p;
    }

    const { missingByPerson, personRadius, personCells } = this;
    missingByPerson.fill(0);
    personRadius.fill(0);
    personCells.fill(0);
    const { activeList, activeCount, cellX, cellY } = field;
    for (let k = 0; k < activeCount; k++) {
      const c = activeList[k];
      const personIndex = field.personIndex(cellPersonId[c]);
      if (personIndex < 0) continue;
      personRadius[personIndex] += Math.hypot(cellX[c] - field.peopleX[personIndex], cellY[c] - field.peopleY[personIndex]);
      personCells[personIndex]++;
      if (cellOwner[c] < 0) missingByPerson[personIndex]++;
    }
    // Dos veces la distancia media al centro ≈ extensión del cuerpo: base del stagger radial.
    for (let k = 0; k < field.peopleCount; k++) personRadius[k] = personCells[k] > 0 ? (2 * personRadius[k]) / personCells[k] : 1;

    // Transporte intra-persona. Sólo cambia el target: posición, velocidad, bond, life,
    // glow y momentum permanecen exactamente como estaban.
    for (let i = 0; i < candidateCount; i++) {
      const p = transportCandidates[i];
      const personIndex = field.personIndex(particlePersonId[p]);
      if (personIndex < 0 || missingByPerson[personIndex] === 0) continue;
      const oldCell = cell[p];
      const expectedX = (oldCell >= 0 ? cellX[oldCell] : this.px[p]) + field.peopleDx[personIndex];
      const expectedY = (oldCell >= 0 ? cellY[oldCell] : this.py[p]) + field.peopleDy[personIndex];
      const target = this.findTransportTarget(field, particlePersonId[p], expectedX, expectedY);
      if (target < 0) continue;

      cell[p] = target;
      cellOwner[target] = p;
      this.lifeTarget[p] = 1;
      this.retargetedAt[p] = now;
      missingByPerson[personIndex]--;
      transportCandidates[i] = -1;
      this.transportedLastFrame++;
    }

    // Índice espacial de partículas que ya eran libres (counting sort por bins). Los
    // BODY sin target se liberan al final para impedir intercambios entre personas cercanas.
    const { binCursor, binStart, binItems } = this;
    const binCount = binCursor;
    binCount.fill(0);
    for (let p = 0; p < capacity; p++) {
      if (mode[p] === AMBIENT && life[p] > 0.02) binCount[this.binOf(this.px[p], this.py[p])]++;
    }
    binStart[0] = 0;
    for (let b = 0; b < binCount.length; b++) {
      binStart[b + 1] = binStart[b] + binCount[b];
      binCursor[b] = binStart[b];
    }
    for (let p = 0; p < capacity; p++) {
      if (mode[p] === AMBIENT && life[p] > 0.02) binItems[binCursor[this.binOf(this.px[p], this.py[p])]++] = p;
    }
    for (let b = 0; b < binCount.length; b++) binCursor[b] = binStart[b];

    for (let k = 0; k < activeCount; k++) {
      const c = activeList[k];
      if (cellOwner[c] >= 0) continue;

      let p = this.takeFree(cellX[c], cellY[c]);
      let spawned = false;
      if (p >= 0) {
        this.bridgeSlot[p] = -1;
        if (this.bond[p] < 0.05) this.bond[p] = -this.formationDelay(field, c);
      } else if (this.dormantTop > 0) {
        p = this.dormantStack[--this.dormantTop];
        this.spawnNear(p, cellX[c], cellY[c]);
        this.bond[p] = -this.formationDelay(field, c);
        spawned = true;
      } else {
        continue;
      }

      mode[p] = BODY;
      cell[p] = c;
      cellOwner[c] = p;
      this.detachAt[p] = 0;
      particlePersonId[p] = cellPersonId[c];
      this.retargetedAt[p] = -Infinity;
      this.lifeTarget[p] = 1;
      this.formedLastFrame++;
      if (spawned) this.spawnedLastFrame++;
    }

    for (let i = 0; i < candidateCount; i++) {
      const p = transportCandidates[i];
      if (p >= 0) {
        // Si la persona sigue presente es un borde que cambió: se desprende de inmediato.
        // Si su track desapareció es departure: se disuelve de forma escalonada.
        const departing = field.personIndex(particlePersonId[p]) < 0;
        this.release(p, now, departing ? this.settings.departureStaggerMs * ((this.seed[p] * 5.17) % 1) : 0);
        this.releasedLastFrame++;
      }
    }
  }

  step(dtSeconds: number, now: number): void {
    const s = this.settings;
    const fw = s.formationWow;
    const lb = s.livingBody;
    const gi = s.groupInteraction;
    const dtMs = dtSeconds * 1000;
    const frames = dtMs / FRAME_MS;
    const substeps = frames > 1.5 ? Math.ceil(frames / 1.25) : 1;
    const h = frames / substeps;

    this.flow.update(now);
    const flow = this.flow;
    const field = this.field;
    const { px, py, vx, vy, bond, life, lifeTarget, fadeMs, mode, cell, excite, glow, proximity, seed, phase, jitterX, jitterY, releasedAt, retargetedAt, particlePersonId } = this;
    const { offX, offY, offVx, offVy, bridgeSlot, bridgeT, bridgeCount } = this;
    const renderData = this.renderData;

    const scale = this.scale;
    const spacing = field ? field.spacing : s.particleSpacing * scale;
    const cellX = field?.cellX;
    const cellY = field?.cellY;
    const cellProximity = field?.cellProximity;
    const cellEdge = field?.cellEdge;
    const peopleCount = field ? field.peopleCount : 0;
    const pendingCount = field ? field.pendingCount : 0;

    const bodyDamping = Math.pow(s.particleDamping, h);
    const trackingDamping = Math.pow(s.trackingDamping, h);
    const fastDamping = Math.pow(s.fastMotionDamping, h);
    const ambientDamping = Math.pow(s.ambientDamping, h);
    const bridgeDamping = Math.pow(gi.damping, h);
    const trackingSnap = perFrameFactor(s.trackingSnap, h);
    const fastSnap = perFrameFactor(s.fastMotionSnap, h);
    const trackingMaxSpeed = s.maxSpeed * scale;
    const formationMaxSpeed = s.formationMaxSpeed * scale;
    const bridgeMaxSpeed = gi.maxSpeed * scale;
    this.motionPhaseCounts.fill(0);

    const formation = this.formation;
    const { personPhase, personAttraction, personLockSpeed, personLockPulse, personBody, personFormed } = this;
    personBody.fill(0);
    personFormed.fill(0);
    if (field) {
      // Entre frames de visión (30 Hz) el target avanza con la traslación estable del track:
      // evita que las partículas avancen a escalones sin extrapolar más de un intervalo.
      // La ventana cubre el hueco real entre frames de visión: si la cámara va a 8 fps, el target
      // sigue avanzando esos 125 ms en vez de congelarse tras los primeros 40.
      const window = s.interpolationMaxMs > 0 ? Math.max(s.interpolationMaxMs, field.visionIntervalMs * s.interpolationIntervalFactor) : 0;
      const sinceVision = Math.min(Math.max(0, now - field.lastVisionAt), window);
      const maxInterpolation = s.interpolationMaxDistance * scale;
      for (let k = 0; k < field.peopleCount; k++) {
        this.personFastBlend[k] = speedFastBlend(field.peopleSpeed[k], s, scale);
        let ix = field.peopleInterpolationVx[k] * sinceVision;
        let iy = field.peopleInterpolationVy[k] * sinceVision;
        const distance = Math.hypot(ix, iy);
        if (distance > maxInterpolation) {
          ix *= maxInterpolation / distance;
          iy *= maxInterpolation / distance;
        }
        this.personInterpolationX[k] = ix;
        this.personInterpolationY[k] = iy;

        // FORMATION WOW por persona: ventana de formación → presencia magnética; lock → perfil espejo.
        const age = formation.ageOf(k, now);
        const formationPhase = age < s.formationAttractionWindowMs
          ? 1
          : Math.max(0, 1 - (age - s.formationAttractionWindowMs) / s.formationAttractionFadeMs);
        personPhase[k] = formationPhase;
        personAttraction[k] = s.ambientAttraction * Math.max(s.magneticResidualAttraction, formationPhase) * lerp(1, fw.anticipationBoost, formationPhase);
        personLockSpeed[k] = formation.isLocked(k) ? fw.lockSpeedup : 1;
        const lockAge = now - formation.lockedAtOf(k);
        // El giro sólo existe mientras el campo converge: tras el lock se apaga y no deja órbitas.
        this.personCurl[k] = fw.anticipationCurl * formationPhase * (formation.lockedAtOf(k) >= 0 ? 1 - smoothstep(0, fw.curlReleaseMs, lockAge) : 1);
        const pulseRise = fw.lockGlowMs * 0.25;
        personLockPulse[k] = formation.lockedAtOf(k) >= 0 && lockAge < fw.lockGlowMs
          ? fw.lockGlow * smoothstep(0, pulseRise, lockAge) * (1 - smoothstep(pulseRise, fw.lockGlowMs, lockAge))
          : 0;
      }
    }
    const noiseAmplitude = s.particleNoise * scale;
    const formationStep = dtMs / s.formationDuration;
    const staggerSpan = s.formationStagger;
    const dispersionStep = dtMs / s.dispersionDuration;
    const formationFadeMs = s.formationDuration * 0.6;
    const fadeDelayMs = s.dispersionDuration * 0.2;
    const exciteDecay = Math.exp(-dtMs / s.gestureExciteDecayMs);
    const glowAlpha = 1 - Math.exp(-dtMs / GLOW_SMOOTHING_MS);
    const time = now * 0.001;
    const waveLifetime = s.waveMaxRadius / s.waveSpeed;
    const wavesActive = now - this.lastWaveAt < waveLifetime;
    const waveSpeed = s.waveSpeed * scale;
    const waveWidth = s.waveWidth * scale;
    const waveGlowRadius = s.waveGlowRadius * scale;
    if (wavesActive) {
      for (let w = 0; w < MAX_WAVES; w++) {
        const k = field && this.wavePersonId[w] >= 0 ? field.personIndex(this.wavePersonId[w]) : -1;
        this.waveOriginX[w] = k >= 0 && field ? field.peopleX[k] + this.waveOffsetX[w] : this.waveX[w];
        this.waveOriginY[w] = k >= 0 && field ? field.peopleY[k] + this.waveOffsetY[w] : this.waveY[w];
      }
    }

    // LIVING BODY: el offset visual regresa al núcleo en ~3 constantes de tiempo.
    const trailDecay = Math.exp(-dtMs / Math.max(1, lb.trailDurationMs / 3));
    const shedDecay = Math.exp(-dtMs / Math.max(1, lb.shedDurationMs / 3));
    const shedVelocityDecay = Math.exp(-dtMs / Math.max(1, lb.shedDurationMs / 4));
    const trailMax = lb.trailMaxDistance * scale;
    const shedMax = lb.shedMaxDistance * scale;
    const effectSpeedStart = lb.trailSpeed.start * scale;
    const effectSpeedFull = lb.trailSpeed.full * scale;
    const effectVisible = EFFECT_VISIBLE_PX * scale;
    let trailCount = 0;
    let shedCount = 0;

    // GROUP MODE: geometría de cada corriente una vez por frame.
    const group = gi.enabled ? this.group : null;
    const groupEnergy = group ? group.energy : 0;
    if (group) this.prepareBridges(group, time);
    bridgeCount.fill(0);
    const bridgeWidth = gi.width * scale;
    const nodeRadius = gi.nodeRadius * scale;
    const ambientDriftBoost = 1 + gi.collectiveAmbientDrift * groupEnergy;
    const twinkleAmount = Math.min(1, s.idleTwinkle * (1 + gi.collectiveTwinkle * groupEnergy));

    // Ondas de dos personas que se encuentran.
    const resonanceAge = now - this.resonanceStart;
    const resonanceActive = resonanceAge >= 0 && resonanceAge < gi.resonanceDurationMs;
    const resonanceRadius = gi.resonanceRadius * scale;
    let resonanceEnvelope = 0;
    if (resonanceActive) {
      const rise = gi.resonanceDurationMs * 0.2;
      resonanceEnvelope = smoothstep(0, rise, resonanceAge) * (1 - smoothstep(rise, gi.resonanceDurationMs, resonanceAge));
      if (!this.resonanceSpawned) {
        this.resonanceSpawned = true;
        this.spawnResonancePulse(now);
      }
    }

    // BOTH_HANDS_UP: expansión → suspensión → recuperación de la silueta.
    const celebrationAge = now - this.celebrationStart;
    const suspendEnd = s.revealExpandMs + s.revealSuspendMs;
    let celebrationEnvelope = 0;
    if (celebrationAge >= 0 && celebrationAge < this.celebrationDuration) {
      if (celebrationAge < s.revealExpandMs) celebrationEnvelope = smoothstep(0, s.revealExpandMs, celebrationAge);
      else if (celebrationAge < suspendEnd) celebrationEnvelope = 1;
      else celebrationEnvelope = 1 - smoothstep(suspendEnd, Math.max(suspendEnd + 1, this.celebrationDuration), celebrationAge);
    }

    // Vuelo al texto: `flightBlend` sube al viajar, se mantiene y baja al regresar.
    let flightBlend = 0;
    let flightTravelEase = 0;
    let flightReturning = false;
    if (this.flightActive) {
      const t = now - this.flightStart;
      if (t >= this.flightTravel + this.flightHold + this.flightReturn) {
        this.flightActive = false;
        this.revealTarget.fill(-1);
      } else if (t >= 0) {
        flightBlend = this.flightBlendAt(now);
        flightTravelEase = smoothstep(0, this.flightTravel, t);
        flightReturning = t >= this.flightTravel + this.flightHold;
      }
    }

    const attractionRadiusSq = (s.formationAttractionRadius * scale) ** 2;
    const innerRadius = s.formationAttractionInnerRadius * scale;
    const magneticRadiusSq = (s.magneticRadius * scale) ** 2;
    const pendingAttraction = s.ambientAttraction * fw.pendingAttraction;
    const { idleDepth } = s;
    const cohesionRadiusSq = (s.ambientCohesionRadius * scale) ** 2;
    let detaching = 0;

    const { idle: sizeIdle, far: sizeFar, close: sizeClose } = s.particleSize;
    const { idle: opacityIdle, far: opacityFar, close: opacityClose } = s.particleOpacity;

    let out = 0;
    let bodyCount = 0;
    let ambientVisible = 0;
    let targetDistanceTotal = 0;
    let targetDistanceSamples = 0;

    for (let p = 0; p < this.capacity; p++) {
      const m = mode[p];
      if (m === DORMANT) continue;

      let l = life[p];
      const lt = lifeTarget[p];
      if (l < lt) l = Math.min(lt, l + dtMs / (m === BODY ? formationFadeMs : fadeMs[p]));
      else if (l > lt && now - releasedAt[p] > fadeDelayMs && this.detachAt[p] === 0) l = Math.max(lt, l - dtMs / fadeMs[p]);
      life[p] = l;
      if (m === AMBIENT && lt === 0 && l <= 0) {
        this.makeDormant(p);
        continue;
      }

      let x = px[p];
      let y = py[p];
      let velX = vx[p];
      let velY = vy[p];
      let b = bond[p];
      let e = excite[p] * exciteDecay;
      const sd = seed[p];
      let anticipation = 0;
      let textDetach = 0;
      let renderX = 0;
      let renderY = 0;
      /** Multiplicador visual de brillo: formación, lock, estela y corrientes. */
      let visualAlpha = 1;
      let visualSize = 1;

      if (m === BODY && cellX && cellY && cellProximity && cellEdge) {
        bodyCount++;
        const c = cell[p];
        const personIndex = field ? field.personIndex(particlePersonId[p]) : -1;
        if (b < 1) b = Math.min(1, b + formationStep * (personIndex >= 0 ? personLockSpeed[personIndex] : 1));
        const bc = b < 0 ? 0 : b;
        const ease = bc * bc * (3 - 2 * bc);
        const formed = trackingWeight(bc, s);
        // 0 al ser asignada, 1 cuando le toca colapsar: mientras espera ya se curva hacia el cuerpo.
        const waiting = b >= 0 || staggerSpan <= 0 ? 1 : clamp01(1 + b / staggerSpan);
        // El borde se apoya sobre el contorno subpíxel; sólo el interior conserva su desorden.
        const edge = cellEdge[c] === 1;
        if (edge) visualSize *= s.silhouette.edgeSize;
        const cellJitter = edge ? 0 : spacing;
        let tx = cellX[c] + (field ? field.cellOffsetX[c] : 0) + jitterX[p] * cellJitter;
        let ty = cellY[c] + (field ? field.cellOffsetY[c] : 0) + jitterY[p] * cellJitter;
        let fast = 0;
        let letGo = 0;
        if (field && personIndex < 0) {
          // Omisión corta de segmentación: la partícula suelta el target y conserva su momentum
          // en vez de congelarse. Si el track vuelve, recupera el seguimiento en pocos frames.
          letGo = smoothstep(0, s.departureLetGoMs, field.trackAge(particlePersonId[p], now));
        }
        if (field && personIndex >= 0) {
          personBody[personIndex]++;
          if (formed >= 0.5) personFormed[personIndex]++;
          visualAlpha += personLockPulse[personIndex];
          // Predicción e interpolación desplazan el target, nunca la posición de la partícula.
          // `ease` impide que alteren la entrada cinematográfica de una persona nueva.
          tx += (field.peoplePredictionX[personIndex] + this.personInterpolationX[personIndex]) * ease;
          ty += (field.peoplePredictionY[personIndex] + this.personInterpolationY[personIndex]) * ease;
          fast = this.personFastBlend[personIndex];
          if (celebrationEnvelope > 0) {
            const dx = cellX[c] - field.peopleX[personIndex];
            const dy = cellY[c] - field.peopleY[personIndex];
            const distance = Math.hypot(dx, dy) + 0.001;
            const strength = Math.min(1.3, 0.5 + this.celebrationStrength * 0.2);
            const expansion = s.revealExpansion * scale * celebrationEnvelope * ease * strength * (0.72 + sd * 0.28);
            tx += (dx / distance) * expansion;
            ty += (dy / distance) * expansion;
            e = Math.max(e, celebrationEnvelope * (0.32 + sd * 0.18));
          }
        }
        const revealIndex = this.revealTarget[p];
        if (flightBlend > 0 && revealIndex >= 0 && this.revealTargetCount > 0) {
          const targetOffset = (revealIndex % this.revealTargetCount) * 2;
          let toX = this.revealTargets[targetOffset];
          let toY = this.revealTargets[targetOffset + 1];
          if (this.flightUsesFrom[p] === 1) {
            toX = lerp(this.flightFrom[p * 2], toX, flightTravelEase);
            toY = lerp(this.flightFrom[p * 2 + 1], toY, flightTravelEase);
            textDetach = flightReturning ? flightBlend : 1;
          } else {
            textDetach = flightBlend;
          }
          tx = lerp(tx, toX, textDetach);
          ty = lerp(ty, toY, textDetach);
          e = Math.max(e, textDetach * s.textParticleGlow);
        }

        // Mientras el enlace es débil la partícula todavía "nada" en el campo y se curva al llegar.
        const swirl = (1 - ease) * s.ambientDrift * 6;
        // Un cuerpo formado no usa el flujo: se evita muestrearlo en miles de partículas.
        if (swirl > 0) flow.sample(x, y);
        else flow.sampleX = flow.sampleY = 0;
        fast = Math.max(fast, retargetFastBlend(now - retargetedAt[p], s));
        const suspension = 1 - celebrationEnvelope * s.revealSuspension;

        // INITIAL FORMATION y NORMAL/FAST TRACKING se mezclan por `formed`; DEPARTURE por `letGo`.
        const formationK = s.particleAttraction * ease + fw.waitingAttraction * (1 - ease) * waiting;
        const formationDamping = ambientDamping + (bodyDamping - ambientDamping) * ease;
        const trackK = lerp(s.trackingAttraction, s.fastMotionAttraction, fast);
        const trackDamping = lerp(trackingDamping, fastDamping, fast);
        // Las partículas que viajan al texto planean con un resorte suave; al volver recuperan el tracking.
        const k = lerp(lerp(formationK, trackK, formed) * suspension * (1 - letGo), s.textTravelAttraction, textDetach);
        const damping = lerp(lerp(lerp(formationDamping, trackDamping, formed), ambientDamping, letGo), bodyDamping, textDetach);
        const snap = lerp(trackingSnap, fastSnap, fast) * formed * (1 - letGo) * (1 - textDetach) *
          (1 - Math.min(1, e * s.gestureSnapRelief)) * suspension;
        // COLLAPSE: giro perpendicular al target que desaparece al fijarse (llegan en arco).
        const curl = formationK * fw.collapseCurl * (1 - ease) * (1 - formed) * (1 - letGo) * (1 - textDetach) *
          (sd < fw.anticipationSwirlBias ? 1 : -1);
        const maxSpeed = lerp(formationMaxSpeed, trackingMaxSpeed, formed);
        const maxSpeedSq = maxSpeed * maxSpeed;
        this.motionPhaseCounts[motionPhaseIndex(formed, fast, letGo > 0)]++;

        for (let i = 0; i < substeps; i++) {
          const ex = tx - x;
          const ey = ty - y;
          velX = (velX + (ex * k - ey * curl + flow.sampleX * swirl) * h) * damping;
          velY = (velY + (ey * k + ex * curl + flow.sampleY * swirl) * h) * damping;
          const speedSq = velX * velX + velY * velY;
          if (speedSq > maxSpeedSq) {
            const f = maxSpeed / Math.sqrt(speedSq);
            velX *= f;
            velY *= f;
          }
          x += velX * h;
          y += velY * h;
          if (snap > 0) {
            x += (tx - x) * snap;
            y += (ty - y) * snap;
          }
        }
        if (textDetach === 0) {
          targetDistanceTotal += Math.hypot(tx - x, ty - y);
          targetDistanceSamples++;
        }
        anticipation = (1 - ease) * waiting;
        visualAlpha += fw.collapseGlow * 4 * ease * (1 - ease) * (1 - formed);

        // LIVING BODY — offset visual encima del núcleo: microestela y desprendimiento de borde.
        const trailClass = (sd * 9.73) % 1 < (edge ? lb.trailRatioEdge : lb.trailRatioInterior);
        const shedClass = edge && (sd * 5.31) % 1 < lb.shedRatio;
        let ox = offX[p];
        let oy = offY[p];
        if (trailClass || shedClass || ox !== 0 || oy !== 0) {
          let ovx = offVx[p];
          let ovy = offVy[p];
          const moveX = x - px[p];
          const moveY = y - py[p];
          const move = Math.sqrt(moveX * moveX + moveY * moveY);
          const localSpeed = dtMs > 0 ? (move / dtMs) * 1000 : 0;
          const gain = trailClass || shedClass
            ? smoothstep(effectSpeedStart, effectSpeedFull, localSpeed) * formed * (1 - letGo) * (1 - textDetach) * (1 - celebrationEnvelope)
            : 0;
          if (gain > 0) {
            // Inercia: la partícula conserva parte de su posición en el mundo y queda atrás un instante.
            ox -= moveX * lb.trailInertia * gain;
            oy -= moveY * lb.trailInertia * gain;
            if (shedClass && move > 0) {
              const side = (sd < 0.5 ? -1 : 1) * (0.55 + 0.45 * Math.sin(time * 2.3 + phase[p]));
              const push = lb.shedForce * scale * gain * frames * side;
              ovx -= (moveY / move) * push;
              ovy += (moveX / move) * push;
            }
          }
          ovx *= shedVelocityDecay;
          ovy *= shedVelocityDecay;
          ox = (ox + ovx * frames) * (shedClass ? shedDecay : trailDecay);
          oy = (oy + ovy * frames) * (shedClass ? shedDecay : trailDecay);
          let offset = Math.sqrt(ox * ox + oy * oy);
          const maxOffset = shedClass ? shedMax : trailMax;
          if (offset > maxOffset) {
            const f = maxOffset / offset;
            ox *= f;
            oy *= f;
            ovx *= f;
            ovy *= f;
            offset = maxOffset;
          }
          if (offset < 0.01 && Math.abs(ovx) + Math.abs(ovy) < 0.001) {
            ox = 0;
            oy = 0;
            ovx = 0;
            ovy = 0;
          } else if (offset > effectVisible) {
            if (shedClass) shedCount++;
            else trailCount++;
            visualAlpha *= lerp(1, lb.effectAlpha, Math.min(1, offset / trailMax));
          }
          offVx[p] = ovx;
          offVy[p] = ovy;
          offX[p] = ox;
          offY[p] = oy;
        }
        // Quieto: el interior apenas tiembla y el borde flota lento. Sólo visual.
        const noise = noiseAmplitude * (edge ? lb.edgeFloat : lb.interiorNoise);
        renderX = x + ox;
        renderY = y + oy;
        if (noise >= MIN_VISIBLE_NOISE_PX) {
          const noiseRate = edge ? lb.edgeFloatSpeed : 1;
          renderX += noise * Math.sin(time * (0.9 + sd * 0.8) * noiseRate + phase[p]);
          renderY += noise * Math.cos(time * (0.7 + sd * 0.9) * noiseRate + phase[p] * 1.7);
        }

        const prox = cellProximity[c];
        const glowTarget = lerp(opacityFar, opacityClose, prox) * (edge ? s.edgeBrightness : 1);
        glow[p] += (glowTarget - glow[p]) * glowAlpha;
        proximity[p] += (prox - proximity[p]) * glowAlpha;
      } else {
        if (lt === 1 && bridgeSlot[p] < 0) ambientVisible++;
        const detachTime = this.detachAt[p];
        if (detachTime > 0 && now >= detachTime) this.detach(p, now);
        const cohesive = this.detachAt[p] > 0;

        let ax = 0;
        let ay = 0;
        let damping = ambientDamping;
        let speedLimit = 0;
        if (cohesive) {
          // DEPARTURE: todavía con la forma del cuerpo; sólo conserva su momentum.
          detaching++;
          damping = Math.pow(s.departureCohesionDamping, h);
        } else {
          if (b > 0) b = Math.max(0, b - dispersionStep);
          else if (b < 0) b = 0;

          const sinceRelease = now - releasedAt[p];
          const dispersing = releasedAt[p] > 0 && sinceRelease < s.dispersionDuration ? 1 - sinceRelease / s.dispersionDuration : 0;
          flow.sample(x, y);

          let slot = bridgeSlot[p];
          if (slot >= 0 && (!group || group.strength[slot] < BRIDGE_RELEASE_STRENGTH || this.bridgeSpan[slot] <= 0 || lt === 0)) {
            // La conexión se apagó: la partícula vuelve al campo sin salto de brillo.
            bridgeSlot[p] = -1;
            fadeMs[p] = IDLE_FADE_IN_MS;
            slot = -1;
          }

          if (slot >= 0 && group) {
            // GROUP MODE: la partícula fluye por una corriente curva entre dos personas.
            const strength = group.strength[slot];
            const lane = ((sd * 7.13) % 1) * 2 - 1;
            const isNode = (sd * 3.37) % 1 < gi.nodeRatio * groupEnergy;
            let t = bridgeT[p] + (lane >= 0 ? 1 : -1) * this.bridgeFlow[slot] * dtMs * 0.001;
            if (t > 1 || t < 0) {
              t = t > 1 ? t - 1 : t + 1;
              if (bridgeCount[slot] >= group.particleBudget[slot]) {
                // Sobra presupuesto: sale de la corriente donde es invisible.
                bridgeSlot[p] = -1;
                fadeMs[p] = IDLE_FADE_IN_MS;
                slot = -1;
              }
              if (!isNode) {
                l = 0;
                life[p] = 0;
              }
            }
            bridgeT[p] = t;
            if (slot >= 0) {
              bridgeCount[slot]++;
              const span = this.bridgeSpan[slot];
              const dirX = this.bridgeDirX[slot];
              const dirY = this.bridgeDirY[slot];
              let targetX: number;
              let targetY: number;
              let endFade = 1;
              if (isNode) {
                const bend = this.bridgeBend[slot];
                const angle = phase[p] + time * gi.nodeSpin * (lane >= 0 ? 1 : -1);
                const radius = nodeRadius * (0.35 + 0.65 * Math.abs(lane));
                targetX = this.bridgeStartX[slot] + dirX * span * 0.5 - dirY * bend + Math.cos(angle) * radius;
                targetY = this.bridgeStartY[slot] + dirY * span * 0.5 + dirX * bend + Math.sin(angle) * radius;
              } else {
                const profile = Math.sin(Math.PI * t);
                const normal = this.bridgeBend[slot] * profile + lane * bridgeWidth * (0.35 + 0.65 * profile);
                targetX = this.bridgeStartX[slot] + dirX * span * t - dirY * normal;
                targetY = this.bridgeStartY[slot] + dirY * span * t + dirX * normal;
                endFade = smoothstep(0, BRIDGE_END_FADE, t) * smoothstep(0, BRIDGE_END_FADE, 1 - t);
                if (l === 0) {
                  // Reaparece en su extremo: invisible, sin cruzar la pantalla.
                  x = targetX;
                  y = targetY;
                  velX = 0;
                  velY = 0;
                }
              }
              const drift = s.ambientDrift * scale * 2;
              ax = (targetX - x) * gi.attraction * strength + flow.sampleX * drift;
              ay = (targetY - y) * gi.attraction * strength + flow.sampleY * drift;
              damping = bridgeDamping;
              speedLimit = bridgeMaxSpeed;
              visualAlpha = lerp(1, gi.alpha * endFade, strength);
              visualSize = lerp(1, gi.size, strength);
            }
          }

          if (slot < 0) {
            const drift = s.ambientDrift * scale * lerp(idleDepth.driftFar, idleDepth.driftNear, sd) * (1 + dispersing * 5) * ambientDriftBoost;
            ax = flow.sampleX * drift + (this.random() - 0.5) * s.ambientBrownian * scale;
            ay = flow.sampleY * drift + (this.random() - 0.5) * s.ambientBrownian * scale;

            if (peopleCount === 0 && dispersing < 0.1) {
              // Tres pozos muy lentos comparten el mismo campo de flujo. Dan respiración y
              // profundidad al idle sin vecinos por partícula ni coste cuadrático.
              const layer = Math.min(2, (sd * 3) | 0);
              const anchorX = this.width * (0.22 + layer * 0.28 + Math.sin(time * s.idleWellSpeed + layer * 2.1) * s.idleWellWander);
              const anchorY = this.height * (0.38 + (layer & 1) * 0.23 + Math.cos(time * s.idleWellSpeed * 0.83 + layer * 1.7) * s.idleWellWander * 1.25);
              const dx = anchorX - x;
              const dy = anchorY - y;
              const force = s.ambientCohesion / (1 + (dx * dx + dy * dy) / cohesionRadiusSq);
              ax += dx * force;
              ay += dy * force;
            }

            if ((peopleCount > 0 || pendingCount > 0) && dispersing < 0.3 && field) {
              const swirlSign = sd < fw.anticipationSwirlBias ? 1 : -1;
              // ANTICIPATION: una silueta aún no confirmada ya curva y enciende el campo cercano.
              for (let q = 0; q < pendingCount; q++) {
                const dx = field.pendingX[q] - x;
                const dy = field.pendingY[q] - y;
                const distSq = dx * dx + dy * dy;
                const dist = Math.sqrt(distSq) + 0.001;
                const inner = dist < innerRadius ? dist / innerRadius : 1;
                const pull = 1 / (1 + distSq / attractionRadiusSq);
                const force = pendingAttraction * scale * inner * pull;
                const tangential = force * fw.anticipationCurl * swirlSign;
                ax += (dx * force - dy * tangential) / dist;
                ay += (dy * force + dx * tangential) / dist;
                anticipation = Math.max(anticipation, pull);
              }
              for (let k = 0; k < peopleCount; k++) {
                const dx = field.peopleX[k] - x;
                const dy = field.peopleY[k] - y;
                const distSq = dx * dx + dy * dy;
                const dist = Math.sqrt(distSq) + 0.001;
                const inner = dist < innerRadius ? dist / innerRadius : 1;
                const pull = 1 / (1 + distSq / attractionRadiusSq);
                const force = personAttraction[k] * scale * inner * pull;
                // Campo magnético que se activa: atracción con giro tangencial durante la formación.
                const tangential = force * this.personCurl[k] * swirlSign;
                ax += (dx * force - dy * tangential) / dist;
                ay += (dy * force + dx * tangential) / dist;
                anticipation = Math.max(anticipation, personPhase[k] * pull);

                const wake = Math.max(0, 1 - distSq / magneticRadiusSq);
                if (wake <= 0) continue;
                const pvx = field.peopleVx[k];
                const pvy = field.peopleVy[k];
                ax += pvx * FRAME_MS * s.ambientMotionInfluence * wake;
                ay += pvy * FRAME_MS * s.ambientMotionInfluence * wake;
                // Las partículas que quedan delante del movimiento se abren hacia los lados.
                const bodySpeed = Math.hypot(pvx, pvy);
                if (bodySpeed > 0.001) {
                  const nx = pvx / bodySpeed;
                  const ny = pvy / bodySpeed;
                  const ahead = -dx * nx - dy * ny;
                  if (ahead > 0) {
                    const sideX = -dx - ahead * nx;
                    const sideY = -dy - ahead * ny;
                    const side = Math.hypot(sideX, sideY) + 0.001;
                    const push = s.magneticDeflection * bodySpeed * FRAME_MS * wake;
                    ax += (sideX / side) * push;
                    ay += (sideY / side) * push;
                  }
                }
              }
            }
          }
        }

        const speedLimitSq = speedLimit * speedLimit;
        for (let i = 0; i < substeps; i++) {
          velX = (velX + ax * h) * damping;
          velY = (velY + ay * h) * damping;
          if (speedLimit > 0) {
            const speedSq = velX * velX + velY * velY;
            if (speedSq > speedLimitSq) {
              const f = speedLimit / Math.sqrt(speedSq);
              velX *= f;
              velY *= f;
            }
          }
          x += velX * h;
          y += velY * h;
        }

        if (x < -WRAP_MARGIN || x > this.width + WRAP_MARGIN || y < -WRAP_MARGIN || y > this.height + WRAP_MARGIN) {
          if (lt === 0) {
            this.makeDormant(p);
            continue;
          }
          x = this.random() * this.width;
          y = this.random() * this.height;
          velX = 0;
          velY = 0;
          l = 0;
          life[p] = 0;
          releasedAt[p] = 0;
          bridgeSlot[p] = -1;
        }
        renderX = x;
        renderY = y;
      }

      if (wavesActive) {
        for (let w = 0; w < MAX_WAVES; w++) {
          const age = now - this.waveStart[w];
          if (age < 0 || age > waveLifetime) continue;
          const dx = x - this.waveOriginX[w];
          const dy = y - this.waveOriginY[w];
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
          const life = 1 - age / waveLifetime;
          if (dist < waveGlowRadius) {
            const near = 1 - dist / waveGlowRadius;
            e = Math.max(e, s.waveGlow * near * near * life);
          }
          const angle = Math.atan2(dy, dx);
          const warp = waveWidth * s.waveOrganicWarp * (
            Math.sin(angle * 3.1 + phase[p] + age * 0.004) * 0.66 +
            Math.sin(angle * 5.3 - phase[p] * 0.7 - age * 0.0025) * 0.34
          );
          const offset = Math.abs(dist + warp - age * waveSpeed);
          if (offset >= waveWidth) continue;
          // Perfil coseno: frente suave, sin borde duro.
          const falloff = 0.5 + 0.5 * Math.cos((offset / waveWidth) * Math.PI);
          const envelope = life * life;
          const push = falloff * envelope * this.waveStrength[w] * scale * (m === BODY ? 1 : s.waveAmbientFactor);
          const curl = Math.sin(angle * 2 + phase[p] + age * 0.005) * push * 0.16;
          velX += (dx / dist) * push - (dy / dist) * curl;
          velY += (dy / dist) * push + (dx / dist) * curl;
          e = Math.max(e, falloff * envelope);
        }
      }

      if (resonanceActive) {
        const dx = x - this.resonanceX;
        const dy = y - this.resonanceY;
        const distSq = dx * dx + dy * dy;
        if (distSq < resonanceRadius * resonanceRadius) {
          const dist = Math.sqrt(distSq) + 0.001;
          const near = 1 - dist / resonanceRadius;
          e = Math.max(e, gi.resonanceGlow * resonanceEnvelope * near * near);
          // Sólo el campo se dispersa: los cuerpos brillan pero conservan su tracking.
          if (m !== BODY) {
            const push = gi.resonancePush * scale * resonanceEnvelope * near * frames * (1 - resonanceAge / gi.resonanceDurationMs);
            velX += (dx / dist) * push;
            velY += (dy / dist) * push;
          }
        }
      }

      px[p] = x;
      py[p] = y;
      vx[p] = velX;
      vy[p] = velY;
      bond[p] = b;
      excite[p] = e;

      const vis = b <= 0 ? 0 : b >= 1 ? 1 : b;
      let size: number;
      let alpha: number;
      if (vis >= 1) {
        // Cuerpo formado: el aspecto del campo (profundidad, parpadeo) ya no participa.
        size = lerp(sizeFar, sizeClose, proximity[p]) * (0.75 + sd * 0.5) * (1 + s.breathingAmount * Math.sin(time * 1.6 + phase[p]));
        alpha = glow[p];
      } else {
        const idleSize = sizeIdle * lerp(idleDepth.sizeFar, idleDepth.sizeNear, sd);
        const twinkle = 1 - twinkleAmount + twinkleAmount * Math.sin(time * (0.32 + sd * 0.5) + phase[p]);
        size = idleSize;
        alpha = opacityIdle * lerp(idleDepth.alphaFar, idleDepth.alphaNear, sd) * twinkle * (1 + anticipation * s.formationAnticipationGlow);
        if (vis > 0) {
          const breathing = 1 + s.breathingAmount * Math.sin(time * 1.6 + phase[p]);
          const bodySize = lerp(sizeFar, sizeClose, proximity[p]) * (0.75 + sd * 0.5) * breathing;
          size = idleSize + (bodySize - idleSize) * vis;
          alpha = alpha + (glow[p] - alpha) * vis;
        }
      }
      size *= visualSize * scale * (1 + e * s.gestureExciteSize) * lerp(1, s.textParticleSize, textDetach);
      alpha = (alpha * visualAlpha + e * s.gestureExciteAlpha) * l * lerp(1, s.textParticleAlpha, textDetach);
      if (alpha < 0.004) continue;

      renderData[out++] = renderX;
      renderData[out++] = renderY;
      renderData[out++] = size;
      renderData[out++] = alpha > 1 ? 1 : alpha;
    }

    this.renderCount = out / RENDER_STRIDE;
    this.detachingCount = detaching;
    this.bodyCount = bodyCount;
    this.ambientCount = ambientVisible;
    this.trailCount = trailCount;
    this.shedCount = shedCount;
    this.coreCount = bodyCount - trailCount - shedCount;
    this.averageTargetDistance = targetDistanceSamples > 0 ? targetDistanceTotal / targetDistanceSamples : 0;
    let averageTrackSpeed = 0;
    if (field && field.peopleCount > 0) {
      for (let i = 0; i < field.peopleCount; i++) averageTrackSpeed += field.peopleSpeed[i] / 1000;
      averageTrackSpeed /= field.peopleCount;
    }
    this.estimatedTargetLagMs = averageTrackSpeed > 0.04
      ? Math.min(1000, this.averageTargetDistance / averageTrackSpeed)
      : 0;

    for (let k = 0; k < peopleCount; k++) formation.report(k, personFormed[k], personBody[k], now, fw.lockThreshold);
    this.formationProgress = formation.overallProgress(peopleCount);

    let bridged = 0;
    for (let c = 0; c < MAX_CONNECTIONS; c++) bridged += bridgeCount[c];
    this.bridgeParticleCount = bridged;
    if (group) this.recruitBridges(group, now);

    if (now - this.lastPopulationAt >= POPULATION_INTERVAL_MS) {
      this.lastPopulationAt = now;
      this.balanceAmbient(ambientVisible, peopleCount > 0);
    }
  }

  /** Onda local alrededor de la mano (px CSS). Si se indica la persona, la onda la acompaña. */
  emitWave(x: number, y: number, now: number, strength = 1, personId = -1): void {
    const w = this.waveCursor++ % MAX_WAVES;
    const field = this.field;
    const k = field && personId >= 0 ? field.personIndex(personId) : -1;
    this.waveX[w] = x;
    this.waveY[w] = y;
    this.wavePersonId[w] = k >= 0 ? personId : -1;
    this.waveOffsetX[w] = k >= 0 && field ? x - field.peopleX[k] : 0;
    this.waveOffsetY[w] = k >= 0 && field ? y - field.peopleY[k] : 0;
    this.waveStart[w] = now;
    this.waveStrength[w] = this.settings.waveStrength * strength;
    this.lastWaveAt = now;
  }

  /** Expansión suspendida para BOTH_HANDS_UP. El enlace y el tracking nunca se interrumpen. */
  celebrate(now: number, durationMs: number, strength: number): void {
    const field = this.field;
    this.celebrationStart = now;
    this.celebrationDuration = Math.max(1, durationMs);
    this.celebrationStrength = strength;
    this.selectTextParticles();
    for (let p = 0; p < this.capacity; p++) {
      if (this.mode[p] !== BODY) continue;
      let dx = this.random() - 0.5;
      let dy = this.random() - 0.5;
      if (field) {
        const personIndex = field.personIndex(this.particlePersonId[p]);
        if (personIndex >= 0) {
          dx = this.px[p] - field.peopleX[personIndex];
          dy = this.py[p] - field.peopleY[personIndex];
        }
      }
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const kick = strength * this.scale * (0.12 + this.random() * 0.22);
      this.vx[p] += (dx / dist) * kick;
      this.vy[p] += (dy / dist) * kick;
      this.excite[p] = Math.max(this.excite[p], 0.58);
    }
  }

  /** Grupo estable de partículas del cuerpo (según su semilla) que participa en los textos. */
  private selectTextParticles(): void {
    this.revealTarget.fill(-1);
    let cursor = 0;
    for (let p = 0; p < this.capacity; p++) {
      if (this.mode[p] !== BODY || this.bond[p] <= TEXT_MIN_BOND) continue;
      if ((this.seed[p] * 3.71) % 1 >= this.settings.textParticleRatio) continue;
      // Paso primo: reparte el grupo por todo el texto en lugar de llenarlo en orden.
      this.revealTarget[p] = cursor * 37;
      cursor++;
    }
  }

  private flightBlendAt(now: number): number {
    const t = now - this.flightStart;
    if (t < 0) return 0;
    if (t < this.flightTravel) return smoothstep(0, this.flightTravel, t);
    if (t < this.flightTravel + this.flightHold) return 1;
    return 1 - smoothstep(0, this.flightReturn, t - this.flightTravel - this.flightHold);
  }

  /**
   * Traslación rígida del cuerpo: toda la silueta cambia de celda a la vez y cada partícula sólo
   * recorre el desplazamiento real. Sin esto, al caminar las partículas del borde trasero cruzan
   * el cuerpo hasta el delantero y la figura se ve estirada hacia atrás.
   */
  private shiftOwnership(field: TargetField, now: number): number {
    let moving = false;
    for (let k = 0; k < field.peopleCount; k++) {
      if (field.peopleCellShiftX[k] !== 0 || field.peopleCellShiftY[k] !== 0) moving = true;
    }
    if (!moving) return 0;

    const { mode, cell, cellOwner, particlePersonId, capacity, shiftState } = this;
    const { cols, rows, active, cellPersonId } = field;
    for (let p = 0; p < capacity; p++) {
      shiftState[p] = 0;
      if (mode[p] !== BODY || cell[p] < 0) continue;
      const k = field.personIndex(particlePersonId[p]);
      if (k < 0 || (field.peopleCellShiftX[k] === 0 && field.peopleCellShiftY[k] === 0)) continue;
      if (cellOwner[cell[p]] === p) cellOwner[cell[p]] = -1;
      shiftState[p] = 2;
    }

    // La traslación es inyectiva: dos partículas de la misma persona nunca compiten por una celda.
    let shifted = 0;
    for (let p = 0; p < capacity; p++) {
      if (shiftState[p] === 0) continue;
      const k = field.personIndex(particlePersonId[p]);
      const c = cell[p];
      const col = (c % cols) + field.peopleCellShiftX[k];
      const row = ((c - (c % cols)) / cols) + field.peopleCellShiftY[k];
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const target = row * cols + col;
      if (active[target] === 0 || cellPersonId[target] !== particlePersonId[p] || cellOwner[target] >= 0) continue;
      cell[p] = target;
      cellOwner[target] = p;
      this.retargetedAt[p] = now;
      shiftState[p] = 1;
      shifted++;
    }

    // Las que no tienen celda desplazada conservan la suya si nadie la tomó; si no, pasan al transporte.
    for (let p = 0; p < capacity; p++) {
      if (shiftState[p] === 2 && cellOwner[cell[p]] < 0) cellOwner[cell[p]] = p;
    }
    return shifted;
  }

  private rebuildOwnership(field: TargetField, now: number): void {
    for (let p = 0; p < this.capacity; p++) {
      if (this.mode[p] !== BODY) continue;
      this.bakeOffset(p);
      this.mode[p] = AMBIENT;
      this.cell[p] = -1;
      this.particlePersonId[p] = -1;
      this.retargetedAt[p] = -Infinity;
      this.releasedAt[p] = now;
    }
    this.cellOwner = new Int32Array(field.cellCount).fill(-1);
    this.fieldVersion = field.version;
  }

  /**
   * Retraso de formación de una celda (fracción positiva de formationDuration). Antes del lock
   * mezcla azar con distancia al centro: el torso aparece primero y las extremidades después.
   * Tras el lock casi no hay retraso: una silueta ya formada debe crecer como espejo.
   */
  private formationDelay(field: TargetField, c: number): number {
    const s = this.settings;
    const random = this.random();
    const personIndex = field.personIndex(field.cellPersonId[c]);
    if (personIndex < 0) return random * s.formationStagger;
    if (this.formation.isLocked(personIndex)) return random * s.formationStagger * s.formationWow.lockedStaggerScale;
    const distance = Math.hypot(field.cellX[c] - field.peopleX[personIndex], field.cellY[c] - field.peopleY[personIndex]);
    const radial = clamp01(distance / Math.max(1, this.personRadius[personIndex]));
    return lerp(random, radial, s.formationWow.radialStagger) * s.formationStagger;
  }

  /** Al volver al campo, la partícula queda donde se veía: el offset visual pasa a ser su posición. */
  private bakeOffset(p: number): void {
    this.px[p] += this.offX[p];
    this.py[p] += this.offY[p];
    this.offX[p] = 0;
    this.offY[p] = 0;
    this.offVx[p] = 0;
    this.offVy[p] = 0;
  }

  /** Geometría de cada corriente: extremos separados de los cuerpos, curvatura lenta y velocidad de flujo. */
  private prepareBridges(group: GroupInteraction, time: number): void {
    const gi = this.settings.groupInteraction;
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      this.bridgeSpan[c] = 0;
      if (group.connectionIdA[c] < 0 || group.strength[c] < BRIDGE_RELEASE_STRENGTH) continue;
      const dx = group.bx[c] - group.ax[c];
      const dy = group.by[c] - group.ay[c];
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      const dirX = dx / length;
      const dirY = dy / length;
      const inset = Math.min(gi.endInset * this.scale, length * 0.3);
      const span = length - inset * 2;
      this.bridgeStartX[c] = group.ax[c] + dirX * inset;
      this.bridgeStartY[c] = group.ay[c] + dirY * inset;
      this.bridgeDirX[c] = dirX;
      this.bridgeDirY[c] = dirY;
      this.bridgeSpan[c] = span;
      this.bridgeBend[c] = gi.curvature * span * Math.sin(time * gi.bendSpeed + group.seed[c]);
      this.bridgeFlow[c] = gi.flowSpeed * (1 + gi.relativeSpeedBoost * group.relativeMotion[c]);
    }
  }

  /**
   * Recluta partículas del campo cercanas a cada corriente con un barrido acotado por frame.
   * Sólo si un barrido completo no alcanza, aparecen unas pocas partículas sobre la corriente.
   */
  private recruitBridges(group: GroupInteraction, now: number): void {
    const gi = this.settings.groupInteraction;
    const need = this.bridgeNeed;
    let deficit = 0;
    for (let c = 0; c < MAX_CONNECTIONS; c++) {
      need[c] = this.bridgeSpan[c] > 0 ? Math.max(0, group.particleBudget[c] - this.bridgeCount[c]) : 0;
      deficit += need[c];
    }
    if (deficit === 0) {
      this.bridgeSpawnAllowed = false;
      return;
    }

    const radiusSq = (gi.recruitRadius * this.scale) ** 2;
    const scan = Math.min(this.capacity, gi.recruitScanPerFrame);
    const { mode, bridgeSlot, lifeTarget, life, releasedAt, px, py } = this;
    for (let i = 0; i < scan && deficit > 0; i++) {
      const p = (this.recruitCursor + i) % this.capacity;
      if (mode[p] !== AMBIENT || bridgeSlot[p] >= 0 || lifeTarget[p] !== 1 || life[p] < 0.3 || this.detachAt[p] > 0) continue;
      if (releasedAt[p] > 0 && now - releasedAt[p] < this.settings.dispersionDuration) continue;
      for (let c = 0; c < MAX_CONNECTIONS; c++) {
        if (need[c] === 0) continue;
        const rx = px[p] - this.bridgeStartX[c];
        const ry = py[p] - this.bridgeStartY[c];
        const t = (rx * this.bridgeDirX[c] + ry * this.bridgeDirY[c]) / this.bridgeSpan[c];
        if (t < BRIDGE_RECRUIT_MIN_T || t > BRIDGE_RECRUIT_MAX_T) continue;
        const across = ry * this.bridgeDirX[c] - rx * this.bridgeDirY[c];
        if (across * across > radiusSq) continue;
        bridgeSlot[p] = c;
        this.bridgeT[p] = t;
        this.fadeMs[p] = gi.fadeInMs;
        need[c]--;
        deficit--;
        break;
      }
    }
    this.recruitCursor = (this.recruitCursor + scan) % this.capacity;
    this.recruitSweep += scan;
    if (this.recruitSweep >= this.capacity) {
      this.recruitSweep = 0;
      this.bridgeSpawnAllowed = deficit > 0;
    }
    if (!this.bridgeSpawnAllowed) return;

    let spawns = gi.spawnPerFrame;
    for (let c = 0; c < MAX_CONNECTIONS && spawns > 0; c++) {
      while (need[c] > 0 && spawns > 0 && this.dormantTop > 0) {
        const p = this.dormantStack[--this.dormantTop];
        this.spawnAmbient(p);
        const t = BRIDGE_RECRUIT_MIN_T + this.random() * (BRIDGE_RECRUIT_MAX_T - BRIDGE_RECRUIT_MIN_T);
        this.px[p] = this.bridgeStartX[c] + this.bridgeDirX[c] * this.bridgeSpan[c] * t;
        this.py[p] = this.bridgeStartY[c] + this.bridgeDirY[c] * this.bridgeSpan[c] * t;
        this.vx[p] = 0;
        this.vy[p] = 0;
        this.fadeMs[p] = gi.fadeInMs;
        bridgeSlot[p] = c;
        this.bridgeT[p] = t;
        need[c]--;
        spawns--;
      }
    }
  }

  /** Pequeño pulso de partículas del campo donde se encuentran dos ondas; se desvanecen solas. */
  private spawnResonancePulse(now: number): void {
    const gi = this.settings.groupInteraction;
    for (let i = 0; i < gi.resonanceSpawnCount && this.dormantTop > 0; i++) {
      const p = this.dormantStack[--this.dormantTop];
      this.spawnAmbient(p);
      const angle = this.random() * TAU;
      const kick = gi.resonanceKick * this.scale * (0.4 + 0.6 * this.random());
      this.px[p] = this.resonanceX;
      this.py[p] = this.resonanceY;
      this.vx[p] = Math.cos(angle) * kick;
      this.vy[p] = Math.sin(angle) * kick;
      this.life[p] = 1;
      this.lifeTarget[p] = 0;
      this.fadeMs[p] = gi.resonanceDurationMs;
      this.releasedAt[p] = now;
      this.excite[p] = gi.resonanceGlow;
    }
  }

  private release(p: number, now: number, detachDelayMs: number): void {
    if (this.cell[p] >= 0) this.cellOwner[this.cell[p]] = -1;
    this.bakeOffset(p);
    this.cell[p] = -1;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
    this.revealTarget[p] = -1;
    this.mode[p] = AMBIENT;
    this.releasedAt[p] = now;
    if (detachDelayMs > 0) this.detachAt[p] = now + detachDelayMs;
    else this.detach(p, now);
  }

  /** Conserva el momentum y agrega un pequeño impulso: la silueta se fragmenta en lugar de apagarse. */
  private detach(p: number, now: number): void {
    this.detachAt[p] = 0;
    this.releasedAt[p] = now;
    const angle = this.random() * TAU;
    const kick = this.settings.releaseKick * this.scale * (0.3 + 0.7 * this.random());
    this.vx[p] += Math.cos(angle) * kick;
    this.vy[p] += Math.sin(angle) * kick;
  }

  private spawnNear(p: number, x: number, y: number): void {
    this.detachAt[p] = 0;
    const { min, max } = this.settings.spawnDistance;
    const angle = this.random() * TAU;
    const distance = lerp(min, max, this.random()) * this.scale;
    this.px[p] = x + Math.cos(angle) * distance;
    this.py[p] = y + Math.sin(angle) * distance;
    this.vx[p] = 0;
    this.vy[p] = 0;
    this.life[p] = 0;
    this.bridgeSlot[p] = -1;
    this.glow[p] = this.settings.particleOpacity.far;
    this.proximity[p] = 0;
    this.excite[p] = 0;
    this.releasedAt[p] = 0;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
  }

  private spawnAmbient(p: number): void {
    this.detachAt[p] = 0;
    this.px[p] = this.random() * this.width;
    this.py[p] = this.random() * this.height;
    this.vx[p] = (this.random() - 0.5) * 0.3;
    this.vy[p] = (this.random() - 0.5) * 0.3;
    this.life[p] = 0;
    this.lifeTarget[p] = 1;
    this.fadeMs[p] = IDLE_FADE_IN_MS * (0.5 + this.random());
    this.bond[p] = 0;
    this.excite[p] = 0;
    this.releasedAt[p] = 0;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
    this.bridgeSlot[p] = -1;
    this.mode[p] = AMBIENT;
  }

  private makeDormant(p: number): void {
    this.detachAt[p] = 0;
    this.mode[p] = DORMANT;
    this.life[p] = 0;
    this.lifeTarget[p] = 0;
    this.cell[p] = -1;
    this.bridgeSlot[p] = -1;
    this.offX[p] = 0;
    this.offY[p] = 0;
    this.offVx[p] = 0;
    this.offVy[p] = 0;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
    this.dormantStack[this.dormantTop++] = p;
  }

  /** Busca una celda nueva en anillos de la propia retícula; coste acotado, nunca O(N²). */
  private findTransportTarget(field: TargetField, personId: number, x: number, y: number): number {
    if (field.cellCount === 0) return -1;
    const originX = field.cellX[0];
    const originY = field.cellY[0];
    const centerCol = Math.max(0, Math.min(field.cols - 1, Math.round((x - originX) / field.spacing)));
    const centerRow = Math.max(0, Math.min(field.rows - 1, Math.round((y - originY) / field.spacing)));
    const maxRings = Math.max(1, Math.ceil((this.settings.trackingSearchRadius * this.scale) / field.spacing));
    const { cols, rows, active, cellPersonId } = field;

    for (let ring = 0; ring <= maxRings; ring++) {
      const r0 = centerRow - ring;
      const r1 = centerRow + ring;
      const c0 = centerCol - ring;
      const c1 = centerCol + ring;
      let best = -1;
      let bestDistance = Infinity;
      for (let r = r0; r <= r1; r++) {
        if (r < 0 || r >= rows) continue;
        const step = r === r0 || r === r1 ? 1 : Math.max(1, c1 - c0);
        for (let c = c0; c <= c1; c += step) {
          if (c < 0 || c >= cols) continue;
          const target = r * cols + c;
          if (active[target] === 0 || this.cellOwner[target] >= 0 || cellPersonId[target] !== personId) continue;
          const dx = field.cellX[target] - x;
          const dy = field.cellY[target] - y;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            best = target;
            bestDistance = distance;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Mantiene el campo ambiental en su población deseada con fundidos graduales. */
  private balanceAmbient(visible: number, presence: boolean): void {
    const s = this.settings;
    const desired = Math.round(s.idleParticleCount * (presence ? s.ambientPresenceRatio : 1));

    if (visible > desired) {
      let excess = visible - desired;
      let scanned = 0;
      while (excess > 0 && scanned < this.capacity) {
        const p = (this.populationCursor + scanned) % this.capacity;
        scanned++;
        if (this.mode[p] !== AMBIENT || this.lifeTarget[p] !== 1 || this.bridgeSlot[p] >= 0) continue;
        this.lifeTarget[p] = 0;
        this.fadeMs[p] = s.dispersionDuration * (0.5 + this.random());
        excess--;
      }
      this.populationCursor = (this.populationCursor + scanned) % this.capacity;
    } else if (visible < desired * 0.97) {
      let deficit = desired - visible;
      while (deficit > 0 && this.dormantTop > 0) {
        this.spawnAmbient(this.dormantStack[--this.dormantTop]);
        deficit--;
      }
    }
  }

  private binOf(x: number, y: number): number {
    let c = (x / this.binSize) | 0;
    let r = (y / this.binSize) | 0;
    if (c < 0) c = 0;
    else if (c >= this.binCols) c = this.binCols - 1;
    if (r < 0) r = 0;
    else if (r >= this.binRows) r = this.binRows - 1;
    return r * this.binCols + c;
  }

  /** Toma la partícula libre más cercana buscando en anillos de bins. */
  private takeFree(x: number, y: number): number {
    const center = this.binOf(x, y);
    const bc = center % this.binCols;
    const br = (center - bc) / this.binCols;
    const { binCols, binRows, binCursor, binStart, binItems } = this;

    for (let ring = 0; ring <= this.settings.formationSearchRings; ring++) {
      const r0 = br - ring;
      const r1 = br + ring;
      const c0 = bc - ring;
      const c1 = bc + ring;
      for (let r = r0; r <= r1; r++) {
        if (r < 0 || r >= binRows) continue;
        const step = r === r0 || r === r1 ? 1 : c1 - c0;
        for (let c = c0; c <= c1; c += step) {
          if (c < 0 || c >= binCols) continue;
          const b = r * binCols + c;
          if (binCursor[b] < binStart[b + 1]) return binItems[binCursor[b]++];
        }
      }
    }
    return -1;
  }
}
