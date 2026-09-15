import { screenScale } from '../utils/MathUtils';

const MAX_TARGETS = 420;

/**
 * Muestrea las dos líneas del reveal una sola vez por resize. El resultado son coordenadas
 * de pantalla; no se conserva el bitmap ni se procesa ningún dato de cámara.
 */
export function sampleTextParticleTargets(
  title: string,
  subtitle: string,
  width: number,
  height: number,
  typographyScale: number,
): Float32Array {
  const scale = screenScale(width, height) * typographyScale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(190 * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return new Float32Array(0);

  context.fillStyle = '#fff';
  context.textBaseline = 'middle';
  context.font = `250 ${Math.round(50 * scale)}px "Geist Variable", sans-serif`;
  drawSpacedText(context, title, width * 0.5, canvas.height * 0.38, 13 * scale);
  context.font = `400 ${Math.max(11, Math.round(12 * scale))}px "Geist Mono Variable", monospace`;
  drawSpacedText(context, subtitle, width * 0.5, canvas.height * 0.7, 4 * scale);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const step = Math.max(3, Math.round(4 * scale));
  const candidates: number[] = [];
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 96) candidates.push(x, y);
    }
  }

  const count = Math.min(MAX_TARGETS, candidates.length / 2);
  const targets = new Float32Array(count * 2);
  const offsetY = height * 0.5 - canvas.height * 0.5;
  for (let i = 0; i < count; i++) {
    const source = Math.floor((i * candidates.length) / (count * 2)) * 2;
    targets[i * 2] = candidates[source];
    targets[i * 2 + 1] = candidates[source + 1] + offsetY;
  }
  return targets;
}

function drawSpacedText(
  context: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  spacing: number,
): void {
  let width = Math.max(0, text.length - 1) * spacing;
  for (const character of text) width += context.measureText(character).width;
  let x = centerX - width * 0.5;
  for (const character of text) {
    context.fillText(character, x, y);
    x += context.measureText(character).width + spacing;
  }
}
