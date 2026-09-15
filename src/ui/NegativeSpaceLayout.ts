import type { Config } from '../config';
import { expAlpha } from '../utils/MathUtils';

/**
 * message  texto breve (saludo, marca): puede usar la franja superior.
 * hint     pide levantar las manos: nunca arriba, ahí van a estar las manos.
 * title    reveal tipográfico: igual que message, pero necesita más ancho.
 */
export type TextKind = 'message' | 'hint' | 'title';
export type ResolvedPlacement = 'left' | 'right' | 'top' | 'center';

export interface TextAnchor {
  placement: ResolvedPlacement;
  /** Centro del bloque de texto y ancho disponible, en px CSS. */
  x: number;
  y: number;
  width: number;
}

/** Lo mínimo que se necesita de la retícula para medir ocupación. */
export interface OccupancySource {
  width: number;
  height: number;
  spacing: number;
  activeCount: number;
  activeList: Int32Array;
  cellX: Float32Array;
  cellY: Float32Array;
}

type LayoutSettings = Config['layout'];

/**
 * Elige dónde colocar el texto para no chocar con las siluetas. Mide qué fracción de cada zona
 * ocupan las celdas activas y la suaviza en el tiempo. La decisión se toma sólo al mostrar un
 * mensaje nuevo, así que un texto visible nunca cambia de lugar.
 */
export class NegativeSpaceLayout {
  occupancyLeft = 0;
  occupancyRight = 0;
  occupancyTop = 0;
  side: 'left' | 'right' = 'right';

  private width = 1;
  private height = 1;
  private lastUpdate = -1;

  constructor(private readonly settings: LayoutSettings) {}

  update(source: OccupancySource, now: number): void {
    const s = this.settings;
    const { width, height, spacing, activeCount, activeList, cellX, cellY } = source;
    this.width = width;
    this.height = height;

    const sideWidth = width * s.sideColumnWidth;
    const bandTop = height * s.textBandTop;
    const bandBottom = height * s.textBandBottom;
    const topLeft = width * (0.5 - s.topBand.width / 2);
    const topRight = width * (0.5 + s.topBand.width / 2);
    const topTop = height * s.topBand.top;
    const topBottom = height * s.topBand.bottom;

    let left = 0;
    let right = 0;
    let top = 0;
    for (let k = 0; k < activeCount; k++) {
      const c = activeList[k];
      const x = cellX[c];
      const y = cellY[c];
      if (y >= bandTop && y <= bandBottom) {
        if (x <= sideWidth) left++;
        else if (x >= width - sideWidth) right++;
      }
      if (y >= topTop && y <= topBottom && x >= topLeft && x <= topRight) top++;
    }

    const cellArea = spacing * spacing;
    const sideCells = Math.max(1, (sideWidth * (bandBottom - bandTop)) / cellArea);
    const topCells = Math.max(1, ((topRight - topLeft) * (topBottom - topTop)) / cellArea);
    const alpha = this.lastUpdate < 0 ? 1 : expAlpha(now - this.lastUpdate, s.occupancySmoothingMs);
    this.lastUpdate = now;
    this.occupancyLeft += (Math.min(1, left / sideCells) - this.occupancyLeft) * alpha;
    this.occupancyRight += (Math.min(1, right / sideCells) - this.occupancyRight) * alpha;
    this.occupancyTop += (Math.min(1, top / topCells) - this.occupancyTop) * alpha;
  }

  resolve(kind: TextKind): TextAnchor {
    const s = this.settings;
    const { width, height } = this;
    if (width / height < s.minSideAspect) return this.topAnchor();

    const current = this.side === 'left' ? this.occupancyLeft : this.occupancyRight;
    const other = this.side === 'left' ? this.occupancyRight : this.occupancyLeft;
    // Histéresis: sólo cambia de lado si el otro está claramente más libre.
    if (other + s.switchMargin < current) this.side = this.side === 'left' ? 'right' : 'left';
    const sideOccupancy = this.side === 'left' ? this.occupancyLeft : this.occupancyRight;

    if (kind !== 'hint' && sideOccupancy > s.maxOccupancy && this.occupancyTop + s.switchMargin < sideOccupancy) {
      return this.topAnchor();
    }
    const columnWidth = width * s.sideColumnWidth;
    return {
      placement: this.side,
      x: this.side === 'left' ? columnWidth / 2 : width - columnWidth / 2,
      y: height * (s.textBandTop + s.textBandBottom) / 2,
      width: columnWidth * s.columnFill,
    };
  }

  /** Sin personas no hay con qué chocar: el centro es el mejor espacio negativo. */
  center(): TextAnchor {
    return { placement: 'center', x: this.width / 2, y: this.height / 2, width: this.width * this.settings.topBand.width };
  }

  private topAnchor(): TextAnchor {
    const s = this.settings;
    return {
      placement: 'top',
      x: this.width / 2,
      y: this.height * (s.topBand.top + s.topBand.bottom) / 2,
      width: this.width * s.topBand.width,
    };
  }
}
