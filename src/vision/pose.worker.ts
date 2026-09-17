import { PoseLandmarkerRunner } from './PoseLandmarkerRunner';
import type { PoseFromWorker, PoseInitMessage, PoseFrameMessage, PoseToWorker } from './poseProtocol';

const landmarker = new PoseLandmarkerRunner();
let ready = false;

function post(message: PoseFromWorker): void {
  self.postMessage(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function init(message: PoseInitMessage): Promise<void> {
  try {
    await landmarker.init(message.wasmBaseUrl, message.modelUrl, message.delegate, message.settings);
    ready = true;
    post({ type: 'ready' });
  } catch (error) {
    post({ type: 'error', message: `No se pudo iniciar pose landmarker (${message.delegate}): ${describe(error)}` });
  }
}

function handleFrame(message: PoseFrameMessage): void {
  const { id, bitmap } = message;
  try {
    if (ready) {
      const started = performance.now();
      const poses = landmarker.detect(bitmap, started);
      const inferenceMs = performance.now() - started;
      post({ type: 'result', id, poses, inferenceMs });
    }
  } catch (error) {
    post({ type: 'error', message: `Fallo en inferencia de pose: ${describe(error)}` });
  } finally {
    bitmap.close();
  }
}

self.addEventListener('message', (event: MessageEvent<PoseToWorker>) => {
  const message = event.data;
  if (message.type === 'init') void init(message);
  else if (message.type === 'frame') handleFrame(message);
});
