import type { Config } from '../config';
import { saveCalibrationOverrides } from '../core/configOverrides';

interface Control {
  path: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

/** Controles técnicos explícitos. El único dato persistido son estos escalares y el ROI. */
export class CalibrationPanel {
  private readonly values = new Map<string, HTMLInputElement>();

  constructor(root: HTMLElement, config: Config) {
    const panel = document.createElement('section');
    panel.className = 'calibration';
    const title = document.createElement('h2');
    title.textContent = 'CALIBRACIÓN';
    const note = document.createElement('p');
    note.textContent = 'Sólo se guardan parámetros técnicos. Nunca imagen, video o landmarks.';
    panel.append(title, note);

    const controls: Control[] = [
      { path: 'vision.maskThreshold', label: 'Mask threshold', value: config.vision.maskThreshold, min: 0, max: 1, step: 0.01 },
      { path: 'vision.minPersonArea', label: 'Área mínima', value: config.vision.minPersonArea, min: 0, max: 0.2, step: 0.001 },
      { path: 'vision.smoothingAttackMs', label: 'Smoothing attack ms', value: config.vision.smoothingAttackMs, min: 0, max: 1000, step: 5 },
      { path: 'vision.smoothingReleaseMs', label: 'Smoothing release ms', value: config.vision.smoothingReleaseMs, min: 0, max: 2000, step: 5 },
      { path: 'vision.inferenceWidth', label: 'Inference width', value: config.vision.inferenceWidth, min: 128, max: 1280, step: 16 },
      { path: 'vision.processingFPS', label: 'Segmentation FPS', value: config.vision.processingFPS, min: 1, max: 60, step: 1 },
      { path: 'vision.poseDetectionConfidence', label: 'Pose confidence', value: config.vision.poseDetectionConfidence, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.x', label: 'ROI x', value: config.camera.crop.x, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.y', label: 'ROI y', value: config.camera.crop.y, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.width', label: 'ROI width', value: config.camera.crop.width, min: 0.01, max: 1, step: 0.01 },
      { path: 'camera.crop.height', label: 'ROI height', value: config.camera.crop.height, min: 0.01, max: 1, step: 0.01 },
      { path: 'typography.scale', label: 'Typography scale', value: config.typography.scale, min: 0.25, max: 5, step: 0.05 },
      { path: 'particles.particleSpacing', label: 'Particle spacing', value: config.particles.particleSpacing, min: 2, max: 80, step: 0.5 },
      { path: 'particles.trackingResponseMs', label: 'Tracking response ms', value: config.particles.trackingResponseMs, min: 60, max: 140, step: 5 },
      { path: 'particles.trackingAttraction', label: 'Tracking attraction', value: config.particles.trackingAttraction, min: 0.1, max: 1, step: 0.01 },
      { path: 'particles.trackingDamping', label: 'Tracking damping', value: config.particles.trackingDamping, min: 0.1, max: 0.9, step: 0.01 },
      { path: 'particles.predictionMs', label: 'Prediction ms (0 = off)', value: config.particles.predictionMs, min: 0, max: 120, step: 2 },
      { path: 'particles.predictionMaxDistance', label: 'Prediction max px', value: config.particles.predictionMaxDistance, min: 0, max: 120, step: 1 },
      { path: 'particles.maxSpeed', label: 'Particle max speed', value: config.particles.maxSpeed, min: 1, max: 200, step: 1 },
    ];

    const form = document.createElement('div');
    form.className = 'calibration__form';
    for (const control of controls) form.appendChild(this.control(control));
    panel.appendChild(form);

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'APLICAR AJUSTES';
    apply.addEventListener('click', () => this.saveAndReload());
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'is-secondary';
    reset.textContent = 'RESTABLECER';
    reset.addEventListener('click', () => {
      saveCalibrationOverrides({});
      window.location.reload();
    });
    panel.append(apply, reset);
    root.appendChild(panel);
  }

  private control(control: Control): HTMLElement {
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = control.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(control.value);
    this.values.set(control.path, input);
    label.append(text, input);
    return label;
  }

  private saveAndReload(): void {
    const values: Record<string, unknown> = {};
    const crop: Record<string, number> = {};
    for (const [path, input] of this.values) {
      const value = Number(input.value);
      if (path.startsWith('camera.crop.')) crop[path.slice('camera.crop.'.length)] = value;
      else values[path] = value;
    }
    values['camera.crop'] = crop;
    saveCalibrationOverrides(values);
    window.location.reload();
  }
}
