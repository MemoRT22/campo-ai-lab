import { describe, expect, it } from 'vitest';
import { GestureResonance } from './GestureResonance';

describe('GestureResonance', () => {
  it('empareja ONE_HAND_UP de dos personas distintas dentro de la ventana', () => {
    const resonance = new GestureResonance(700);
    expect(resonance.register(1, 100, 200, 1000)).toBeNull();
    const partner = resonance.register(2, 500, 220, 1500);
    expect(partner).toEqual({ personId: 1, x: 100, y: 200 });
  });

  it('no resuena con la misma persona ni fuera de la ventana', () => {
    const resonance = new GestureResonance(700);
    expect(resonance.register(1, 0, 0, 1000)).toBeNull();
    expect(resonance.register(1, 10, 0, 1200)).toBeNull();
    expect(resonance.register(2, 0, 0, 2000)).toBeNull();
    expect(resonance.register(-1, 0, 0, 2100)).toBeNull();
  });

  it('cada onda sólo resuena una vez', () => {
    const resonance = new GestureResonance(900);
    resonance.register(1, 0, 0, 0);
    expect(resonance.register(2, 0, 0, 100)?.personId).toBe(1);
    // La onda de 1 ya se consumió y la de 2 también: una tercera persona empieza sola.
    expect(resonance.register(3, 0, 0, 200)).toBeNull();
    expect(resonance.register(4, 0, 0, 300)?.personId).toBe(3);
  });
});
