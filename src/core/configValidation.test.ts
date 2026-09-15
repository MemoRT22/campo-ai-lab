import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { resolveConfig } from './configOverrides';
import { validateConfig } from './configValidation';

describe('config validation', () => {
  it('normaliza rangos peligrosos y conserva una configuración utilizable', () => {
    const config = resolveConfig(
      '?camera.frameRate=0&vision.inferenceWidth=-10&vision.maskThreshold=4&particles.particleCount=-2&camera.crop={"x":0,"width":0}',
      null,
    );
    expect(config.camera.frameRate).toBe(1);
    expect(config.vision.inferenceWidth).toBe(defaultConfig.vision.inferenceWidth);
    expect(config.vision.maskThreshold).toBe(1);
    expect(config.particles.particleCount).toBe(defaultConfig.particles.particleCount);
    expect(config.camera.crop).toEqual(defaultConfig.camera.crop);
  });

  it('rechaza NaN, Infinity y listas de reintento vacías', () => {
    const unsafe = structuredClone(defaultConfig);
    unsafe.vision.processingFPS = Number.NaN;
    unsafe.typography.scale = Number.POSITIVE_INFINITY;
    unsafe.camera.retryDelaysMs = [];
    const config = validateConfig(unsafe);
    expect(config.vision.processingFPS).toBe(defaultConfig.vision.processingFPS);
    expect(config.typography.scale).toBe(defaultConfig.typography.scale);
    expect(config.camera.retryDelaysMs).toEqual(defaultConfig.camera.retryDelaysMs);
  });

  it('sólo carga claves técnicas permitidas del almacenamiento', () => {
    const config = resolveConfig('', {
      'vision.maskThreshold': 0.41,
      'branding.brandName': 'NO DEBE CAMBIAR',
    });
    expect(config.vision.maskThreshold).toBe(0.41);
    expect(config.branding.brandName).toBe(defaultConfig.branding.brandName);
  });
});
