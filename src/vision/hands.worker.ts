import { FilesetResolver, HandLandmarker, ImageSegmenter, type MPMask } from '@mediapipe/tasks-vision';
import type { HandResult, HandsFrameMessage, HandsFromWorker, HandsInitMessage, HandsToWorker } from './handsProtocol';

// Analiza recortes de mano en alta resolución. Vive en su propio worker para que la segmentación
// del cuerpo no pierda frames: si este hilo se atrasa, la silueta sigue igual de rápida.

let landmarker: HandLandmarker | null = null;
let segmenter: ImageSegmenter | null = null;
let maskIndex = -1;

function post(message: HandsFromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function resolvePersonMask(masks: MPMask[], labels: string[]): number {
  if (masks.length === 1) return 0;
  const index = labels.findIndex((label) => /person|selfie|foreground|human/i.test(label));
  return index >= 0 ? index : masks.length - 1;
}

async function init(message: HandsInitMessage): Promise<void> {
  try {
    const s = message.settings;
    const landmarkerFiles = await FilesetResolver.forVisionTasks(message.landmarkerWasmBaseUrl, true);
    landmarker = await HandLandmarker.createFromOptions(landmarkerFiles, {
      baseOptions: { modelAssetPath: message.modelUrl, delegate: message.delegate },
      // Cada recorte es una imagen independiente: el detector de palma corre siempre y no
      // arrastra el seguimiento de una mano a la de otra persona.
      runningMode: 'IMAGE',
      numHands: 1,
      minHandDetectionConfidence: s.detectionConfidence,
      minHandPresenceConfidence: s.presenceConfidence,
      minTrackingConfidence: s.trackingConfidence,
    });
    if (message.segmentation) {
      const segmenterFiles = await FilesetResolver.forVisionTasks(message.segmenterWasmBaseUrl, true);
      segmenter = await ImageSegmenter.createFromOptions(segmenterFiles, {
        baseOptions: { modelAssetPath: message.segmenterModelUrl, delegate: message.delegate },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    }
    post({ type: 'ready', delegate: message.delegate, segmentation: segmenter !== null });
  } catch (error) {
    post({ type: 'error', duringInit: true, message: `No se pudo iniciar el análisis de manos (${message.delegate}): ${describe(error)}` });
  }
}

function analyze(bitmap: ImageBitmap): { result: HandResult; transfer: Transferable[] } {
  const result: HandResult = { landmarks: null, score: 0, mask: null, maskWidth: 0, maskHeight: 0 };
  const transfer: Transferable[] = [];
  if (landmarker) {
    const detection = landmarker.detect(bitmap);
    const points = detection.landmarks[0];
    if (points) {
      const landmarks = new Float32Array(points.length * 2);
      points.forEach((point, i) => {
        landmarks[i * 2] = point.x;
        landmarks[i * 2 + 1] = point.y;
      });
      result.landmarks = landmarks;
      result.score = detection.handedness[0]?.[0]?.score ?? 1;
      transfer.push(landmarks.buffer);
    }
  }
  if (segmenter) {
    segmenter.segment(bitmap, (segmentation) => {
      const masks = segmentation.confidenceMasks;
      if (!masks || masks.length === 0) return;
      if (maskIndex < 0) maskIndex = resolvePersonMask(masks, segmenter?.getLabels() ?? []);
      const mask = masks[Math.min(maskIndex, masks.length - 1)];
      const values = mask.getAsFloat32Array();
      const quantized = new Uint8Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        quantized[i] = value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0;
      }
      result.mask = quantized;
      result.maskWidth = mask.width;
      result.maskHeight = mask.height;
      transfer.push(quantized.buffer);
    });
  }
  return { result, transfer };
}

function handleFrame(message: HandsFrameMessage): void {
  const started = performance.now();
  const hands: HandResult[] = [];
  const transfer: Transferable[] = [];
  try {
    for (const crop of message.crops) {
      try {
        if (!landmarker) break;
        const analyzed = analyze(crop.bitmap);
        hands.push(analyzed.result);
        transfer.push(...analyzed.transfer);
      } finally {
        crop.bitmap.close();
      }
    }
    post({ type: 'result', id: message.id, hands, inferenceMs: performance.now() - started }, transfer);
  } catch (error) {
    for (const crop of message.crops) crop.bitmap.close();
    post({ type: 'error', duringInit: false, message: `Fallo el análisis de manos: ${describe(error)}` });
  }
}

self.addEventListener('message', (event: MessageEvent<HandsToWorker>) => {
  const message = event.data;
  if (message.type === 'init') void init(message);
  else if (message.type === 'frame') handleFrame(message);
});
