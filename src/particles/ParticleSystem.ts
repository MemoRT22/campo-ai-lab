import type { Config } from '../config';
import { TAU, createRandom, lerp, screenScale, smoothstep } from '../utils/MathUtils';
import { FlowField } from './FlowField';
import { motionPhaseIndex, perFrameFactor, retargetFastBlend, speedFastBlend, trackingWeight } from './motionProfile';
import type { TargetField } from './TargetField';

const DORMANT = 0;
const AMBIENT = 1;
const BODY = 2;

export const RENDER_STRIDE = 4;

const FRAME_MS = 1000 / 60;
const BIN_SIZE = 64;
const MAX_RINGS = 4;
const MAX_WAVES = 6;
const WAVE_LIFETIME_MS = 950;
/**
 * Las partículas libres casi no tienen fricción: si la onda las empuja con la misma fuerza
 * que al cuerpo, viajan con el frente y dibujan un anillo geométrico. Sólo se rozan.
 */
const WAVE_AMBIENT_FACTOR = 0.12;
const EXCITE_SIZE = 0.9;
const EXCITE_ALPHA = 0.22;
const EXCITE_DECAY_MS = 650;
const GLOW_SMOOTHING_MS = 120;
const IDLE_FADE_IN_MS = 2600;
const POPULATION_INTERVAL_MS = 200;
const ATTRACTION_RADIUS = 420;
const ATTRACTION_INNER_RADIUS = 160;
const ATTRACTION_WINDOW_MS = 2600;
const WRAP_MARGIN = 24;
const TEXT_PARTICLE_RATIO = 0.065;

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
  /** Partículas que acompañaron una traslación rígida del cuerpo en el último frame de visión. */
  shiftedLastFrame = 0;
  averageTargetDistance = 0;
  estimatedTargetLagMs = 0;
  /** Partículas de cuerpo por fase en el último frame: formation, tracking, fast, departure. */
  readonly motionPhaseCounts = new Int32Array(4);

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
  private readonly revealTarget: Int32Array;
  private dormantTop = 0;

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
  private presenceSince = -1;

  private readonly waveX = new Float32Array(MAX_WAVES);
  private readonly waveY = new Float32Array(MAX_WAVES);
  private readonly waveStart = new Float64Array(MAX_WAVES).fill(-Infinity);
  private readonly waveStrength = new Float32Array(MAX_WAVES);
  private waveCursor = 0;
  private lastWaveAt = -Infinity;
  private celebrationStart = -Infinity;
  private celebrationDuration = 0;
  private celebrationStrength = 0;
  private revealTargets = new Float32Array(0);
  private revealTargetCount = 0;

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
    this.particlePersonId = new Int32Array(n).fill(-1);
    this.retargetedAt = new Float64Array(n).fill(-Infinity);
    this.cell = new Int32Array(n).fill(-1);
    this.mode = new Uint8Array(n);
    this.dormantStack = new Int32Array(n);
    this.transportCandidates = new Int32Array(n);
    this.shiftState = new Uint8Array(n);
    this.revealTarget = new Int32Array(n).fill(-1);
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

  /** Targets tipográficos precalculados por UI; se reemplazan sólo al hacer resize. */
  setRevealTargets(targets: Float32Array): void {
    this.revealTargets = new Float32Array(targets);
    this.revealTargetCount = targets.length / 2;
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

    this.transportedLastFrame = 0;
    this.formedLastFrame = 0;
    this.spawnedLastFrame = 0;
    this.releasedLastFrame = 0;
    this.heldLastFrame = 0;
    this.shiftedLastFrame = this.shiftOwnership(field, now);

    if (field.peopleCount > 0 && this.presenceSince < 0) this.presenceSince = now;
    else if (field.peopleCount === 0) this.presenceSince = -1;

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

    const missingByPerson = this.missingByPerson;
    missingByPerson.fill(0);
    const { activeList, activeCount, cellX, cellY } = field;
    for (let k = 0; k < activeCount; k++) {
      const c = activeList[k];
      if (cellOwner[c] >= 0) continue;
      const personIndex = field.personIndex(cellPersonId[c]);
      if (personIndex >= 0) missingByPerson[personIndex]++;
    }

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

    const stagger = this.settings.formationStagger;
    for (let k = 0; k < activeCount; k++) {
      const c = activeList[k];
      if (cellOwner[c] >= 0) continue;

      let p = this.takeFree(cellX[c], cellY[c]);
      let spawned = false;
      if (p >= 0) {
        if (this.bond[p] < 0.05) this.bond[p] = -this.random() * stagger;
      } else if (this.dormantTop > 0) {
        p = this.dormantStack[--this.dormantTop];
        this.spawnNear(p, cellX[c], cellY[c]);
        spawned = true;
      } else {
        continue;
      }

      mode[p] = BODY;
      cell[p] = c;
      cellOwner[c] = p;
      particlePersonId[p] = cellPersonId[c];
      this.retargetedAt[p] = -Infinity;
      this.lifeTarget[p] = 1;
      this.formedLastFrame++;
      if (spawned) this.spawnedLastFrame++;
    }

    for (let i = 0; i < candidateCount; i++) {
      const p = transportCandidates[i];
      if (p >= 0) {
        this.release(p, now);
        this.releasedLastFrame++;
      }
    }
  }

  step(dtSeconds: number, now: number): void {
    const s = this.settings;
    const dtMs = dtSeconds * 1000;
    const frames = dtMs / FRAME_MS;
    const substeps = frames > 1.5 ? Math.ceil(frames / 1.25) : 1;
    const h = frames / substeps;

    this.flow.update(now);
    const flow = this.flow;
    const field = this.field;
    const { px, py, vx, vy, bond, life, lifeTarget, fadeMs, mode, cell, excite, glow, proximity, seed, phase, jitterX, jitterY, releasedAt, retargetedAt, particlePersonId } = this;
    const renderData = this.renderData;

    const scale = this.scale;
    const spacing = field ? field.spacing : s.particleSpacing * scale;
    const cellX = field?.cellX;
    const cellY = field?.cellY;
    const cellProximity = field?.cellProximity;
    const cellEdge = field?.cellEdge;
    const peopleCount = field ? field.peopleCount : 0;

    const bodyDamping = Math.pow(s.particleDamping, h);
    const trackingDamping = Math.pow(s.trackingDamping, h);
    const fastDamping = Math.pow(s.fastMotionDamping, h);
    const ambientDamping = Math.pow(s.ambientDamping, h);
    const trackingSnap = perFrameFactor(s.trackingSnap, h);
    const fastSnap = perFrameFactor(s.fastMotionSnap, h);
    const trackingMaxSpeed = s.maxSpeed * scale;
    const formationMaxSpeed = s.formationMaxSpeed * scale;
    this.motionPhaseCounts.fill(0);

    if (field) {
      // Entre frames de visión (30 Hz) el target avanza con la traslación estable del track:
      // evita que las partículas avancen a escalones sin extrapolar más de un intervalo.
      const sinceVision = Math.min(Math.max(0, now - field.lastVisionAt), s.interpolationMaxMs);
      const maxInterpolation = s.predictionMaxDistance * scale;
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
      }
    }
    const noiseAmplitude = s.particleNoise * scale;
    const formationStep = dtMs / s.formationDuration;
    const dispersionStep = dtMs / s.dispersionDuration;
    const formationFadeMs = s.formationDuration * 0.6;
    const fadeDelayMs = s.dispersionDuration * 0.2;
    const exciteDecay = Math.exp(-dtMs / EXCITE_DECAY_MS);
    const glowAlpha = 1 - Math.exp(-dtMs / GLOW_SMOOTHING_MS);
    const time = now * 0.001;
    const wavesActive = now - this.lastWaveAt < WAVE_LIFETIME_MS;
    const waveSpeed = s.waveSpeed * scale;
    const waveWidth = s.waveWidth * scale;
    const celebrationProgress = this.celebrationDuration > 0 ? (now - this.celebrationStart) / this.celebrationDuration : -1;
    const celebrationEnvelope = celebrationProgress >= 0 && celebrationProgress <= 1 ? Math.sin(celebrationProgress * Math.PI) : 0;
    let textEnvelope = 0;
    if (celebrationProgress >= 0.16 && celebrationProgress < 0.82) {
      const rise = Math.min(1, (celebrationProgress - 0.16) / 0.18);
      const fall = Math.min(1, (0.82 - celebrationProgress) / 0.2);
      textEnvelope = Math.min(rise, fall);
      textEnvelope = textEnvelope * textEnvelope * (3 - 2 * textEnvelope);
    }

    const attractionRadiusSq = (ATTRACTION_RADIUS * scale) ** 2;
    const innerRadius = ATTRACTION_INNER_RADIUS * scale;
    const motionRadiusSq = (280 * scale) ** 2;
    let attraction = 0;
    if (peopleCount > 0 && this.presenceSince >= 0) {
      const elapsed = now - this.presenceSince;
      attraction = s.ambientAttraction * (elapsed < ATTRACTION_WINDOW_MS ? 1 : Math.max(0.2, 1 - (elapsed - ATTRACTION_WINDOW_MS) / 2000));
    }

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
      else if (l > lt && now - releasedAt[p] > fadeDelayMs) l = Math.max(lt, l - dtMs / fadeMs[p]);
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

      if (m === BODY && cellX && cellY && cellProximity && cellEdge) {
        bodyCount++;
        if (b < 1) b = Math.min(1, b + formationStep);
        const bc = b < 0 ? 0 : b;
        const ease = bc * bc * (3 - 2 * bc);
        const formed = trackingWeight(bc, s);
        const c = cell[p];
        const personIndex = field ? field.personIndex(particlePersonId[p]) : -1;
        let tx = cellX[c] + jitterX[p] * spacing + noiseAmplitude * Math.sin(time * (0.9 + sd * 0.8) + phase[p]);
        let ty = cellY[c] + jitterY[p] * spacing + noiseAmplitude * Math.cos(time * (0.7 + sd * 0.9) + phase[p] * 1.7);
        let fast = 0;
        let letGo = 0;
        if (field && personIndex < 0) {
          // Omisión corta de segmentación: la partícula suelta el target y conserva su momentum
          // en vez de congelarse. Si el track vuelve, recupera el seguimiento en pocos frames.
          letGo = smoothstep(0, s.departureLetGoMs, field.trackAge(particlePersonId[p], now));
        }
        if (field && personIndex >= 0) {
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
        if (textEnvelope > 0 && revealIndex >= 0 && revealIndex < this.revealTargetCount) {
          const targetOffset = revealIndex * 2;
          const textBlend = textEnvelope * 0.82;
          tx = lerp(tx, this.revealTargets[targetOffset], textBlend);
          ty = lerp(ty, this.revealTargets[targetOffset + 1], textBlend);
          e = Math.max(e, textEnvelope * 0.72);
        }

        flow.sample(x, y);
        // Mientras el enlace es débil la partícula todavía "nada" en el campo y se curva al llegar.
        const swirl = (1 - ease) * s.ambientDrift * 6;
        fast = Math.max(fast, retargetFastBlend(now - retargetedAt[p], s));
        const trail = (sd * 9.73) % 1 < s.fastMotionTrailRatio ? s.fastMotionTrail * fast : 0;
        const suspension = 1 - celebrationEnvelope * s.revealSuspension;
        const textDetach = textEnvelope > 0 && revealIndex >= 0 ? textEnvelope : 0;

        // INITIAL FORMATION y NORMAL/FAST TRACKING se mezclan por `formed`; DEPARTURE por `letGo`.
        const formationK = s.particleAttraction * ease;
        const formationDamping = ambientDamping + (bodyDamping - ambientDamping) * ease;
        const trackK = lerp(s.trackingAttraction, s.fastMotionAttraction, fast);
        const trackDamping = lerp(trackingDamping, fastDamping, fast);
        const k = lerp(formationK, trackK, formed) * suspension * (1 - letGo);
        const damping = lerp(lerp(formationDamping, trackDamping, formed), ambientDamping, letGo);
        const snap = lerp(trackingSnap, fastSnap, fast) * formed * (1 - trail) * (1 - letGo) * (1 - textDetach) *
          (1 - Math.min(1, e * s.gestureSnapRelief)) * suspension;
        const maxSpeed = lerp(formationMaxSpeed, trackingMaxSpeed, formed);
        const maxSpeedSq = maxSpeed * maxSpeed;
        this.motionPhaseCounts[motionPhaseIndex(formed, fast, letGo > 0)]++;

        for (let i = 0; i < substeps; i++) {
          velX = (velX + ((tx - x) * k + flow.sampleX * swirl) * h) * damping;
          velY = (velY + ((ty - y) * k + flow.sampleY * swirl) * h) * damping;
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
        if (!(textEnvelope > 0 && revealIndex >= 0)) {
          targetDistanceTotal += Math.hypot(tx - x, ty - y);
          targetDistanceSamples++;
        }

        const prox = cellProximity[c];
        const glowTarget = lerp(opacityFar, opacityClose, prox) * (cellEdge[c] === 1 ? s.edgeBrightness : 1);
        glow[p] += (glowTarget - glow[p]) * glowAlpha;
        proximity[p] += (prox - proximity[p]) * glowAlpha;
      } else {
        if (lt === 1) ambientVisible++;
        if (b > 0) b = Math.max(0, b - dispersionStep);
        else if (b < 0) b = 0;

        const sinceRelease = now - releasedAt[p];
        const dispersing = releasedAt[p] > 0 && sinceRelease < s.dispersionDuration ? 1 - sinceRelease / s.dispersionDuration : 0;
        flow.sample(x, y);
        const depth = 0.55 + sd * 0.75;
        const drift = s.ambientDrift * scale * depth * (1 + dispersing * 5);
        let ax = flow.sampleX * drift + (this.random() - 0.5) * s.ambientBrownian * scale;
        let ay = flow.sampleY * drift + (this.random() - 0.5) * s.ambientBrownian * scale;

        if (peopleCount === 0 && dispersing < 0.1) {
          // Tres pozos muy lentos comparten el mismo campo de flujo. Dan respiración y
          // profundidad al idle sin vecinos por partícula ni coste cuadrático.
          const layer = Math.min(2, (sd * 3) | 0);
          const anchorX = this.width * (0.22 + layer * 0.28 + Math.sin(time * 0.09 + layer * 2.1) * 0.055);
          const anchorY = this.height * (0.38 + (layer & 1) * 0.23 + Math.cos(time * 0.075 + layer * 1.7) * 0.07);
          const dx = anchorX - x;
          const dy = anchorY - y;
          const cohesionRadiusSq = (360 * scale) ** 2;
          const force = s.ambientCohesion / (1 + (dx * dx + dy * dy) / cohesionRadiusSq);
          ax += dx * force;
          ay += dy * force;
        }

        if (attraction > 0 && dispersing < 0.3 && field) {
          for (let k = 0; k < peopleCount; k++) {
            const dx = field.peopleX[k] - x;
            const dy = field.peopleY[k] - y;
            const distSq = dx * dx + dy * dy;
            const dist = Math.sqrt(distSq) + 0.001;
            const inner = dist < innerRadius ? dist / innerRadius : 1;
            const force = (attraction * scale * inner) / (1 + distSq / attractionRadiusSq);
            ax += (dx / dist) * force;
            ay += (dy / dist) * force;
            const wake = Math.max(0, 1 - distSq / motionRadiusSq);
            ax += field.peopleVx[k] * FRAME_MS * s.ambientMotionInfluence * wake;
            ay += field.peopleVy[k] * FRAME_MS * s.ambientMotionInfluence * wake;
          }
        }

        for (let i = 0; i < substeps; i++) {
          velX = (velX + ax * h) * ambientDamping;
          velY = (velY + ay * h) * ambientDamping;
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
        }
      }

      if (wavesActive) {
        for (let w = 0; w < MAX_WAVES; w++) {
          const age = now - this.waveStart[w];
          if (age < 0 || age > WAVE_LIFETIME_MS) continue;
          const dx = x - this.waveX[w];
          const dy = y - this.waveY[w];
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
          const angle = Math.atan2(dy, dx);
          const warp = waveWidth * s.waveOrganicWarp * (
            Math.sin(angle * 3.1 + phase[p] + age * 0.004) * 0.66 +
            Math.sin(angle * 5.3 - phase[p] * 0.7 - age * 0.0025) * 0.34
          );
          const offset = Math.abs(dist + warp - age * waveSpeed);
          if (offset >= waveWidth) continue;
          // Perfil coseno: frente suave, sin borde duro.
          const falloff = 0.5 + 0.5 * Math.cos((offset / waveWidth) * Math.PI);
          const life = 1 - age / WAVE_LIFETIME_MS;
          const envelope = life * life;
          const push = falloff * envelope * this.waveStrength[w] * scale * (m === BODY ? 1 : WAVE_AMBIENT_FACTOR);
          const curl = Math.sin(angle * 2 + phase[p] + age * 0.005) * push * 0.16;
          velX += (dx / dist) * push - (dy / dist) * curl;
          velY += (dy / dist) * push + (dx / dist) * curl;
          e = Math.max(e, falloff * envelope);
        }
      }

      px[p] = x;
      py[p] = y;
      vx[p] = velX;
      vy[p] = velY;
      bond[p] = b;
      excite[p] = e;

      const vis = b <= 0 ? 0 : b >= 1 ? 1 : b;
      const idleSize = sizeIdle * (0.55 + sd * 0.9);
      const twinkle = 0.78 + 0.22 * Math.sin(time * (0.32 + sd * 0.5) + phase[p]);
      let size = idleSize;
      let alpha = opacityIdle * twinkle;
      if (vis > 0) {
        const breathing = 1 + s.breathingAmount * Math.sin(time * 1.6 + phase[p]);
        const bodySize = lerp(sizeFar, sizeClose, proximity[p]) * (0.75 + sd * 0.5) * breathing;
        size = idleSize + (bodySize - idleSize) * vis;
        alpha = alpha + (glow[p] - alpha) * vis;
      }
      size *= scale * (1 + e * EXCITE_SIZE);
      alpha = (alpha + e * EXCITE_ALPHA) * l;
      if (alpha < 0.004) continue;

      renderData[out++] = x;
      renderData[out++] = y;
      renderData[out++] = size;
      renderData[out++] = alpha > 1 ? 1 : alpha;
    }

    this.renderCount = out / RENDER_STRIDE;
    this.bodyCount = bodyCount;
    this.ambientCount = ambientVisible;
    this.averageTargetDistance = targetDistanceSamples > 0 ? targetDistanceTotal / targetDistanceSamples : 0;
    let averageTrackSpeed = 0;
    if (field && field.peopleCount > 0) {
      for (let i = 0; i < field.peopleCount; i++) averageTrackSpeed += field.peopleSpeed[i] / 1000;
      averageTrackSpeed /= field.peopleCount;
    }
    this.estimatedTargetLagMs = averageTrackSpeed > 0.04
      ? Math.min(1000, this.averageTargetDistance / averageTrackSpeed)
      : 0;

    if (now - this.lastPopulationAt >= POPULATION_INTERVAL_MS) {
      this.lastPopulationAt = now;
      this.balanceAmbient(ambientVisible, peopleCount > 0);
    }
  }

  /** Onda expansiva local (p. ej. al levantar una mano). Coordenadas en px CSS. */
  emitWave(x: number, y: number, now: number, strength = 1): void {
    const w = this.waveCursor++ % MAX_WAVES;
    this.waveX[w] = x;
    this.waveY[w] = y;
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
    this.revealTarget.fill(-1);
    let revealCursor = 0;
    for (let p = 0; p < this.capacity; p++) {
      if (this.mode[p] !== BODY) continue;
      if (this.revealTargetCount > 0 && this.bond[p] > 0.72 && this.seed[p] < TEXT_PARTICLE_RATIO) {
        this.revealTarget[p] = (revealCursor * 37) % this.revealTargetCount;
        revealCursor++;
      }
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
      this.mode[p] = AMBIENT;
      this.cell[p] = -1;
      this.particlePersonId[p] = -1;
      this.retargetedAt[p] = -Infinity;
      this.releasedAt[p] = now;
    }
    this.cellOwner = new Int32Array(field.cellCount).fill(-1);
    this.fieldVersion = field.version;
  }

  private release(p: number, now: number): void {
    if (this.cell[p] >= 0) this.cellOwner[this.cell[p]] = -1;
    this.cell[p] = -1;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
    this.mode[p] = AMBIENT;
    this.releasedAt[p] = now;
    // Conserva el momentum y agrega un pequeño impulso: la silueta se fragmenta en lugar de apagarse.
    const angle = this.random() * TAU;
    const kick = this.settings.releaseKick * this.scale * (0.3 + 0.7 * this.random());
    this.vx[p] += Math.cos(angle) * kick;
    this.vy[p] += Math.sin(angle) * kick;
  }

  private spawnNear(p: number, x: number, y: number): void {
    const { min, max } = this.settings.spawnDistance;
    const angle = this.random() * TAU;
    const distance = lerp(min, max, this.random()) * this.scale;
    this.px[p] = x + Math.cos(angle) * distance;
    this.py[p] = y + Math.sin(angle) * distance;
    this.vx[p] = 0;
    this.vy[p] = 0;
    this.life[p] = 0;
    this.bond[p] = -this.random() * this.settings.formationStagger;
    this.glow[p] = this.settings.particleOpacity.far;
    this.proximity[p] = 0;
    this.excite[p] = 0;
    this.releasedAt[p] = 0;
    this.particlePersonId[p] = -1;
    this.retargetedAt[p] = -Infinity;
  }

  private spawnAmbient(p: number): void {
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
    this.mode[p] = AMBIENT;
  }

  private makeDormant(p: number): void {
    this.mode[p] = DORMANT;
    this.life[p] = 0;
    this.lifeTarget[p] = 0;
    this.cell[p] = -1;
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
        if (this.mode[p] !== AMBIENT || this.lifeTarget[p] !== 1) continue;
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

    for (let ring = 0; ring <= MAX_RINGS; ring++) {
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
