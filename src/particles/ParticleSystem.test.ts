import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { VisionFrame } from '../vision/types';
import { GROUP_PAIR, GroupInteraction } from './GroupInteraction';
import { ParticleSystem } from './ParticleSystem';
import { TargetField } from './TargetField';

const BODY = 2;

interface ParticleInternals {
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  life: Float32Array;
  bond: Float32Array;
  glow: Float32Array;
  cell: Int32Array;
  mode: Uint8Array;
  particlePersonId: Int32Array;
  cellOwner: Int32Array;
  revealTarget: Int32Array;
}

function internals(system: ParticleSystem): ParticleInternals {
  return system as unknown as ParticleInternals;
}

function activateRectangle(
  field: TargetField,
  personId: number,
  col0: number,
  col1: number,
  row0: number,
  row1: number,
  dx = 0,
  dy = 0,
): void {
  field.active.fill(0);
  field.cellPersonId.fill(-1);
  field.peopleCount = 1;
  field.peopleId[0] = personId;
  field.peopleDx[0] = dx;
  field.peopleDy[0] = dy;
  let count = 0;
  for (let row = row0; row < row1; row++) {
    for (let col = col0; col < col1; col++) {
      const cell = row * field.cols + col;
      field.active[cell] = 1;
      field.cellPersonId[cell] = personId;
      field.cellProximity[cell] = 0.5;
      field.activeList[count++] = cell;
    }
  }
  field.activeCount = count;
}

function visionFrame(personId: number | null): VisionFrame {
  const width = 20;
  const height = 10;
  const personMap = new Uint8Array(width * height);
  if (personId !== null) {
    for (let y = 2; y < 9; y++) for (let x = 5; x < 11; x++) personMap[y * width + x] = 1;
  }
  return {
    width,
    height,
    personMap,
    people: personId === null ? [] : [{
      id: personId,
      slot: 0,
      x0: 0.25,
      y0: 0.2,
      x1: 0.55,
      y1: 0.9,
      cx: 0.4,
      cy: 0.55,
      area: 0.21,
      proximity: 0.5,
      confirmed: true,
    }],
    timestamp: 0,
    inferenceMs: 0,
    processingMs: 0,
    poses: [],
    poseTimestamp: null,
    poseInferenceMs: 0,
  };
}

describe('ParticleSystem mirror tracking', () => {
  it('traslada la silueta completa al caminar, con poco lag y sin overshoot al detenerse', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 400;
    config.particles.bodyParticleBudget = 400;
    config.particles.idleParticleCount = 0;
    config.particles.particleSpacing = 12;
    config.particles.particleNoise = 0;
    config.particles.cellJitter = 0;
    config.particles.predictionMs = 0;
    config.particles.interpolationMaxMs = 0;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(480, 180);
    system.resize(480, 180);

    activateRectangle(field, 9, 4, 12, 4, 16);
    system.applyTargets(field, 1000);
    const state = internals(system);
    const body: number[] = [];
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      body.push(p);
      state.bond[p] = 1;
      state.life[p] = 1;
      state.px[p] = field.cellX[state.cell[p]];
      state.py[p] = field.cellY[state.cell[p]];
      state.vx[p] = 0;
      state.vy[p] = 0;
    }

    let now = 1000;
    const frameMs = 1000 / 60;
    const lag: number[] = [];
    for (let step = 1; step <= 20; step++) {
      activateRectangle(field, 9, 4 + step, 12 + step, 4, 16, field.spacing, 0);
      field.peopleCellShiftX[0] = 1;
      now += frameMs;
      system.applyTargets(field, now);
      expect(system.shiftedLastFrame).toBe(body.length);
      expect(system.transportedLastFrame).toBe(0);
      expect(system.releasedLastFrame).toBe(0);
      for (let i = 0; i < 2; i++) {
        now += frameMs;
        system.step(frameMs / 1000, now);
        if (step > 5) lag.push(system.averageTargetDistance);
      }
    }
    const meanLag = lag.reduce((sum, value) => sum + value, 0) / lag.length;
    expect(meanLag).toBeLessThan(field.spacing * 0.6);

    field.peopleCellShiftX[0] = 0;
    let overshoot = 0;
    for (let i = 0; i < 40; i++) {
      now += frameMs;
      if (i % 2 === 0) system.applyTargets(field, now);
      system.step(frameMs / 1000, now);
      for (const p of body) overshoot = Math.max(overshoot, state.px[p] - field.cellX[state.cell[p]]);
    }
    expect(overshoot).toBeLessThan(1);
    expect(body.every((p) => state.mode[p] === BODY)).toBe(true);
  });
});

