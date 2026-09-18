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

describe('TargetField silhouette detail', () => {
  const MW = 40;
  const MH = 20;

  function contourConfig() {
    const config = structuredClone(defaultConfig);
    config.camera.mirror = false;
    config.camera.fit = 'contain';
    config.particles.particleDensity = { far: 1, close: 1 };
    config.particles.bodyParticleBudget = 100000;
    return config;
  }

  function contourFrame(confidenceAt: (x: number, y: number) => number): VisionFrame {
    const personMap = new Uint8Array(MW * MH);
    const confidenceMap = new Uint8Array(MW * MH);
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const value = Math.max(0, Math.min(1, confidenceAt(x + 0.5, y + 0.5)));
        confidenceMap[y * MW + x] = Math.round(value * 255);
        if (value > 0.4) personMap[y * MW + x] = 1;
      }
    }
    const person: PersonInfo = { id: 1, slot: 0, x0: 0, y0: 0.2, x1: 0.6, y1: 0.8, cx: 0.3, cy: 0.5, area: 0.36, proximity: 0.5, confirmed: true };
    return { width: MW, height: MH, personMap, confidenceMap, people: [person], timestamp: 0, inferenceMs: 0, processingMs: 0, poses: [], poseTimestamp: null, poseInferenceMs: 0 };
  }

  /** Borde vertical suave en x = 20.3 px de máscara, dentro de una banda horizontal. */
  const softEdge = (x: number, y: number) => (y > 4 && y < 16 ? 0.5 + (20.3 - x) * 0.5 : 0);

  function edgeError(snap: number): number {
    const config = contourConfig();
    config.particles.silhouette.edgeSnap = snap;
    const field = new TargetField(config);
    field.resize(400, 200);
    field.update(contourFrame(softEdge), 1000);
    let worst = 0;
    let samples = 0;
    for (let k = 0; k < field.activeCount; k++) {
      const c = field.activeList[k];
      if (field.cellEdge[c] !== 1 || field.cellX[c] < 150 || field.cellY[c] < 70 || field.cellY[c] > 130) continue;
      worst = Math.max(worst, Math.abs(field.cellX[c] + field.cellOffsetX[c] - 203));
      samples++;
    }
    expect(samples).toBeGreaterThan(5);
    return worst;
  }

  it('coloca el borde sobre el contorno subpíxel en lugar del centro de la celda', () => {
    const field = new TargetField(contourConfig());
    field.resize(400, 200);
    const snapped = edgeError(1);
    const unsnapped = edgeError(0);
    expect(snapped).toBeLessThan(0.5);
    expect(unsnapped).toBeGreaterThan(snapped);
    expect(snapped).toBeLessThan(field.spacing * 0.2);
  });

  it('una celda encendida no parpadea con variaciones pequeñas de confianza', () => {
    const config = contourConfig();
    const { contourThreshold, contourHysteresis } = config.particles.silhouette;
    const field = new TargetField(config);
    field.resize(400, 200);
    const block = (level: number) => (x: number, y: number) => (x > 8 && x < 24 && y > 4 && y < 16 ? level : 0);
    // Celdas a más de un px de máscara del borde del bloque (el contorno interpolado sí se mueve).
    const core = () => {
      let count = 0;
      for (let k = 0; k < field.activeCount; k++) {
        const c = field.activeList[k];
        const mx = field.cellX[c] / 10;
        const my = field.cellY[c] / 10;
        if (mx > 10 && mx < 22 && my > 6 && my < 14) count++;
      }
      return count;
    };
    field.update(contourFrame(block(0.9)), 1000);
    const initial = core();
    expect(initial).toBeGreaterThan(0);

    // Bajo el umbral de encendido pero sobre el de apagado: la silueta se conserva.
    field.update(contourFrame(block(contourThreshold - contourHysteresis * 0.5)), 1033);
    expect(core()).toBe(initial);
    field.update(contourFrame(block(contourThreshold - contourHysteresis * 1.5)), 1066);
    expect(field.activeCount).toBe(0);
    // Tras apagarse, la misma confianza intermedia ya no basta para encender.
    field.update(contourFrame(block(contourThreshold - contourHysteresis * 0.5)), 1100);
    expect(field.activeCount).toBe(0);
  });

  it('con presupuesto insuficiente aclara el interior pero conserva todo el contorno', () => {
    const shape = (x: number, y: number) => (Math.hypot(x - 15, (y - 10) * 1.4) < 8 ? 1 : 0);
    const full = new TargetField(contourConfig());
    full.resize(400, 200);
    full.update(contourFrame(shape), 1000);
    const edges = Array.from(full.activeList.subarray(0, full.activeCount)).filter((c) => full.cellEdge[c] === 1);
    expect(edges.length).toBeGreaterThan(20);

    const config = contourConfig();
    config.particles.bodyParticleBudget = Math.round(full.activeCount * 0.4);
    const limited = new TargetField(config);
    limited.resize(400, 200);
    for (let i = 0; i < 20; i++) limited.update(contourFrame(shape), 1000 + i * 33);
    expect(limited.activeCount).toBeLessThan(full.activeCount * 0.75);
    expect(edges.every((c) => limited.active[c] === 1)).toBe(true);
  });

  it('sin mapa de confianza conserva el muestreo binario anterior', () => {
    const field = new TargetField(contourConfig());
    field.resize(400, 200);
    const binary = contourFrame((x, y) => (x > 8 && x < 24 && y > 4 && y < 16 ? 1 : 0));
    delete binary.confidenceMap;
    field.update(binary, 1000);
    expect(field.activeCount).toBeGreaterThan(0);
    for (let k = 0; k < field.activeCount; k++) expect(field.cellOffsetX[field.activeList[k]]).toBe(0);
  });
});

