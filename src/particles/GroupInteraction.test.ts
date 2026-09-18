import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { GROUP_COLLECTIVE, GROUP_PAIR, GROUP_SINGLE, GroupInteraction, MAX_CONNECTIONS, modeForStableCount, selectPairs, type GroupPeople } from './GroupInteraction';

const FRAME = 1000 / 60;

function people(points: Array<[id: number, x: number, y: number]>): GroupPeople {
  return {
    peopleCount: points.length,
    peopleId: points.map(([id]) => id),
    peopleX: points.map(([, x]) => x),
    peopleY: points.map(([, , y]) => y),
    peopleVx: points.map(() => 0),
    peopleVy: points.map(() => 0),
  };
}

function run(group: GroupInteraction, input: GroupPeople, from: number, to: number): number {
  let now = from;
  while (now < to) {
    now += FRAME;
    group.update(input, now, 1);
  }
  return now;
}

function distances(points: Array<[number, number]>): Float32Array {
  const n = points.length;
  const matrix = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) matrix[i * n + j] = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
  }
  return matrix;
}

describe('GroupInteraction mode', () => {
  const settings = defaultConfig.particles.groupInteraction;

  it('traduce personas estables a modos', () => {
    expect(modeForStableCount(0)).toBe(GROUP_SINGLE);
    expect(modeForStableCount(1)).toBe(GROUP_SINGLE);
    expect(modeForStableCount(2)).toBe(GROUP_PAIR);
    expect(modeForStableCount(3)).toBe(GROUP_COLLECTIVE);
    expect(modeForStableCount(4)).toBe(GROUP_COLLECTIVE);
  });

  it('activa el modo pareja sólo tras estabilidad y ventana de entrada', () => {
    const group = new GroupInteraction(settings);
    const pair = people([[1, 400, 500], [2, 900, 500]]);
    let now = run(group, pair, 0, settings.stableMs - 50);
    expect(group.stableCount).toBe(0);
    expect(group.mode).toBe(GROUP_SINGLE);

    now = run(group, pair, now, settings.stableMs + settings.enterMs - 50);
    expect(group.stableCount).toBe(2);
    expect(group.mode).toBe(GROUP_SINGLE);

    run(group, pair, now, settings.stableMs + settings.enterMs + 50);
    expect(group.mode).toBe(GROUP_PAIR);
  });

  it('una pérdida breve de un track no desactiva el grupo; una salida sostenida sí', () => {
    const group = new GroupInteraction(settings);
    const pair = people([[1, 400, 500], [2, 900, 500]]);
    const alone = people([[1, 400, 500]]);
    let now = run(group, pair, 0, settings.stableMs + settings.enterMs + 100);
    expect(group.mode).toBe(GROUP_PAIR);

    now = run(group, alone, now, now + settings.dropGraceMs * 0.6);
    expect(group.mode).toBe(GROUP_PAIR);
    now = run(group, pair, now, now + 200);
    expect(group.mode).toBe(GROUP_PAIR);

    now = run(group, alone, now, now + settings.dropGraceMs + settings.exitMs - 100);
    expect(group.mode).toBe(GROUP_PAIR);
    run(group, alone, now, now + 300);
    expect(group.mode).toBe(GROUP_SINGLE);
  });

  it('con histéresis: un conteo que oscila no cambia de modo', () => {
    // Sin gracia ni estabilidad mínima, el conteo crudo oscila 3 → 2 → 3 cada pocos frames.
    const group = new GroupInteraction({ ...settings, dropGraceMs: 0, stableMs: 0 });
    const two = people([[1, 300, 500], [2, 800, 500]]);
    const three = people([[1, 300, 500], [2, 800, 500], [3, 1300, 500]]);
    let now = run(group, three, 0, settings.enterMs + 100);
    expect(group.mode).toBe(GROUP_COLLECTIVE);

    // La tercera persona parpadea: la salida exige exitMs sostenidos.
    for (let i = 0; i < 6; i++) {
      now = run(group, two, now, now + settings.exitMs * 0.4);
      now = run(group, three, now, now + FRAME * 2);
    }
    expect(group.mode).toBe(GROUP_COLLECTIVE);
  });

  it('entra en modo colectivo con tres personas estables', () => {
    const group = new GroupInteraction(settings);
    const three = people([[1, 300, 500], [2, 800, 500], [3, 1300, 500]]);
    run(group, three, 0, settings.stableMs + settings.enterMs + 100);
    expect(group.mode).toBe(GROUP_COLLECTIVE);
    expect(group.energy).toBeGreaterThan(0);
  });

  it('no hace nada si está deshabilitado', () => {
    const group = new GroupInteraction({ ...settings, enabled: false });
    run(group, people([[1, 300, 500], [2, 800, 500], [3, 1300, 500]]), 0, 3000);
    expect(group.mode).toBe(GROUP_SINGLE);
    expect(group.connectionCount).toBe(0);
  });
});