describe('ParticleSystem BOTH_HANDS_UP reveal', () => {
  it('desprende una fracción hacia el texto sin perder celdas ni tracking y la regresa al cuerpo', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 1200;
    config.particles.bodyParticleBudget = 1200;
    config.particles.idleParticleCount = 0;
    config.particles.particleSpacing = 12;
    config.particles.particleNoise = 0;
    config.particles.cellJitter = 0;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(480, 360);
    system.resize(480, 360);

    activateRectangle(field, 3, 10, 34, 8, 36);
    system.applyTargets(field, 1000);
    const state = internals(system);
    const body: number[] = [];
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      body.push(p);
      state.bond[p] = 1;
      state.life[p] = 1;
      state.px[p] = field.cellX[state.cell[p]];
      state.py[p] = field.cellY[state.cell[p]];
    }
    const cells = body.map((p) => state.cell[p]);

    const p = config.particles;
    let now = 2000;
    system.celebrate(now, p.revealExpandMs + p.revealSuspendMs + p.revealRecoverMs, 3);
    const textX = 420;
    const textY = 40;
    system.startTextFlight(new Float32Array([textX, textY, textX + 10, textY]), now, {
      startAt: system.celebrationPeakAt,
      travelMs: 400,
      holdMs: 600,
      returnMs: 500,
    });

    const frameMs = 1000 / 60;
    const advanceTo = (time: number) => {
      while (now < time) {
        now += frameMs;
        system.step(frameMs / 1000, now);
      }
    };
    const onText = () => body.filter((q) => Math.hypot(state.px[q] - textX, state.py[q] - textY) < 30);

    advanceTo(system.celebrationPeakAt + 400 + 500);
    const detached = onText().length;
    expect(detached / body.length).toBeGreaterThan(p.textParticleRatio * 0.5);
    expect(detached / body.length).toBeLessThan(p.textParticleRatio * 1.5);
    expect(body.map((q) => state.cell[q])).toEqual(cells);
    expect(body.every((q) => state.mode[q] === BODY)).toBe(true);

    // El cuerpo sigue su tracking durante el reveal: las demás partículas permanecen en su celda.
    const staying = body.filter((q) => Math.hypot(state.px[q] - textX, state.py[q] - textY) >= 30);
    const stayingDistance = staying.reduce((sum, q) => sum + Math.hypot(state.px[q] - field.cellX[state.cell[q]], state.py[q] - field.cellY[state.cell[q]]), 0) / staying.length;
    expect(stayingDistance).toBeLessThan(field.spacing);

    advanceTo(system.celebrationPeakAt + 400 + 600 + 500 + 2500);
    expect(onText()).toHaveLength(0);
    const returned = body.reduce((sum, q) => sum + Math.hypot(state.px[q] - field.cellX[state.cell[q]], state.py[q] - field.cellY[state.cell[q]]), 0) / body.length;
    expect(returned).toBeLessThan(field.spacing * 0.5);
  });
});