describe('TargetField dedos', () => {
  const MW = 80;
  const MH = 45;
  /** La máscara general sólo ve un "mitón": un disco donde debería haber dedos, más el antebrazo. */
  const mitten = (x: number, y: number) => (Math.hypot(x - 40, y - 23) < 5.5 || (x > 37 && x < 43 && y > 30) ? 1 : 0);

  /** Mano abierta con cuatro dedos rectos separados 2.4 px de máscara. */
  function openHand(): Float32Array {
    const points = new Float32Array(42);
    const put = (index: number, x: number, y: number) => {
      points[index * 2] = x / MW;
      points[index * 2 + 1] = y / MH;
    };
    put(0, 40, 30);
    put(1, 43.5, 29);
    put(2, 45.5, 27.5);
    put(3, 47, 26);
    put(4, 48.5, 24.5);
    [36.4, 38.8, 41.2, 43.6].forEach((x, finger) => {
      put(5 + finger * 4, x, 24);
      put(6 + finger * 4, x, 21);
      put(7 + finger * 4, x, 18);
      put(8 + finger * 4, x, 15);
    });
    return points;
  }

  function handFrame(handTimestamp: number | null): VisionFrame {
    const personMap = new Uint8Array(MW * MH);
    const confidenceMap = new Uint8Array(MW * MH);
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const value = mitten(x + 0.5, y + 0.5);
        confidenceMap[y * MW + x] = Math.round(value * 255);
        if (value > 0.4) personMap[y * MW + x] = 1;
      }
    }
    const person: PersonInfo = { id: 4, slot: 0, x0: 0.4, y0: 0.3, x1: 0.62, y1: 1, cx: 0.5, cy: 0.6, area: 0.2, proximity: 0.5, confirmed: true };
    return {
      width: MW,
      height: MH,
      personMap,
      confidenceMap,
      people: [person],
      hands: handTimestamp === null
        ? []
        : [{ personId: 4, timestamp: handTimestamp, landmarks: openHand(), score: 0.9, roi: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 }, mask: null, maskWidth: 0, maskHeight: 0 }],
      timestamp: 0,
      inferenceMs: 0,
      processingMs: 0,
      poses: [],
      poseTimestamp: null,
      poseInferenceMs: 0,
    };
  }

  function fieldWithHands(handTimestamp: number | null, now = 1000) {
    const config = structuredClone(defaultConfig);
    config.hands.enabled = true;
    config.camera.mirror = false;
    config.camera.fit = 'contain';
    config.particles.particleDensity = { far: 1, close: 1 };
    config.particles.bodyParticleBudget = 100000;
    const field = new TargetField(config);
    field.resize(800, 450);
    field.update(handFrame(handTimestamp), now);
    return field;
  }

  /** ¿Está encendida la celda más cercana a un punto de la máscara? */
  function activeAt(field: TargetField, maskX: number, maskY: number): boolean {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < field.cellCount; i++) {
      const distance = Math.hypot(field.cellX[i] - maskX * 10, field.cellY[i] - maskY * 10);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return field.active[best] === 1;
  }

  it('abre los huecos entre dedos y dibuja las puntas fuera de la máscara general', () => {
    const withHand = fieldWithHands(1000);
    expect(withHand.handsApplied).toBe(1);
    expect(withHand.handCells).toBeGreaterThan(0);
    // Hueco entre el dedo medio y el anular: la máscara general lo daba por relleno.
    expect(activeAt(withHand, 40, 21)).toBe(false);
    // Punta del dedo medio: fuera del disco de la máscara general, pero es mano.
    expect(activeAt(withHand, 38.8, 15.2)).toBe(true);
    // El antebrazo sigue gobernado por la máscara general: la mano no se desprende del brazo.
    expect(activeAt(withHand, 40, 34)).toBe(true);
  });

  it('sin manos la silueta queda como el mitón de la máscara general', () => {
    const withoutHand = fieldWithHands(null);
    expect(withoutHand.handsApplied).toBe(0);
    expect(activeAt(withoutHand, 40, 21)).toBe(true);
    expect(activeAt(withoutHand, 38.8, 15.2)).toBe(false);
  });

  it('una observación vieja deja de influir en vez de congelar los dedos', () => {
    const stale = fieldWithHands(1000, 1000 + defaultConfig.hands.maxAgeMs + 50);
    expect(stale.handsApplied).toBe(0);
    expect(activeAt(stale, 40, 21)).toBe(true);
    expect(activeAt(stale, 38.8, 15.2)).toBe(false);
  });
});
