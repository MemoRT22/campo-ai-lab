import { describe, expect, it } from 'vitest';
import { FormationTracker } from './FormationTracker';

describe('FormationTracker', () => {
  it('da a cada track su propio inicio de formación y lo conserva mientras exista', () => {
    const tracker = new FormationTracker();
    tracker.sync([4], 1, 1000);
    expect(tracker.ageOf(0, 1300)).toBe(300);

    // Llega una segunda persona: la primera conserva su inicio aunque cambie de índice.
    tracker.sync([9, 4], 2, 2000);
    expect(tracker.ageOf(0, 2100)).toBe(100);
    expect(tracker.ageOf(1, 2100)).toBe(1100);
  });

  it('fija la silueta una sola vez al cruzar el umbral y no vuelve atrás', () => {
    const tracker = new FormationTracker();
    tracker.sync([1], 1, 0);
    tracker.report(0, 50, 100, 400, 0.8);
    expect(tracker.isLocked(0)).toBe(false);
    expect(tracker.overallProgress(1)).toBeCloseTo(0.5);

    tracker.report(0, 85, 100, 700, 0.8);
    expect(tracker.isLocked(0)).toBe(true);
    expect(tracker.lockedAtOf(0)).toBe(700);
    expect(tracker.overallProgress(1)).toBe(1);

    // Una pérdida de densidad posterior no reabre la formación cinematográfica.
    tracker.report(0, 30, 100, 900, 0.8);
    expect(tracker.isLocked(0)).toBe(true);
    expect(tracker.lockedAtOf(0)).toBe(700);
  });

  it('libera el lugar de un track ausente: el mismo cuerpo con id nuevo vuelve a formarse', () => {
    const tracker = new FormationTracker();
    tracker.sync([1], 1, 0);
    tracker.report(0, 100, 100, 500, 0.8);
    tracker.sync([], 0, 600);
    tracker.sync([2], 1, 700);
    expect(tracker.isLocked(0)).toBe(false);
    expect(tracker.ageOf(0, 750)).toBe(50);
  });

  it('ignora reportes sin partículas y personas no sincronizadas', () => {
    const tracker = new FormationTracker();
    tracker.sync([3], 1, 0);
    tracker.report(0, 0, 0, 100, 0.8);
    tracker.report(5, 10, 10, 100, 0.8);
    expect(tracker.isLocked(0)).toBe(false);
    expect(tracker.ageOf(5, 100)).toBe(Infinity);
    expect(tracker.overallProgress(0)).toBe(1);
  });
});
