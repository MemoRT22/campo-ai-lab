import { MaskProcessor } from './MaskProcessor';
import { PersonSegmenter } from './PersonSegmenter';
import type { FrameMessage, FromWorker, InitMessage, ToWorker } from './protocol';

// Todo lo que toca píxeles de la cámara vive aquí. Los frames se cierran al terminar
// y sólo sale del worker el mapa de siluetas: ninguna imagen se conserva ni se envía.

const segmenter = new PersonSegmenter();
let processor: MaskProcessor | null = null;
let ready = false;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function init(message: InitMessage): Promise<void> {
  try {
    processor = new MaskProcessor(message.settings);
    await segmenter.init(message.wasmBaseUrl, message.modelUrl, message.delegate);
    ready = true;
    post({ type: 'ready', delegate: segmenter.delegate, labels: segmenter.labels });
  } catch (error) {
    post({ type: 'error', fatal: true, duringInit: true, message: `No se pudo iniciar el segmentador (${message.delegate}): ${describe(error)}` });
  }
}

function handleFrame(message: FrameMessage): void {
  const { bitmap, timestamp, recycled } = message;
  let produced = false;

  try {
    if (ready && processor) {
      const mask = processor;
      const started = performance.now();
      segmenter.segment(bitmap, timestamp, (confidence, width, height) => {
        const inferenceMs = performance.now() - started;
        const size = width * height;
        const personMap = recycled && recycled.byteLength === size ? new Uint8Array(recycled) : new Uint8Array(size);
        const processingStarted = performance.now();
        const people = mask.process(confidence, width, height, timestamp, personMap);
        const processingMs = performance.now() - processingStarted;
        produced = true;
        post(
          { type: 'result', width, height, personMap: personMap.buffer, people, timestamp, inferenceMs, processingMs },
          [personMap.buffer],
        );
      });
    }
  } catch (error) {
    post({ type: 'error', fatal: false, duringInit: false, message: `Fallo de inferencia: ${describe(error)}` });
  } finally {
    bitmap.close();
  }

  if (!produced) post({ type: 'skipped', recycled }, recycled ? [recycled] : []);
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'init') void init(message);
  else if (message.type === 'frame') handleFrame(message);
});
