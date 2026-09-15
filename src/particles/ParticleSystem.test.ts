import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { VisionFrame } from '../vision/types';
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
});
