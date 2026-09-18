import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { PersonInfo, PoseInfo, PoseLandmark } from '../vision/types';
import { GestureRecognizer } from './GestureRecognizer';

const person: PersonInfo = {
  id: 7, slot: 0, x0: 0.2, y0: 0.1, x1: 0.8, y1: 1, cx: 0.5, cy: 0.5,
  area: 0.3, proximity: 0.5, confirmed: true,
};

function pose(leftUp: boolean, rightUp: boolean): PoseInfo {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.7, z: 0, visibility: 1 }));
  landmarks[11] = { x: 0.4, y: 0.45, z: 0, visibility: 0.95 };
  landmarks[12] = { x: 0.6, y: 0.45, z: 0, visibility: 0.95 };
  landmarks[15] = { x: 0.35, y: leftUp ? 0.2 : 0.65, z: 0, visibility: 0.9 };
  landmarks[16] = { x: 0.65, y: rightUp ? 0.2 : 0.65, z: 0, visibility: 0.9 };
  return { landmarks };
}

function recognizer(): GestureRecognizer {
  const settings = structuredClone(defaultConfig.gestures);
  settings.smoothingMs = 0;
  settings.oneHandHoldMs = 200;
  settings.bothHandsHoldMs = 300;
  settings.absenceGraceMs = 250;
  return new GestureRecognizer(settings);
}

describe('GestureRecognizer', () => {
  it('exige tiempo mínimo, emite un flanco y no repite mientras se mantiene arriba', () => {
    const gesture = recognizer();
    expect(gesture.update([pose(true, false)], [person], 0)).toEqual([]);
    expect(gesture.update([pose(true, false)], [person], 199)).toEqual([]);
    const events = gesture.update([pose(true, false)], [person], 200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ONE_HAND_UP', personId: 7, confidence: 0.9 });
    expect(events[0].points[0]).toMatchObject({ x: 0.35, y: 0.2 });
    expect(gesture.update([pose(true, false)], [person], 1200)).toEqual([]);
  });

  it('requiere bajar la mano para rearmar', () => {
    const gesture = recognizer();
    gesture.update([pose(true, false)], [person], 0);
    gesture.update([pose(true, false)], [person], 200);
    gesture.update([pose(false, false)], [person], 250);
    gesture.update([pose(true, false)], [person], 300);
    expect(gesture.update([pose(true, false)], [person], 500)[0]?.type).toBe('ONE_HAND_UP');
  });

  it('reconoce ambas manos juntas y produce dos puntos', () => {
    const gesture = recognizer();
    gesture.update([pose(true, true)], [person], 0);
    gesture.update([pose(true, true)], [person], 150);
    expect(gesture.update([pose(true, true)], [person], 299)).toEqual([]);
    const event = gesture.update([pose(true, true)], [person], 300)[0];
    expect(event.type).toBe('BOTH_HANDS_UP');
    expect(event.points).toHaveLength(2);
  });

  it('tolera una ausencia breve sin repetir el gesto sostenido', () => {
    const gesture = recognizer();
    gesture.update([pose(true, false)], [person], 0);
    gesture.update([pose(true, false)], [person], 200);
    gesture.update([], [], 300);
    expect(gesture.update([pose(true, false)], [person], 400)).toEqual([]);
  });

  it('una persona que regresa tras perderse crea una sesión gestual nueva', () => {
    const gesture = recognizer();
    gesture.update([pose(true, false)], [person], 0);
    gesture.update([pose(true, false)], [person], 200);
    gesture.update([], [], 500);
    gesture.update([pose(true, false)], [person], 600);
    expect(gesture.update([pose(true, false)], [person], 800)[0]?.type).toBe('ONE_HAND_UP');
  });

  it('usa histéresis: una muñeca cerca del umbral no cambia de estado repetidamente', () => {
    const gesture = recognizer();
    const raised = pose(true, false);
    gesture.update([raised], [person], 0);
    const near = pose(false, false);
    near.landmarks[15].y = 0.41; // debajo del margen de activación, pero aún arriba del de liberación.
    gesture.update([near], [person], 100);
    expect(gesture.currentGesture).toBe('ONE_HAND_UP');
  });
});
