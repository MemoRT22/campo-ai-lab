// Copia el runtime WASM de MediaPipe a public/ para que la instalación funcione sin internet.
// Sólo la variante ES module: es la que carga el worker (FilesetResolver.forVisionTasks(base, true)).
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(root, 'public', 'mediapipe', 'wasm');
const files = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];

if (!existsSync(source)) {
  console.warn('[campo] @mediapipe/tasks-vision no está instalado; se omite la copia del WASM.');
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));
console.log('[campo] WASM de MediaPipe copiado a public/mediapipe/wasm');
