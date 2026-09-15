import { MaskProcessor } from './MaskProcessor';
import { PersonSegmenter } from './PersonSegmenter';
import { PoseLandmarkerRunner } from './PoseLandmarkerRunner';
import type { FrameMessage, FromWorker, InitMessage, ToWorker } from './protocol';
import type { PersonInfo, PoseInfo } from './types';

// Todo lo que toca píxeles de la cámara vive aquí. Los frames se cierran al terminar;
// sólo salen la máscara, cajas y landmarks transitorios: ninguna imagen se conserva.

const segmenter = new PersonSegmenter();
const poseLandmarker = new PoseLandmarkerRunner();
let processor: MaskProcessor | null = null;
let ready = false;
let poseIntervalMs = 1000 / 15;
let lastPoseAt = -Infinity;

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
    await poseLandmarker.init(message.poseWasmBaseUrl, message.poseModelUrl, message.delegate, message.visionSettings);
    poseIntervalMs = 1000 / message.visionSettings.poseFPS;
    ready = true;
    post({ type: 'ready', delegate: segmenter.delegate, labels: segmenter.labels });
  } catch (error) {
    post({ type: 'error', fatal: true, duringInit: true, message: `No se pudo iniciar visión (${message.delegate}): ${describe(error)}` });
  }
}

function handleFrame(message: FrameMessage): void {
  const { bitmap, timestamp, recycled, recycledConfidence } = message;
  let produced = false;

  try {
    if (ready && processor) {
      const mask = processor;
      const started = performance.now();
      let width = 0;
      let height = 0;
      const output: { personMap: Uint8Array | null; confidenceMap: Uint8Array | null } = { personMap: null, confidenceMap: null };
      let people: PersonInfo[] = [];
      let inferenceMs = 0;
      let processingMs = 0;
      segmenter.segment(bitmap, timestamp, (confidence, maskWidth, maskHeight) => {
        inferenceMs = performance.now() - started;
        width = maskWidth;
        height = maskHeight;
        const size = width * height;
        output.personMap = recycled && recycled.byteLength === size ? new Uint8Array(recycled) : new Uint8Array(size);
        output.confidenceMap = recycledConfidence && recycledConfidence.byteLength === size ? new Uint8Array(recycledConfidence) : new Uint8Array(size);
        const processingStarted = performance.now();
        people = mask.process(confidence, width, height, timestamp, output.personMap, output.confidenceMap);
        processingMs = performance.now() - processingStarted;
      });
      const { personMap, confidenceMap } = output;
      if (personMap && confidenceMap) {
        let poses: PoseInfo[] = [];
        let poseTimestamp: number | null = null;
        let poseInferenceMs = 0;
        if (timestamp - lastPoseAt >= poseIntervalMs - 1) {
          const poseStarted = performance.now();
          poses = poseLandmarker.detect(bitmap, timestamp);
          poseInferenceMs = performance.now() - poseStarted;
          poseTimestamp = timestamp;
          lastPoseAt = timestamp;
        }
        produced = true;
        const personMapBuffer = personMap.buffer as ArrayBuffer;
        const confidenceBuffer = confidenceMap.buffer as ArrayBuffer;
        post(
          { type: 'result', width, height, personMap: personMapBuffer, confidenceMap: confidenceBuffer, people, timestamp, inferenceMs, processingMs, poses, poseTimestamp, poseInferenceMs },
          [personMapBuffer, confidenceBuffer],
        );
      }
    }
  } catch (error) {
    post({ type: 'error', fatal: false, duringInit: false, message: `Fallo del pipeline de visión: ${describe(error)}` });
  } finally {
    bitmap.close();
  }

  if (!produced) {
    const transfer: ArrayBuffer[] = [];
    if (recycled) transfer.push(recycled);
    if (recycledConfidence) transfer.push(recycledConfidence);
    post({ type: 'skipped', recycled, recycledConfidence }, transfer);
  }
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'init') void init(message);
  else if (message.type === 'frame') handleFrame(message);
});
