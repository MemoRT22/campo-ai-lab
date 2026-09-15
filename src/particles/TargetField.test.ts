import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { PersonInfo, VisionFrame } from '../vision/types';
import { TargetField } from './TargetField';

function frame(slot: number, id: number, x0: number, x1: number, y0 = 2, y1 = 9): VisionFrame {
  const width = 20;
  const height = 10;
  const personMap = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) personMap[y * width + x] = slot + 1;
  }
  const person: PersonInfo = {
    id,
    slot,
    x0: x0 / width,
    y0: y0 / height,
    x1: x1 / width,
    y1: y1 / height,
    cx: (x0 + x1) / (2 * width),
    cy: (y0 + y1) / (2 * height),
    area: ((x1 - x0) * (y1 - y0)) / (width * height),
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

function predictionField(): TargetField {
  const config = structuredClone(defaultConfig);
  config.camera.mirror = false;
  config.camera.fit = 'contain';
  config.particles.particleDensity = { far: 1, close: 1 };
  config.particles.bodyParticleBudget = config.particles.particleCount;
  const field = new TargetField(config);
  field.resize(200, 100);
  return field;
}

function predictionLength(field: TargetField): number {
  return Math.hypot(field.peoplePredictionX[0], field.peoplePredictionY[0]);
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
    expect(field.peopleSpeed[0]).toBeGreaterThan(0);
    expect(field.peoplePredictionActive[0]).toBe(1);
    expect(field.peoplePredictionX[0]).toBeGreaterThan(0);
    expect(Math.hypot(field.peoplePredictionX[0], field.peoplePredictionY[0])).toBeLessThanOrEqual(
      config.particles.predictionMaxDistance * 0.7 + 0.001,
    );

    // Un cambio brusco de dirección corta la predicción para no sobrepasar el cuerpo.
    field.update(frame(1, 11, 4, 10), 1099);
    expect(field.peoplePredictionActive[0]).toBe(0);
    expect(field.peoplePredictionX[0]).toBe(0);
  });
});

describe('TargetField prediction', () => {
  it('ignora un brazo que se extiende aunque el centro del cuerpo se mueva', () => {
    const field = predictionField();
    let t = 1000;
    for (let i = 0; i < 4; i++, t += 33) field.update(frame(0, 3, 6, 10), t);
    for (let i = 0; i < 3; i++, t += 33) {
      // Sólo crece el borde derecho: un brazo, no una traslación del cuerpo.
      field.update(frame(0, 3, 6, 12 + i * 2), t);
      expect(field.peopleSpeed[0]).toBeGreaterThan(0);
      expect(field.peoplePredictionActive[0]).toBe(0);
      expect(predictionLength(field)).toBe(0);
    }
  });

  it('reduce el adelanto de inmediato al frenar y lo apaga en un giro brusco', () => {
    const field = predictionField();
    let t = 1000;
    let x = 0;
    for (let i = 0; i < 8; i++, t += 33, x += 2) field.update(frame(0, 5, x, x + 4), t);
    const steady = predictionLength(field);
    expect(field.peoplePredictionActive[0]).toBe(1);
    expect(steady).toBeGreaterThan(0);

    // Avanza la mitad: frenado.
    field.update(frame(0, 5, x - 1, x + 3), t);
    expect(predictionLength(field)).toBeLessThan(steady * 0.75);

    // Giro de 90°: deja de avanzar en X y baja en Y.
    t += 33;
    field.update(frame(0, 5, x - 1, x + 3, 3, 9), t);
    expect(predictionLength(field)).toBe(0);
  });
});
