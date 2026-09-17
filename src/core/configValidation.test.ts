import { describe, expect, it } from 'vitest';
import { FULL_FRAME, captureRegion, defaultConfig, frameRegion } from '../config';
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

  it('mantiene STANDARD intacto y aplica únicamente el preset LARGE solicitado', () => {
    const standard = resolveConfig('?displayProfile=standard', null);
    const large = resolveConfig('?displayProfile=large', null);

    expect(standard.displayProfile).toBe('standard');
    expect(standard.vision.inferenceWidth).toBe(defaultConfig.vision.inferenceWidth);
    expect(standard.particles.particleSize).toEqual(defaultConfig.particles.particleSize);
    expect(large.displayProfile).toBe('large');
    expect(large.vision.inferenceWidth).toBe(480);
    expect(large.vision.maskThreshold).toBeLessThan(standard.vision.maskThreshold);
    expect(large.vision.smoothingReleaseMs).toBeGreaterThan(standard.vision.smoothingReleaseMs);
    expect(large.particles.particleSize.far).toBeGreaterThan(standard.particles.particleSize.far);
    expect(large.particles.edgeBrightness).toBeGreaterThan(standard.particles.edgeBrightness);
    expect(large.particles.silhouette.edgeSize).toBeGreaterThan(standard.particles.silhouette.edgeSize);
    expect(large.particles.bodyParticleBudget).toBeLessThanOrEqual(large.particles.particleCount);
  });

  it('permite comparar presets y sobreescribir un valor LARGE explícitamente por URL', () => {
    const config = resolveConfig('?displayProfile=large&vision.inferenceWidth=640&particles.particleSpacing=6', null);
    expect(config.displayProfile).toBe('large');
    expect(config.vision.inferenceWidth).toBe(640);
    expect(config.particles.particleSpacing).toBe(6);
  });

  it('descarta perfiles desconocidos y conserva los rangos del preset LARGE', () => {
    const invalid = resolveConfig('?displayProfile=wall', null);
    const large = resolveConfig('?displayProfile=large', null);
    expect(invalid.displayProfile).toBe('standard');
    expect(large.vision.maskThreshold).toBeGreaterThanOrEqual(0);
    expect(large.vision.maskThreshold).toBeLessThanOrEqual(1);
    expect(large.particles.particleDensity.far).toBeGreaterThan(0);
    expect(large.particles.particleDensity.close).toBeLessThanOrEqual(1);
  });

  it('limita densidad, tamaños y refuerzo de borde a rangos seguros', () => {
    const unsafe = structuredClone(defaultConfig);
    unsafe.particles.particleDensity.far = -2;
    unsafe.particles.particleDensity.close = 4;
    unsafe.particles.particleSize.far = 100;
    unsafe.particles.particleOpacity.far = 3;
    unsafe.particles.silhouette.edgeSize = 9;
    unsafe.particles.edgeBrightness = -1;
    const config = validateConfig(unsafe);
    expect(config.particles.particleDensity.far).toBe(0.05);
    expect(config.particles.particleDensity.close).toBe(1);
    expect(config.particles.particleSize.far).toBe(12);
    expect(config.particles.particleOpacity.far).toBe(1);
    expect(config.particles.silhouette.edgeSize).toBe(2);
    expect(config.particles.edgeBrightness).toBe(0.5);
  });
});

describe('región de captura', () => {
  it('sin recorte no cambia nada', () => {
    const config = resolveConfig('', null);
    expect(captureRegion(config)).toEqual(FULL_FRAME);
    expect(frameRegion(config)).toEqual(config.camera.crop);
  });

  it('una banda ancha no puede acercarse: estirarla deformaría a las personas', () => {
    const config = resolveConfig('?camera.crop={"x":0,"y":0.2,"width":1,"height":0.6}', null);
    expect(captureRegion(config)).toEqual(FULL_FRAME);
    // El recorte se sigue aplicando después de inferir, como siempre.
    expect(frameRegion(config)).toEqual(config.camera.crop);
  });

  it('un recorte en ancho y alto acerca el modelo y deja la zona visible igual', () => {
    const config = resolveConfig('?camera.crop={"x":0.25,"y":0.1,"width":0.5,"height":0.4}', null);
    const region = captureRegion(config);
    // Mismo aspecto que el encuadre (ancho y alto normalizados iguales): 2× de resolución lineal.
    expect(region.width).toBeCloseTo(0.5, 6);
    expect(region.height).toBeCloseTo(0.5, 6);
    const rest = frameRegion(config);
    // Lo que se ve sigue siendo exactamente el recorte pedido, ahora relativo a lo capturado.
    expect(region.x + rest.x * region.width).toBeCloseTo(0.25, 6);
    expect(region.y + rest.y * region.height).toBeCloseTo(0.1, 6);
    expect(rest.width * region.width).toBeCloseTo(0.5, 6);
    expect(rest.height * region.height).toBeCloseTo(0.4, 6);
  });

  it('respeta los bordes del encuadre', () => {
    const config = resolveConfig('?camera.crop={"x":0,"y":0,"width":0.4,"height":0.2}', null);
    const region = captureRegion(config);
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(1);
    expect(region.y + region.height).toBeLessThanOrEqual(1);
  });
});

describe('mock y recorte', () => {
  it('con mock el recorte vuelve a aplicarse después de inferir', () => {
    const config = resolveConfig('?mock=true&camera.crop={"x":0.25,"y":0.25,"width":0.5,"height":0.5}', null);
    expect(config.vision.cropAtCapture).toBe(false);
    expect(captureRegion(config)).toEqual(FULL_FRAME);
    expect(frameRegion(config)).toEqual(config.camera.crop);
  });
});
