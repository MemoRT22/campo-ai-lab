import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { HandShape, capsuleDistance, cropToCamera, fitRoi, roiFromHand, roiFromPose, sampleUint8 } from './handGeometry';
import type { PoseLandmark } from './types';

const SETTINGS = defaultConfig.hands;

/** Mano abierta y recta, en píxeles de máscara: muñeca abajo, cuatro dedos hacia arriba. */
function openHand(scale = 1, originX = 40, originY = 30): Float32Array {
  const points = new Float32Array(42);
  const put = (index: number, x: number, y: number) => {
    points[index * 2] = originX + (x - 40) * scale;
    points[index * 2 + 1] = originY + (y - 30) * scale;
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

function pose(overrides: Record<number, Partial<PoseLandmark>>): PoseLandmark[] {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  for (const [index, value] of Object.entries(overrides)) landmarks[Number(index)] = { ...landmarks[Number(index)], ...value };
  return landmarks;
}

describe('capsuleDistance y sampleUint8', () => {
  it('mide la distancia a un segmento, no a la recta infinita', () => {
    expect(capsuleDistance(0, 0, -1, 0, 1, 0)).toBe(0);
    expect(capsuleDistance(0, 2, -1, 0, 1, 0)).toBe(2);
    expect(capsuleDistance(5, 0, -1, 0, 1, 0)).toBe(4);
  });

  it('interpola bilinealmente y devuelve 0..1', () => {
    const data = new Uint8Array([0, 255, 0, 255]);
    expect(sampleUint8(data, 2, 2, 0.5, 0.5)).toBe(0);
    expect(sampleUint8(data, 2, 2, 1.5, 0.5)).toBe(1);
    expect(sampleUint8(data, 2, 2, 1, 1)).toBeCloseTo(0.5, 5);
    // Fuera del mapa se replica el borde en lugar de leer basura.
    expect(sampleUint8(data, 2, 2, -5, 0.5)).toBe(0);
  });
});

describe('HandShape', () => {
  const shape = new HandShape();
  const prepared = shape.prepare(openHand(), 1, 1, SETTINGS, 0.2);

  it('construye la mano a partir de los 21 puntos', () => {
    expect(prepared).toBe(true);
    expect(shape.palmLength).toBeCloseTo(Math.hypot(38.8 - 40, 24 - 30), 3);
    expect(shape.fingerRadius).toBeCloseTo(SETTINGS.fingerRadius * shape.palmLength, 5);
  });

  it('distingue dedo, hueco entre dedos, palma y antebrazo', () => {
    // Sobre el dedo medio y en la palma: dentro. En el hueco entre dos dedos: fuera.
    expect(shape.signedDistance(38.8, 18)).toBeLessThan(0);
    expect(shape.signedDistance(40, 27)).toBeLessThan(0);
    expect(shape.signedDistance(40, 18)).toBeGreaterThan(0);
    // El antebrazo continúa más allá de la muñeca: la mano nunca queda suelta del brazo.
    expect(shape.signedDistance(40.8, 33)).toBeLessThan(0);
    expect(shape.signedDistance(40, 5)).toBeGreaterThan(5);
  });

  it('la distancia a los dedos ignora palma y antebrazo', () => {
    expect(shape.fingerDistance(38.8, 18)).toBeLessThan(0);
    expect(shape.fingerDistance(40, 34)).toBeGreaterThan(3);
  });

  it('respeta un grosor mínimo aunque la mano esté muy lejos', () => {
    const tiny = new HandShape();
    expect(tiny.prepare(openHand(0.1), 1, 1, SETTINGS, 0.5)).toBe(true);
    expect(tiny.fingerRadius).toBe(0.5);
    expect(tiny.signedDistance(40 - 0.36, 30 - 0.6)).toBeLessThan(0);
  });

  it('rechaza landmarks degenerados', () => {
    expect(new HandShape().prepare(new Float32Array(42), 1, 1, SETTINGS, 0.2)).toBe(false);
    expect(new HandShape().prepare(new Float32Array(10), 1, 1, SETTINGS, 0.2)).toBe(false);
  });
});

describe('recortes de mano', () => {
  const out = { x: 0, y: 0, width: 1, height: 1 };

  it('conserva la relación de aspecto y no se sale del cuadro', () => {
    const roi = fitRoi(0.02, 0.5, 200, 16 / 9, 1280, 720, out);
    expect(roi.x).toBe(0);
    expect((roi.width * 1280) / (roi.height * 720)).toBeCloseTo(16 / 9, 5);
    expect(roi.width * 1280).toBeCloseTo((200 * 16) / 9, 5);
    const tall = fitRoi(0.5, 0.5, 5000, 16 / 9, 1280, 720, out);
    expect(tall.width).toBeCloseTo(1, 5);
    expect(tall.x).toBeCloseTo(0, 5);
  });

  it('encuadra la mano desde Pose y descarta muñecas poco visibles', () => {
    const visible = pose({ 15: { x: 0.5, y: 0.5 }, 17: { x: 0.52, y: 0.46 }, 19: { x: 0.53, y: 0.45 }, 11: { x: 0.4, y: 0.6 }, 12: { x: 0.6, y: 0.6 } });
    const roi = roiFromPose(visible, 'left', 1280, 720, SETTINGS, out);
    expect(roi).not.toBeNull();
    // El recorte se centra pasando la muñeca, hacia los nudillos.
    expect(roi!.x + roi!.width / 2).toBeGreaterThan(0.5);
    expect(roi!.height * 720).toBeGreaterThanOrEqual(SETTINGS.roiMinPx);
    expect(roi!.height * 720).toBeLessThanOrEqual(SETTINGS.roiMaxPx);

    const hidden = pose({ 15: { x: 0.5, y: 0.5, visibility: 0.1 } });
    expect(roiFromPose(hidden, 'left', 1280, 720, SETTINGS, out)).toBeNull();
  });

  it('el ancho de hombros sostiene el recorte cuando los puntos de la mano colapsan', () => {
    const collapsed = pose({ 15: { x: 0.5, y: 0.5 }, 17: { x: 0.5, y: 0.5 }, 19: { x: 0.5, y: 0.5 }, 11: { x: 0.35, y: 0.6 }, 12: { x: 0.65, y: 0.6 } });
    const roi = roiFromPose(collapsed, 'left', 1280, 720, SETTINGS, out)!;
    expect(roi.height * 720).toBeCloseTo(SETTINGS.roiShoulderScale * 0.3 * 1280, 0);
  });

  it('encuadra a partir de la mano anterior y traduce landmarks del recorte a la cámara', () => {
    const landmarks = new Float32Array(42);
    for (let k = 0; k < 21; k++) {
      landmarks[k * 2] = 0.4 + (k % 5) * 0.01;
      landmarks[k * 2 + 1] = 0.3 + Math.floor(k / 5) * 0.01;
    }
    const roi = roiFromHand(landmarks, 1280, 720, SETTINGS, out)!;
    expect(roi.x + roi.width / 2).toBeCloseTo(0.42, 2);
    expect(roiFromHand(new Float32Array(4), 1280, 720, SETTINGS, out)).toBeNull();

    const mapped = cropToCamera(new Float32Array([0, 0, 1, 1, 0.5, 0.5]), { x: 0.2, y: 0.1, width: 0.4, height: 0.2 });
    [0.2, 0.1, 0.6, 0.3, 0.4, 0.2].forEach((value, i) => expect(mapped[i]).toBeCloseTo(value, 5));
  });
});