describe('ParticleSystem temporal transport', () => {
  it('reutiliza las mismas partículas y conserva su estado al mover una persona', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 80;
    config.particles.bodyParticleBudget = 80;
    config.particles.idleParticleCount = 0;
    config.particles.particleSpacing = 12;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(240, 180);
    system.resize(240, 180);

    activateRectangle(field, 7, 3, 8, 3, 11);
    system.applyTargets(field, 1000);
    expect(system.formedLastFrame).toBe(40);

    const state = internals(system);
    const bodyParticles: number[] = [];
    const snapshots = new Map<number, number[]>();
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      bodyParticles.push(p);
      state.px[p] = 20 + p;
      state.py[p] = 40 + p * 0.5;
      state.vx[p] = 1.25 + p * 0.01;
      state.vy[p] = -0.75 - p * 0.01;
      state.life[p] = 0.83;
      state.bond[p] = 0.91;
      state.glow[p] = 0.72;
      snapshots.set(p, [state.px[p], state.py[p], state.vx[p], state.vy[p], state.life[p], state.bond[p], state.glow[p]]);
    }

    const shift = field.spacing * 2;
    activateRectangle(field, 7, 5, 10, 3, 11, shift, 0);
    system.applyTargets(field, 1033);

    expect(system.transportedLastFrame).toBe(16);
    expect(system.formedLastFrame).toBe(0);
    expect(system.releasedLastFrame).toBe(0);
    expect(bodyParticles.filter((p) => state.mode[p] === BODY)).toEqual(bodyParticles);
    for (const p of bodyParticles) {
      expect(state.particlePersonId[p]).toBe(7);
      expect([state.px[p], state.py[p], state.vx[p], state.vy[p], state.life[p], state.bond[p], state.glow[p]]).toEqual(snapshots.get(p));
    }
    for (let k = 0; k < field.activeCount; k++) {
      const owner = state.cellOwner[field.activeList[k]];
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(state.particlePersonId[owner]).toBe(7);
    }

    const cellsBeforeReveal = bodyParticles.map((p) => state.cell[p]);
    const bondsBeforeReveal = bodyParticles.map((p) => state.bond[p]);
    system.setRevealTargets(new Float32Array([80, 70, 100, 70, 120, 70]));
    system.celebrate(1100, 1400, 3);
    expect(bodyParticles.map((p) => state.cell[p])).toEqual(cellsBeforeReveal);
    expect(bodyParticles.map((p) => state.bond[p])).toEqual(bondsBeforeReveal);
    expect(bodyParticles.filter((p) => state.revealTarget[p] >= 0).length).toBeGreaterThan(0);
  });

  it('sólo dispersa BODY cuando desaparece el track y no los reutiliza en el mismo frame', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 40;
    config.particles.bodyParticleBudget = 40;
    config.particles.idleParticleCount = 0;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(180, 140);
    system.resize(180, 140);

    activateRectangle(field, 2, 2, 6, 2, 7);
    system.applyTargets(field, 1000);
    const bodyCount = system.formedLastFrame;

    field.active.fill(0);
    field.cellPersonId.fill(-1);
    field.activeCount = 0;
    field.peopleCount = 0;
    system.applyTargets(field, 1033);

    expect(system.transportedLastFrame).toBe(0);
    expect(system.formedLastFrame).toBe(0);
    expect(system.releasedLastFrame).toBe(bodyCount);
    expect(Array.from(internals(system).mode).filter((mode) => mode === BODY)).toHaveLength(0);
  });

  it('tolera una omisión corta de segmentación y después ejecuta departure', () => {
    const config = structuredClone(defaultConfig);
    config.camera.mirror = false;
    config.camera.fit = 'contain';
    config.particles.particleCount = 300;
    config.particles.bodyParticleBudget = 300;
    config.particles.idleParticleCount = 0;
    config.particles.particleDensity = { far: 1, close: 1 };
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(200, 100);
    system.resize(200, 100);

    field.update(visionFrame(4), 1000);
    system.applyTargets(field, 1000);
    const bodyCount = system.formedLastFrame;
    expect(bodyCount).toBeGreaterThan(0);

    field.update(visionFrame(null), 1033);
    system.applyTargets(field, 1033);
    expect(system.heldLastFrame).toBe(bodyCount);
    expect(system.releasedLastFrame).toBe(0);
    expect(Array.from(internals(system).mode).filter((mode) => mode === BODY)).toHaveLength(bodyCount);

    const departureAt = 1000 + config.particles.occlusionGraceMs + 1;
    field.update(visionFrame(null), departureAt);
    system.applyTargets(field, departureAt);
    expect(system.heldLastFrame).toBe(0);
    expect(system.releasedLastFrame).toBe(bodyCount);
    expect(Array.from(internals(system).mode).filter((mode) => mode === BODY)).toHaveLength(0);
  });

  it('al irse una persona la silueta conserva forma y momentum y se desprende de forma escalonada', () => {
    const config = structuredClone(defaultConfig);
    config.camera.mirror = false;
    config.camera.fit = 'contain';
    config.particles.particleCount = 300;
    config.particles.bodyParticleBudget = 300;
    config.particles.idleParticleCount = 0;
    config.particles.particleDensity = { far: 1, close: 1 };
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(200, 100);
    system.resize(200, 100);

    field.update(visionFrame(4), 1000);
    system.applyTargets(field, 1000);
    const bodyCount = system.formedLastFrame;
    const state = internals(system);
    for (let p = 0; p < system.capacity; p++) {
      state.vx[p] = 0;
      state.vy[p] = 0;
    }

    const departureAt = 1000 + config.particles.occlusionGraceMs + 1;
    field.update(visionFrame(null), departureAt);
    system.applyTargets(field, departureAt);
    expect(system.releasedLastFrame).toBe(bodyCount);

    const snapshotX = Array.from(state.px);
    const snapshotY = Array.from(state.py);
    system.step(1 / 60, departureAt + 16);
    const initiallyDetaching = system.detachingCount;
    expect(initiallyDetaching).toBeGreaterThan(bodyCount * 0.5);
    const detachAt = (state as unknown as { detachAt: Float64Array }).detachAt;
    let checked = 0;
    for (let p = 0; p < system.capacity; p++) {
      const visible = snapshotX[p] >= 0 && snapshotX[p] <= 200 && snapshotY[p] >= 0 && snapshotY[p] <= 100;
      // Una partícula que aún no se desprende no recibe flujo, ruido ni impulso.
      if (visible && state.mode[p] !== BODY && detachAt[p] > 0) {
        expect(state.px[p]).toBeCloseTo(snapshotX[p], 5);
        expect(state.py[p]).toBeCloseTo(snapshotY[p], 5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);

    system.step(1 / 60, departureAt + config.particles.departureStaggerMs * 0.5);
    expect(system.detachingCount).toBeGreaterThan(0);
    expect(system.detachingCount).toBeLessThan(initiallyDetaching);

    system.step(1 / 60, departureAt + config.particles.departureStaggerMs + 20);
    expect(system.detachingCount).toBe(0);
  });
});

