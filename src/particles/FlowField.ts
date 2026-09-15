import { simplex3 } from '../utils/noise';

const COLUMNS = 20;
const SPATIAL_SCALE = 0.16;
const TIME_SCALE = 0.00005;

/**
 * Campo vectorial orgánico de baja resolución. Se evalúa una vez por frame y las partículas
 * lo muestrean con interpolación bilineal: cientos de evaluaciones de ruido en lugar de miles.
 */
export class FlowField {
  sampleX = 0;
  sampleY = 0;

  private cols = COLUMNS;
  private rows = 2;
  private cellW = 1;
  private cellH = 1;
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);

  resize(width: number, height: number): void {
    this.cols = COLUMNS;
    this.rows = Math.max(2, Math.round((COLUMNS * height) / Math.max(1, width)));
    this.cellW = width / (this.cols - 1);
    this.cellH = height / (this.rows - 1);
    this.vx = new Float32Array(this.cols * this.rows);
    this.vy = new Float32Array(this.cols * this.rows);
  }

  update(now: number): void {
    const t = now * TIME_SCALE;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const angle = simplex3(c * SPATIAL_SCALE, r * SPATIAL_SCALE, t) * Math.PI * 2;
        const magnitude = 0.6 + 0.4 * simplex3(c * SPATIAL_SCALE + 40, r * SPATIAL_SCALE, t * 0.7);
        this.vx[i] = Math.cos(angle) * magnitude;
        this.vy[i] = Math.sin(angle) * magnitude;
      }
    }
  }

  /** Escribe el vector interpolado en sampleX/sampleY (evita crear objetos por partícula). */
  sample(x: number, y: number): void {
    const fx = Math.min(Math.max(x / this.cellW, 0), this.cols - 1.001);
    const fy = Math.min(Math.max(y / this.cellH, 0), this.rows - 1.001);
    const c = fx | 0;
    const r = fy | 0;
    const tx = fx - c;
    const ty = fy - r;
    const i00 = r * this.cols + c;
    const i10 = i00 + 1;
    const i01 = i00 + this.cols;
    const i11 = i01 + 1;
    const top = this.vx[i00] + (this.vx[i10] - this.vx[i00]) * tx;
    const bottom = this.vx[i01] + (this.vx[i11] - this.vx[i01]) * tx;
    this.sampleX = top + (bottom - top) * ty;
    const topY = this.vy[i00] + (this.vy[i10] - this.vy[i00]) * tx;
    const bottomY = this.vy[i01] + (this.vy[i11] - this.vy[i01]) * tx;
    this.sampleY = topY + (bottomY - topY) * ty;
  }
}
