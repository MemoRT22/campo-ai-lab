import { screenScale } from '../utils/MathUtils';

/**
 * Tipografía compartida entre el DOM y las partículas. El overlay dibuja exactamente estas líneas
 * y el muestreo usa las mismas fuentes, tamaños y cortes: las partículas caen sobre las letras
 * reales en lugar de aproximarlas. Todo se calcula en px CSS relativos al centro del bloque.
 */

/** Peso con el que se rasteriza para muestrear: cubre también los trazos muy finos del título. */
const SAMPLING_WEIGHT = 420;
const ALPHA_THRESHOLD = 60;

/** Proporciones tipográficas del CSS (styles.css), expresadas en unidades `--u`. */
const TYPE = {
  title: { size: 2.6, weight: 250, tracking: 0.26, lineHeight: 1.2, family: '"Geist Variable", sans-serif' },
  subtitle: { size: 0.62, weight: 400, tracking: 0.32, lineHeight: 1.2, family: '"Geist Mono Variable", monospace', gap: 1.3 },
  brandName: { size: 1.15, weight: 500, tracking: 0.44, lineHeight: 1.2, family: '"Geist Variable", sans-serif' },
  brandLab: { size: 0.66, weight: 400, tracking: 0.34, lineHeight: 1.2, family: '"Geist Mono Variable", monospace', gap: 1.8 },
} as const;

type Role = keyof typeof TYPE;

/** Sólo los textos grandes reciben partículas: en los pequeños estorbarían la lectura. */
const PARTICLE_ROLES: ReadonlySet<Role> = new Set<Role>(['title', 'brandName']);

export interface TypeLine {
  role: Role;
  text: string;
  font: string;
  size: number;
  tracking: number;
  /** Centro vertical de la línea respecto al centro del bloque. */
  y: number;
}

export interface TypeBlock {
  lines: TypeLine[];
  height: number;
}

export interface TypeViewport {
  width: number;
  height: number;
  typographyScale: number;
}

let measureContext: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  return measureContext;
}

/** Unidad `--u` del CSS: min(1vw, 1.7778vh). */
function unit(viewport: TypeViewport): number {
  return Math.min(viewport.width / 100, (viewport.height * 1.7778) / 100) * viewport.typographyScale;
}

function measure(text: string, font: string, tracking: number): number {
  const ctx = context();
  if (!ctx) return text.length * tracking * 2;
  ctx.font = font;
  ctx.letterSpacing = `${tracking}px`;
  // letterSpacing también se suma tras el último carácter; el CSS lo compensa con margin-right.
  return ctx.measureText(text).width - tracking;
}

/** Cortes de línea balanceados: el menor número de líneas y, con ese número, el ancho más parejo. */
export function wrapBalanced(text: string, maxWidth: number, widthOf: (line: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1 || widthOf(text) <= maxWidth) return [text];

  const greedy = (limit: number): string[] => {
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && widthOf(candidate) > limit) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const target = greedy(maxWidth).length;
  let low = 0;
  let high = maxWidth;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    if (greedy(mid).length <= target) high = mid;
    else low = mid;
  }
  return greedy(high);
}

function layoutRoles(parts: Array<{ role: Role; text: string }>, maxWidth: number, viewport: TypeViewport): TypeBlock {
  const u = unit(viewport);
  const rows: Array<{ role: Role; text: string; font: string; size: number; tracking: number; top: number; height: number }> = [];
  let cursor = 0;
  let previous: Role | null = null;
  for (const part of parts) {
    if (!part.text) continue;
    const spec = TYPE[part.role];
    const size = spec.size * u;
    const tracking = spec.tracking * size;
    const font = `${spec.weight} ${size}px ${spec.family}`;
    if (previous !== null && previous !== part.role && 'gap' in spec) cursor += spec.gap * u;
    for (const text of wrapBalanced(part.text, maxWidth, (line) => measure(line, font, tracking))) {
      const height = size * spec.lineHeight;
      rows.push({ role: part.role, text, font, size, tracking, top: cursor, height });
      cursor += height;
    }
    previous = part.role;
  }
  const half = cursor / 2;
  return {
    height: cursor,
    lines: rows.map((row) => ({ role: row.role, text: row.text, font: row.font, size: row.size, tracking: row.tracking, y: row.top + row.height / 2 - half })),
  };
}

export function revealBlock(title: string, subtitle: string, maxWidth: number, viewport: TypeViewport): TypeBlock {
  return layoutRoles([{ role: 'title', text: title }, { role: 'subtitle', text: subtitle }], maxWidth, viewport);
}

export function brandBlock(brandName: string, labName: string, maxWidth: number, viewport: TypeViewport): TypeBlock {
  return layoutRoles([{ role: 'brandName', text: brandName }, { role: 'brandLab', text: labName }], maxWidth, viewport);
}

export function linesOf(block: TypeBlock, role: Role): string[] {
  return block.lines.filter((line) => line.role === role).map((line) => line.text);
}

/**
 * Rasteriza el bloque una vez (al mostrarse el texto) y devuelve puntos sobre los trazos, en px CSS
 * absolutos alrededor de (centerX, centerY). No se conserva el bitmap.
 */
export function sampleTypeBlock(block: TypeBlock, centerX: number, centerY: number, maxTargets: number, viewport: TypeViewport): Float32Array {
  if (block.lines.length === 0 || maxTargets <= 0) return new Float32Array(0);
  let blockWidth = 1;
  for (const line of block.lines) blockWidth = Math.max(blockWidth, measure(line.text, line.font, line.tracking));
  const padding = Math.ceil(unit(viewport));
  const width = Math.ceil(blockWidth) + padding * 2;
  const height = Math.ceil(block.height) + padding * 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Float32Array(0);

  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const line of block.lines) {
    if (!PARTICLE_ROLES.has(line.role)) continue;
    const spec = TYPE[line.role];
    ctx.font = `${Math.max(spec.weight, SAMPLING_WEIGHT)} ${line.size}px ${spec.family}`;
    ctx.letterSpacing = `${line.tracking}px`;
    // Centrado como en el DOM: se descuenta el tracking final.
    ctx.fillText(line.text, width / 2 + line.tracking / 2, height / 2 + line.y);
  }

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const step = Math.max(2, Math.round(3 * screenScale(viewport.width, viewport.height)));
  const candidates: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (pixels[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) candidates.push(x, y);
    }
  }

  const count = Math.min(maxTargets, candidates.length / 2);
  const targets = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const source = Math.floor((i * candidates.length) / (count * 2)) * 2;
    targets[i * 2] = centerX - width / 2 + candidates[source];
    targets[i * 2 + 1] = centerY - height / 2 + candidates[source + 1];
  }
  return targets;
}