describe('GroupInteraction connections', () => {
  const settings = defaultConfig.particles.groupInteraction;

  it('la fuerza crece con la cercanía y se apaga suavemente al separarse', () => {
    const group = new GroupInteraction(settings);
    expect(group.proximityStrength(settings.connectionDistance.near * 0.5, 1)).toBe(1);
    expect(group.proximityStrength(settings.connectionDistance.far + 10, 1)).toBe(0);
    const mid = group.proximityStrength((settings.connectionDistance.near + settings.connectionDistance.far) / 2, 1);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);

    const near = people([[1, 500, 500], [2, 800, 500]]);
    let now = run(group, near, 0, 4000);
    const strong = group.strength.reduce((max, value) => Math.max(max, value), 0);
    expect(strong).toBeGreaterThan(settings.pairStrength * 0.9);
    expect(group.connectionCount).toBe(1);

    const apart = people([[1, 100, 500], [2, 100 + settings.connectionDistance.far + 200, 500]]);
    now = run(group, apart, now, now + FRAME * 3);
    const afterFewFrames = group.strength.reduce((max, value) => Math.max(max, value), 0);
    expect(afterFewFrames).toBeGreaterThan(strong * 0.5);
    run(group, apart, now, now + 6000);
    expect(group.connectionCount).toBe(0);
  });

  it('los extremos siguen a las personas con suavizado, sin saltos', () => {
    const group = new GroupInteraction(settings);
    let now = run(group, people([[1, 500, 500], [2, 900, 500]]), 0, 3000);
    const slot = group.connectionIdA.findIndex((id) => id >= 0);
    expect(slot).toBeGreaterThanOrEqual(0);
    const before = Math.min(group.ax[slot], group.bx[slot]);

    const moved = people([[1, 700, 500], [2, 1100, 500]]);
    now += FRAME;
    group.update(moved, now, 1);
    const firstStep = Math.min(group.ax[slot], group.bx[slot]) - before;
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(200 * 0.2);

    run(group, moved, now, now + 2000);
    expect(Math.min(group.ax[slot], group.bx[slot])).toBeCloseTo(700, 0);
    // Mismo par → mismo lugar de conexión.
    expect(group.connectionIdA.findIndex((id) => id >= 0)).toBe(slot);
  });

  it('respeta el presupuesto de partículas en cualquier modo', () => {
    const group = new GroupInteraction(settings);
    const four = people([[1, 300, 400], [2, 700, 450], [3, 1100, 420], [4, 700, 800]]);
    let now = 0;
    for (let i = 0; i < 400; i++) {
      now += FRAME;
      group.update(four, now, 1);
      const total = group.particleBudget.reduce((sum, value) => sum + value, 0);
      const limit = group.mode === GROUP_COLLECTIVE ? settings.collectiveParticleBudget : settings.pairParticleBudget;
      expect(total).toBeLessThanOrEqual(limit);
    }
    expect(group.mode).toBe(GROUP_COLLECTIVE);
    expect(group.connectionCount).toBeLessThanOrEqual(settings.maxConnections);
    expect(group.connectionCount).toBeGreaterThanOrEqual(3);
  });

  it('en modo pareja sólo existe una conexión aunque haya más candidatos', () => {
    const group = new GroupInteraction({ ...settings, enterMs: 0, stableMs: 0 });
    const two = people([[1, 400, 500], [2, 800, 500]]);
    run(group, two, 0, 3000);
    expect(group.mode).toBe(GROUP_PAIR);
    expect(group.connectionIdA.filter((id) => id >= 0)).toHaveLength(1);
  });
});

describe('selectPairs', () => {
  const outA = new Int32Array(MAX_CONNECTIONS);
  const outB = new Int32Array(MAX_CONNECTIONS);

  it('conecta a todos antes de agregar pares redundantes', () => {
    // Tres personas juntas y una más lejos: la lejana no queda aislada.
    const matrix = distances([[0, 0], [100, 0], [50, 80], [900, 0]]);
    const count = selectPairs(4, matrix, 3, 2000, outA, outB);
    expect(count).toBe(3);
    const connected = new Set<number>();
    for (let i = 0; i < count; i++) {
      connected.add(outA[i]);
      connected.add(outB[i]);
    }
    expect(connected.size).toBe(4);
  });

  it('agrega los pares más cercanos restantes hasta el máximo', () => {
    const matrix = distances([[0, 0], [100, 0], [50, 80]]);
    expect(selectPairs(3, matrix, 3, 2000, outA, outB)).toBe(3);
    expect(selectPairs(3, matrix, 1, 2000, outA, outB)).toBe(1);
    // (0,0)–(50,80) mide 94 px: es el par más cercano.
    expect([outA[0], outB[0]]).toEqual([0, 2]);
  });

  it('ignora pares fuera de alcance y no excede el máximo ni la capacidad', () => {
    const matrix = distances([[0, 0], [5000, 0]]);
    expect(selectPairs(2, matrix, 4, 1400, outA, outB)).toBe(0);
    const dense = distances([[0, 0], [10, 0], [20, 0], [30, 0]]);
    expect(selectPairs(4, dense, 10, 2000, outA, outB)).toBe(MAX_CONNECTIONS);
  });
});
