import type { Config } from '../config';
import { saveCalibrationOverrides } from '../core/configOverrides';

interface Control {
  path: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  presets?: number[];
  unit?: string;
}

/** Controles técnicos explícitos. El único dato persistido son estos escalares y el ROI. */
export class CalibrationPanel {
  private readonly values = new Map<string, HTMLInputElement | HTMLSelectElement>();

  constructor(root: HTMLElement, config: Config) {
    const panel = document.createElement('section');
    panel.className = 'calibration';
    const title = document.createElement('h2');
    title.textContent = 'CALIBRACIÓN';
    const note = document.createElement('p');
    note.textContent = 'Sólo se guardan parámetros técnicos. Nunca imagen, video o landmarks.';
    panel.append(title, note);

    const controls: Control[] = [
      { path: 'camera.cameraWidth', label: 'Camera request width', value: config.camera.cameraWidth, min: 320, max: 3840, step: 1, presets: [1280, 1920, 3840], unit: 'px' },
      { path: 'camera.cameraHeight', label: 'Camera request height', value: config.camera.cameraHeight, min: 180, max: 2160, step: 1, presets: [720, 1080, 2160], unit: 'px' },
      { path: 'camera.frameRate', label: 'Camera request FPS', value: config.camera.frameRate, min: 1, max: 120, step: 1, presets: [30, 60], unit: 'fps' },
      { path: 'vision.maskThreshold', label: 'Mask threshold', value: config.vision.maskThreshold, min: 0, max: 1, step: 0.01 },
      { path: 'vision.maskHysteresis', label: 'Mask hysteresis', value: config.vision.maskHysteresis, min: 0, max: 0.5, step: 0.01 },
      { path: 'vision.minPersonArea', label: 'Área mínima', value: config.vision.minPersonArea, min: 0, max: 0.2, step: 0.001 },
      { path: 'vision.smoothingAttackMs', label: 'Smoothing attack ms', value: config.vision.smoothingAttackMs, min: 0, max: 1000, step: 5 },
      { path: 'vision.smoothingReleaseMs', label: 'Smoothing release ms', value: config.vision.smoothingReleaseMs, min: 0, max: 2000, step: 5 },
      { path: 'vision.spatialBlurRadius', label: 'Blur espacial px', value: config.vision.spatialBlurRadius, min: 0, max: 4, step: 1 },
      { path: 'vision.inferenceWidth', label: 'Inference preset', value: config.vision.inferenceWidth, min: 320, max: 640, step: 160, presets: [320, 480, 640], unit: 'px' },
      { path: 'vision.processingFPS', label: 'Segmentation FPS', value: config.vision.processingFPS, min: 1, max: 60, step: 1 },
      { path: 'vision.poseDetectionConfidence', label: 'Pose confidence', value: config.vision.poseDetectionConfidence, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.x', label: 'ROI x', value: config.camera.crop.x, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.y', label: 'ROI y', value: config.camera.crop.y, min: 0, max: 1, step: 0.01 },
      { path: 'camera.crop.width', label: 'ROI width', value: config.camera.crop.width, min: 0.01, max: 1, step: 0.01 },
      { path: 'camera.crop.height', label: 'ROI height', value: config.camera.crop.height, min: 0.01, max: 1, step: 0.01 },
      { path: 'typography.scale', label: 'Typography scale', value: config.typography.scale, min: 0.25, max: 5, step: 0.05 },
      { path: 'layout.sideColumnWidth', label: 'Text column width', value: config.layout.sideColumnWidth, min: 0.1, max: 0.45, step: 0.01 },
      { path: 'particles.particleSpacing', label: 'Particle spacing', value: config.particles.particleSpacing, min: 2, max: 80, step: 0.5 },
      { path: 'particles.bodyParticleBudget', label: 'Body particle budget', value: config.particles.bodyParticleBudget, min: 1000, max: config.particles.particleCount, step: 500 },
      { path: 'particles.particleDensity.far', label: 'Density far', value: config.particles.particleDensity.far, min: 0.05, max: 1, step: 0.05 },
      { path: 'particles.particleDensity.close', label: 'Density close', value: config.particles.particleDensity.close, min: 0.05, max: 1, step: 0.05 },
      { path: 'particles.particleSize.idle', label: 'Point size idle', value: config.particles.particleSize.idle, min: 0.2, max: 8, step: 0.05 },
      { path: 'particles.particleSize.far', label: 'Point size far', value: config.particles.particleSize.far, min: 0.2, max: 8, step: 0.05 },
      { path: 'particles.particleSize.close', label: 'Point size close', value: config.particles.particleSize.close, min: 0.2, max: 8, step: 0.05 },
      { path: 'particles.particleOpacity.far', label: 'Opacity far', value: config.particles.particleOpacity.far, min: 0, max: 1, step: 0.01 },
      { path: 'particles.particleOpacity.close', label: 'Opacity close', value: config.particles.particleOpacity.close, min: 0, max: 1, step: 0.01 },
      { path: 'particles.silhouette.contourThreshold', label: 'Contour threshold', value: config.particles.silhouette.contourThreshold, min: 0.05, max: 0.95, step: 0.01 },
      { path: 'particles.silhouette.contourHysteresis', label: 'Contour hysteresis', value: config.particles.silhouette.contourHysteresis, min: 0, max: 0.3, step: 0.01 },
      { path: 'particles.silhouette.edgeSize', label: 'Edge point size', value: config.particles.silhouette.edgeSize, min: 0.5, max: 2, step: 0.02 },
      { path: 'particles.edgeBrightness', label: 'Edge brightness', value: config.particles.edgeBrightness, min: 0.5, max: 4, step: 0.05 },
      { path: 'particles.occlusionGraceMs', label: 'Occlusion grace ms', value: config.particles.occlusionGraceMs, min: 0, max: 500, step: 10 },
      { path: 'particles.trackingResponseMs', label: 'Tracking response ms', value: config.particles.trackingResponseMs, min: 60, max: 240, step: 5 },
      { path: 'particles.trackingAttraction', label: 'Tracking attraction', value: config.particles.trackingAttraction, min: 0.1, max: 1, step: 0.01 },
      { path: 'particles.trackingDamping', label: 'Tracking damping', value: config.particles.trackingDamping, min: 0.1, max: 0.9, step: 0.01 },
      { path: 'particles.trackingSnap', label: 'Tracking snap', value: config.particles.trackingSnap, min: 0, max: 0.9, step: 0.01 },
      { path: 'particles.fastMotionSnap', label: 'Fast motion snap', value: config.particles.fastMotionSnap, min: 0, max: 0.9, step: 0.01 },
      { path: 'particles.interpolationMaxMs', label: 'Interpolation ms (0 = off)', value: config.particles.interpolationMaxMs, min: 0, max: 100, step: 5 },
      { path: 'particles.predictionMs', label: 'Prediction ms (0 = off)', value: config.particles.predictionMs, min: 0, max: 120, step: 2 },
      { path: 'particles.predictionMaxDistance', label: 'Prediction max px', value: config.particles.predictionMaxDistance, min: 0, max: 120, step: 1 },
      { path: 'particles.maxSpeed', label: 'Particle max speed', value: config.particles.maxSpeed, min: 1, max: 200, step: 1 },
    ];

    const form = document.createElement('div');
    form.className = 'calibration__form';
    for (const control of controls) form.appendChild(this.control(control));
    panel.appendChild(form);

    const profile = document.createElement('p');
    profile.className = 'calibration__profile';
    const standard = this.profileLink('STANDARD', 'standard', config.displayProfile);
    const large = this.profileLink('LARGE DISPLAY', 'large', config.displayProfile);
    profile.append('Perfil: ', standard, ' · ', large);
    panel.insertBefore(profile, form);

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
    const input = control.presets ? document.createElement('select') : document.createElement('input');
    if (input instanceof HTMLInputElement) {
      input.type = 'number';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.value = String(control.value);
    } else {
      const choices = control.presets!;
      const presets = choices.includes(control.value) ? choices : [control.value, ...choices];
      for (const value of presets) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value}${control.unit ? ` ${control.unit}` : ''}`;
        input.appendChild(option);
      }
      input.value = String(control.value);
    }
    this.values.set(control.path, input);
    label.append(text, input);
    return label;
  }

  private profileLink(label: string, profile: Config['displayProfile'], active: Config['displayProfile']): HTMLAnchorElement {
    const link = document.createElement('a');
    const url = new URL(window.location.href);
    url.searchParams.set('displayProfile', profile);
    url.searchParams.set('calibrate', 'true');
    link.href = url.href;
    link.textContent = profile === active ? `[${label}]` : label;
    return link;
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
