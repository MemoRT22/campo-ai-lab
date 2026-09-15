import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { PersonInfo, VisionFrame } from '../vision/types';
import { TargetField } from './TargetField';

function frame(slot: number, id: number, x0: number, x1: number): VisionFrame {
  const width = 20;
  const height = 10;
  const personMap = new Uint8Array(width * height);
  for (let y = 2; y < 9; y++) {
    for (let x = x0; x < x1; x++) personMap[y * width + x] = slot + 1;
  }
  const person: PersonInfo = {
    id,
    slot,
    x0: x0 / width,
    y0: 0.2,
    x1: x1 / width,
    y1: 0.9,
    cx: (x0 + x1) / (2 * width),
    cy: 0.55,
    area: ((x1 - x0) * 7) / (width * height),
    proximity: 0.5,
    confirmed: true,
  };
  return {
    width,
    height,
    personMap,
    people: [person],
    timestamp: 0,
    inferenceMs: 0,
    processingMs: 0,
    poses: [],
    poseTimestamp: null,
    poseInferenceMs: 0,
  };
}

describe('TargetField temporal ownership', () => {
  it('propaga el personId estable aunque cambie el slot y calcula el desplazamiento', () => {
    const config = structuredClone(defaultConfig);
    config.camera.mirror = false;
    config.camera.fit = 'contain';
    config.particles.particleDensity = { far: 1, close: 1 };
    config.particles.bodyParticleBudget = config.particles.particleCount;
    const field = new TargetField(config);
    field.resize(200, 100);

    field.update(frame(0, 11, 4, 10), 1000);
    expect(field.peopleId[0]).toBe(11);
    expect(field.peopleDx[0]).toBe(0);
    for (let k = 0; k < field.activeCount; k++) expect(field.cellPersonId[field.activeList[k]]).toBe(11);

    field.update(frame(1, 11, 4, 10), 1033);
    expect(field.peopleId[0]).toBe(11);
    expect(field.peopleDx[0]).toBeCloseTo(0);
    for (let k = 0; k < field.activeCount; k++) expect(field.cellPersonId[field.activeList[k]]).toBe(11);

    field.update(frame(1, 11, 6, 12), 1066);
    expect(field.peopleId[0]).toBe(11);
    expect(field.peopleDx[0]).toBeGreaterThan(0);
    expect(field.peopleDy[0]).toBeCloseTo(0);
  });
});
