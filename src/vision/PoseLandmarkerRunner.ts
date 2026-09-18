import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Config, Delegate } from '../config';
import type { PoseInfo } from './types';

const WARM_UP_WIDTH = 320;
const WARM_UP_HEIGHT = 180;

export class PoseLandmarkerRunner {
  private landmarker: PoseLandmarker | null = null;

  async init(wasmBaseUrl: string, modelUrl: string, delegate: Delegate, settings: Config['vision']): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      numPoses: settings.maxPeople,
      minPoseDetectionConfidence: settings.poseDetectionConfidence,
      minPosePresenceConfidence: settings.posePresenceConfidence,
      minTrackingConfidence: settings.poseTrackingConfidence,
      outputSegmentationMasks: false,
    });
    this.warmUp();
  }

  detect(frame: ImageBitmap, timestamp: number): PoseInfo[] {
    if (!this.landmarker) throw new Error('Pose Landmarker no inicializado');
    const result = this.landmarker.detectForVideo(frame, timestamp);
    return result.landmarks.map((landmarks) => ({ landmarks: landmarks.map(copyLandmark) }));
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }

  private warmUp(): void {
    const landmarker = this.landmarker;
    if (!landmarker) return;
    const canvas = new OffscreenCanvas(WARM_UP_WIDTH, WARM_UP_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillRect(0, 0, WARM_UP_WIDTH, WARM_UP_HEIGHT);
    const frame = canvas.transferToImageBitmap();
    try {
      landmarker.detectForVideo(frame, 1);
    } finally {
      frame.close();
    }
  }
}

function copyLandmark(point: NormalizedLandmark) {
  return { x: point.x, y: point.y, z: point.z, visibility: point.visibility };
}
