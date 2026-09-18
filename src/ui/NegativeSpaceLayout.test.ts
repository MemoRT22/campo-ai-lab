import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { NegativeSpaceLayout, type OccupancySource } from './NegativeSpaceLayout';

const WIDTH = 1920;
const HEIGHT = 1080;
const SPACING = 20;

/** Retícula sintética con celdas activas dentro de los rectángulos dados (fracciones de pantalla). */
function source(...rects: Array<[number, number, number, number]>): OccupancySource {
  const cellX: number[] = [];
  const cellY: number[] = [];
  const activeList: number[] = [];
  for (let y = SPACING / 2; y < HEIGHT; y += SPACING) {
    for (let x = SPACING / 2; x < WIDTH; x += SPACING) {
      const index = cellX.length;
      cellX.push(x);
      cellY.push(y);
      if (rects.some(([x0, y0, x1, y1]) => x >= x0 * WIDTH && x <= x1 * WIDTH && y >= y0 * HEIGHT && y <= y1 * HEIGHT)) {
        activeList.push(index);
      }
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    spacing: SPACING,
    activeCount: activeList.length,
    activeList: Int32Array.from(activeList),
    cellX: Float32Array.from(cellX),
    cellY: Float32Array.from(cellY),
  };
}

describe('NegativeSpaceLayout', () => {
  it('coloca el texto en la columna libre y no alterna por diferencias pequeñas', () => {
    const layout = new NegativeSpaceLayout(defaultConfig.layout);
    // Persona cargada a la derecha: su cuerpo invade la columna derecha.
    layout.update(source([0.6, 0.15, 0.95, 1]), 0);
    const anchor = layout.resolve('hint');
    expect(anchor.placement).toBe('left');
    expect(anchor.x).toBeLessThan(WIDTH * defaultConfig.layout.sideColumnWidth);

    // Un brazo roza la columna izquierda: menos que el margen de cambio, se queda donde está.
    layout.update(source([0.6, 0.15, 0.95, 1], [0.24, 0.45, 0.28, 0.5]), 1000);
    expect(layout.resolve('hint').placement).toBe('left');

    // La persona cruza a la izquierda: ahora sí cambia.
    layout.update(source([0.02, 0.15, 0.35, 1]), 2000);
    expect(layout.resolve('hint').placement).toBe('right');
  });

  it('los mensajes pueden subir cuando ambas columnas están ocupadas, las instrucciones de manos no', () => {
    const layout = new NegativeSpaceLayout(defaultConfig.layout);
    layout.update(source([0.02, 0.25, 0.3, 1], [0.7, 0.25, 0.98, 1]), 0);
    expect(layout.resolve('message').placement).toBe('top');
    expect(layout.resolve('title').placement).toBe('top');
    expect(['left', 'right']).toContain(layout.resolve('hint').placement);
  });
});
