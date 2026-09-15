import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
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
});