function activatePeople(field: TargetField, rects: Array<{ id: number; col0: number; col1: number; row0: number; row1: number }>): void {
  field.active.fill(0);
  field.cellPersonId.fill(-1);
  field.peopleCount = rects.length;
  let count = 0;
  rects.forEach((rect, k) => {
    field.peopleId[k] = rect.id;
    field.peopleDx[k] = 0;
    field.peopleDy[k] = 0;
    let sumX = 0;
    let sumY = 0;
    let cells = 0;
    for (let row = rect.row0; row < rect.row1; row++) {
      for (let col = rect.col0; col < rect.col1; col++) {
        const cell = row * field.cols + col;
        field.active[cell] = 1;
        field.cellPersonId[cell] = rect.id;
        field.cellProximity[cell] = 0.5;
        field.cellEdge[cell] = row === rect.row0 || row === rect.row1 - 1 || col === rect.col0 || col === rect.col1 - 1 ? 1 : 0;
        field.activeList[count++] = cell;
        sumX += field.cellX[cell];
        sumY += field.cellY[cell];
        cells++;
      }
    }
    field.peopleX[k] = sumX / cells;
    field.peopleY[k] = sumY / cells;
  });
  field.activeCount = count;
}

describe('ParticleSystem formation wow', () => {
  it('forma primero el centro del cuerpo, sigue a la persona mientras se forma y se fija', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 900;
    config.particles.bodyParticleBudget = 900;
    config.particles.idleParticleCount = 0;
    config.particles.particleSpacing = 12;
    config.particles.particleNoise = 0;
    config.particles.cellJitter = 0;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(640, 400);
    system.resize(640, 400);

    activatePeople(field, [{ id: 5, col0: 10, col1: 30, row0: 4, row1: 28 }]);
    system.applyTargets(field, 1000);
    const state = internals(system);
    let innerDelay = 0;
    let inner = 0;
    let outerDelay = 0;
    let outer = 0;
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      const c = state.cell[p];
      const distance = Math.hypot(field.cellX[c] - field.peopleX[0], field.cellY[c] - field.peopleY[0]);
      if (distance < 60) {
        innerDelay += -state.bond[p];
        inner++;
      } else if (distance > 120) {
        outerDelay += -state.bond[p];
        outer++;
      }
    }
    expect(innerDelay / inner).toBeLessThan((outerDelay / outer) * 0.6);

    // La persona camina durante la formación: el target nunca se congela.
    const frameMs = 1000 / 60;
    let now = 1000;
    let shift = 0;
    while (now < 1000 + 1500) {
      now += frameMs;
      if (Math.round((now - 1000) / frameMs) % 6 === 0 && shift < 12) {
        shift++;
        activatePeople(field, [{ id: 5, col0: 10 + shift, col1: 30 + shift, row0: 4, row1: 28 }]);
        field.peopleCellShiftX[0] = 1;
        system.applyTargets(field, now);
        field.peopleCellShiftX[0] = 0;
      }
      system.step(frameMs / 1000, now);
    }
    expect(system.formation.isLocked(0)).toBe(true);
    expect(system.formationProgress).toBe(1);
    expect(system.formation.lockedAtOf(0) - 1000).toBeLessThan(1100);
    let distance = 0;
    let body = 0;
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      distance += Math.hypot(state.px[p] - field.cellX[state.cell[p]], state.py[p] - field.cellY[state.cell[p]]);
      body++;
    }
    expect(distance / body).toBeLessThan(field.spacing * 0.5);
  });
});

