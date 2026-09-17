import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { MaskProcessor, maskSettingsFrom } from './MaskProcessor';

describe('MaskProcessor', () => {
  it('segmenta una persona, confirma presencia y aplica histéresis', () => {
    const config = structuredClone(defaultConfig);
    config.vision.spatialBlurRadius = 0;
    config.vision.smoothingAttackMs = 0;
    config.vision.smoothingReleaseMs = 0;
    config.vision.presenceConfirmMs = 0;
    config.vision.minPersonArea = 0.01;
    const processor = new MaskProcessor(maskSettingsFrom(config));
    const confidence = new Float32Array(100);
    for (let y = 2; y < 8; y++) for (let x = 3; x < 7; x++) confidence[y * 10 + x] = 0.8;
    const map = new Uint8Array(100);

    const people = processor.process(confidence, 10, 10, 0, map);
    expect(people).toHaveLength(1);
    expect(people[0].confirmed).toBe(true);
    expect(map.filter(Boolean).length).toBe(24);

    confidence.fill(0);
    for (let y = 2; y < 8; y++) for (let x = 3; x < 7; x++) confidence[y * 10 + x] = 0.45;
    expect(processor.process(confidence, 10, 10, 33, map)).toHaveLength(1);
    confidence.fill(0.3);
    expect(processor.process(confidence, 10, 10, 66, map)).toHaveLength(0);
  });

  it('respeta un ROI y descarta componentes fuera de él', () => {
    const config = structuredClone(defaultConfig);
    config.vision.spatialBlurRadius = 0;
    config.vision.smoothingAttackMs = 0;
    config.vision.presenceConfirmMs = 0;
    config.camera.crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const processor = new MaskProcessor(maskSettingsFrom(config));
    const confidence = new Float32Array(100).fill(1);
    const map = new Uint8Array(100);
    processor.process(confidence, 10, 10, 0, map);
    expect(map.filter(Boolean).length).toBe(50);
  });
});

describe('MaskProcessor confidence output', () => {
  it('entrega la confianza suavizada cuantizada y en cero fuera del ROI', () => {
    const config = structuredClone(defaultConfig);
    config.vision.spatialBlurRadius = 0;
    config.vision.smoothingAttackMs = 0;
    config.vision.presenceConfirmMs = 0;
    config.camera.crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const processor = new MaskProcessor(maskSettingsFrom(config));
    const confidence = new Float32Array(100).fill(0.75);
    const map = new Uint8Array(100);
    const out = new Uint8Array(100);
    processor.process(confidence, 10, 10, 0, map, out);
    expect(out[5 * 10 + 7]).toBe(Math.round(0.75 * 255));
    expect(out[5 * 10 + 2]).toBe(0);
  });
});

describe('MaskProcessor temporal continuity', () => {
  it('conserva una extremidad perdida durante un frame pero no deja un fantasma largo', () => {
    const config = structuredClone(defaultConfig);
    config.vision.spatialBlurRadius = 0;
    config.vision.smoothingAttackMs = 0;
    config.vision.smoothingReleaseMs = 90;
    config.vision.maskThreshold = 0.56;
    config.vision.maskHysteresis = 0.22;
    config.vision.presenceConfirmMs = 0;
    config.vision.minPersonArea = 0.001;
    const processor = new MaskProcessor(maskSettingsFrom(config));
    const confidence = new Float32Array(20 * 10);
    const map = new Uint8Array(confidence.length);

    // Torso conectado a un brazo horizontal fino.
    for (let y = 2; y < 9; y++) for (let x = 7; x < 13; x++) confidence[y * 20 + x] = 1;
    for (let x = 2; x < 8; x++) confidence[4 * 20 + x] = 1;
    processor.process(confidence, 20, 10, 0, map);
    expect(map[4 * 20 + 3]).toBeGreaterThan(0);

    // La fuente pierde el brazo durante 33 ms; el release temporal conserva su lectura.
    for (let x = 2; x < 7; x++) confidence[4 * 20 + x] = 0;
    processor.process(confidence, 20, 10, 33, map);
    expect(map[4 * 20 + 3]).toBeGreaterThan(0);

    // Tras varias constantes de tiempo desaparece: no queda un brazo fantasma por segundos.
    for (let t = 66; t <= 396; t += 33) processor.process(confidence, 20, 10, t, map);
    expect(map[4 * 20 + 3]).toBe(0);
  });
});
