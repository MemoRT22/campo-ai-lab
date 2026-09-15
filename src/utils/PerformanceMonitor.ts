const WINDOW_MS = 1000;
const EMA = 0.15;

export class PerformanceMonitor {
  renderFps = 0;
  segmentationFps = 0;
  poseFps = 0;
  /** Tiempo de JS por frame en el hilo principal (simulación + subida de buffers). */
  frameMs = 0;
  inferenceMs = 0;
  poseInferenceMs = 0;
  maskProcessingMs = 0;
  /** Desde la captura del frame de cámara hasta que llega el resultado al hilo principal. */
  visionLatencyMs = 0;

  private frames = 0;
  private visionFrames = 0;
  private poseFrames = 0;
  private windowStart = 0;
  private frameStart = 0;

  beginFrame(now: number): void {
    this.frameStart = performance.now();
    if (this.windowStart === 0) this.windowStart = now;
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed >= WINDOW_MS) {
      this.renderFps = (this.frames * 1000) / elapsed;
      this.segmentationFps = (this.visionFrames * 1000) / elapsed;
      this.poseFps = (this.poseFrames * 1000) / elapsed;
      this.frames = 0;
      this.visionFrames = 0;
      this.poseFrames = 0;
      this.windowStart = now;
    }
  }

  endFrame(): void {
    this.frameMs += (performance.now() - this.frameStart - this.frameMs) * EMA;
  }

  recordVision(inferenceMs: number, processingMs: number, captureTime: number, now: number): void {
    this.visionFrames++;
    this.inferenceMs += (inferenceMs - this.inferenceMs) * EMA;
    this.maskProcessingMs += (processingMs - this.maskProcessingMs) * EMA;
    this.visionLatencyMs += (now - captureTime - this.visionLatencyMs) * EMA;
  }

  recordPose(inferenceMs: number): void {
    this.poseFrames++;
    this.poseInferenceMs += (inferenceMs - this.poseInferenceMs) * EMA;
  }
}