describe('ParticleSystem living body', () => {
  function simulate(effects: boolean) {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 500;
    config.particles.bodyParticleBudget = 500;
    config.particles.idleParticleCount = 0;
    config.particles.particleSpacing = 12;
    config.particles.predictionMs = 0;
    config.particles.interpolationMaxMs = 0;
    if (!effects) {
      config.particles.livingBody.trailRatioEdge = 0;
      config.particles.livingBody.trailRatioInterior = 0;
      config.particles.livingBody.shedRatio = 0;
    }
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    field.resize(720, 240);
    system.resize(720, 240);
    const rect = (offset: number) => ({ id: 2, col0: 6 + offset, col1: 16 + offset, row0: 4, row1: 16 });
    activatePeople(field, [rect(0)]);
    system.applyTargets(field, 1000);
    const state = internals(system);
    for (let p = 0; p < system.capacity; p++) {
      if (state.mode[p] !== BODY) continue;
      state.bond[p] = 1;
      state.life[p] = 1;
      state.px[p] = field.cellX[state.cell[p]];
      state.py[p] = field.cellY[state.cell[p]];
    }

    const frameMs = 1000 / 60;
    let now = 1000;
    let maxTrail = 0;
    let maxOffset = 0;
    const offX = (system as unknown as { offX: Float32Array }).offX;
    const offY = (system as unknown as { offY: Float32Array }).offY;
    // Movimiento rápido: dos celdas por frame de visión (~720 px/s).
    for (let step = 1; step <= 18; step++) {
      activatePeople(field, [rect(step * 2)]);
      field.peopleCellShiftX[0] = 2;
      now += frameMs;
      system.applyTargets(field, now);
      field.peopleCellShiftX[0] = 0;
      for (let i = 0; i < 2; i++) {
        if (i === 1) now += frameMs;
        system.step(frameMs / 1000, now);
        maxTrail = Math.max(maxTrail, system.trailCount + system.shedCount);
        for (let p = 0; p < system.capacity; p++) maxOffset = Math.max(maxOffset, Math.hypot(offX[p], offY[p]));
      }
    }
    const moving = { x: Array.from(state.px), y: Array.from(state.py), lag: system.averageTargetDistance };
    for (let i = 0; i < 40; i++) {
      now += frameMs;
      system.step(frameMs / 1000, now);
    }
    return { system, config, moving, maxTrail, maxOffset, settled: system.trailCount + system.shedCount };
  }

  it('la estela es un offset visual: el núcleo espejo es idéntico con o sin efectos', () => {
    const withEffects = simulate(true);
    const withoutEffects = simulate(false);
    expect(withEffects.moving.x).toEqual(withoutEffects.moving.x);
    expect(withEffects.moving.y).toEqual(withoutEffects.moving.y);
    expect(withEffects.moving.lag).toBe(withoutEffects.moving.lag);

    const { livingBody } = withEffects.config.particles;
    expect(withEffects.maxTrail).toBeGreaterThan(0);
    expect(withEffects.maxTrail).toBeLessThan(withEffects.system.bodyCount * 0.3);
    expect(withEffects.maxOffset).toBeLessThanOrEqual(Math.max(livingBody.trailMaxDistance, livingBody.shedMaxDistance) + 1e-3);
    expect(withoutEffects.maxTrail).toBe(0);
  });

  it('la microestela regresa al cuerpo al detenerse: sin ghosting permanente', () => {
    const { settled, system } = simulate(true);
    expect(settled).toBe(0);
    expect(system.coreCount).toBe(system.bodyCount);
  });
});

