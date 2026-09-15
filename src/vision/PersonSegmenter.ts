import { FilesetResolver, ImageSegmenter, type MPMask } from '@mediapipe/tasks-vision';
import type { Delegate } from '../config';

type MaskCallback = (confidence: Float32Array, width: number, height: number) => void;

const WARM_UP_WIDTH = 320;
const WARM_UP_HEIGHT = 180;

/**
 * Envoltura del ImageSegmenter de MediaPipe. Pensado para correr dentro del worker.
 *
 * Sólo intenta un delegado: el runtime WASM no puede instanciarse dos veces en el mismo
 * worker, así que el fallback GPU → CPU se hace creando un worker nuevo.
 */
export class PersonSegmenter {
  delegate: Delegate = 'GPU';
  labels: string[] = [];

  private segmenter: ImageSegmenter | null = null;
  private maskIndex = -1;

  async init(wasmBaseUrl: string, modelUrl: string, delegate: Delegate): Promise<void> {
    // `true` carga la variante ES module del runtime: los module workers no admiten importScripts.
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    this.delegate = delegate;
    this.labels = this.segmenter.getLabels();
    this.warmUp();
  }

  /** Llama a `onMask` de forma síncrona; los datos sólo son válidos durante el callback. */
  segment(frame: ImageBitmap, timestamp: number, onMask: MaskCallback): void {
    if (!this.segmenter) throw new Error('Segmentador no inicializado');
    this.segmenter.segmentForVideo(frame, timestamp, (result) => {
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return;
      if (this.maskIndex < 0) this.maskIndex = this.resolvePersonMask(masks);
      const mask = masks[Math.min(this.maskIndex, masks.length - 1)];
      onMask(mask.getAsFloat32Array(), mask.width, mask.height);
    });
  }

  close(): void {
    this.segmenter?.close();
    this.segmenter = null;
  }

  /**
   * La primera inferencia compila shaders y puede tardar varios segundos en GPU.
   * Se paga aquí, antes de anunciar que el modelo está listo, y no con la primera persona.
   */
  private warmUp(): void {
    const canvas = new OffscreenCanvas(WARM_UP_WIDTH, WARM_UP_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx || !this.segmenter) return;
    ctx.fillRect(0, 0, WARM_UP_WIDTH, WARM_UP_HEIGHT);
    const frame = canvas.transferToImageBitmap();
    try {
      this.segmenter.segmentForVideo(frame, 1, (result) => {
        result.confidenceMasks?.[0]?.getAsFloat32Array();
      });
    } finally {
      frame.close();
    }
  }

  private resolvePersonMask(masks: MPMask[]): number {
    if (masks.length === 1) return 0;
    const index = this.labels.findIndex((label) => /person|selfie|foreground|human/i.test(label));
    return index >= 0 ? index : masks.length - 1;
  }
}