describe('ParticleSystem group bridges', () => {
  it('usa sólo partículas del campo, dentro del presupuesto, sin quitar partículas a los cuerpos', () => {
    const config = structuredClone(defaultConfig);
    config.particles.particleCount = 2400;
    config.particles.bodyParticleBudget = 1200;
    config.particles.idleParticleCount = 900;
    config.particles.ambientPresenceRatio = 1;
    config.particles.particleSpacing = 12;
    const field = new TargetField(config);
    const system = new ParticleSystem(config.particles);
    const group = new GroupInteraction(config.particles.groupInteraction);
    system.setGroup(group);
    field.resize(960, 540);
    system.resize(960, 540);

    const frameMs = 1000 / 60;
    let now = 0;
    // Campo ambiental inicial.
    for (let i = 0; i < 60; i++) {
      now += frameMs;
      system.step(frameMs / 1000, now);
    }
    activatePeople(field, [
      { id: 1, col0: 10, col1: 20, row0: 12, row1: 36 },
      { id: 2, col0: 48, col1: 58, row0: 12, row1: 36 },
    ]);
    system.applyTargets(field, now);
    const state = internals(system);
    const bridge = (system as unknown as { bridgeSlot: Int8Array }).bridgeSlot;
    let maxBridge = 0;
    for (let i = 0; i < 360; i++) {
      now += frameMs;
      if (i % 2 === 0) system.applyTargets(field, now);
      group.update(field, now, 1);
      system.step(frameMs / 1000, now);
      const budget = group.particleBudget.reduce((sum, value) => sum + value, 0);
      expect(system.bridgeParticleCount).toBeLessThanOrEqual(Math.max(budget, config.particles.groupInteraction.pairParticleBudget));
      maxBridge = Math.max(maxBridge, system.bridgeParticleCount);
      for (let p = 0; p < system.capacity; p++) {
        if (state.mode[p] === BODY) expect(bridge[p]).toBe(-1);
      }
      expect(system.bodyCount).toBe(field.activeCount);
    }
    expect(group.mode).toBe(GROUP_PAIR);
    expect(maxBridge).toBeGreaterThan(0);
  });
});
