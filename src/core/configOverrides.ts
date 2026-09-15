import { defaultConfig, type Config } from '../config';

const ALIASES: Record<string, string> = {
  debug: 'debugMode',
  mock: 'mockVision',
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copia la configuración por defecto y aplica parámetros de la URL.
 *   ?debug                       → debugMode = true
 *   ?camera=Logitech | ?camera=1 → cámara por nombre o índice
 *   ?vision.maskThreshold=0.5    → cualquier valor por su ruta
 *   ?camera.crop={"x":0,"y":0.1,"width":1,"height":0.9}
 */
export function resolveConfig(search: string): Config {
  const config = structuredClone(defaultConfig);
  const params = new URLSearchParams(search);

  for (const [key, value] of params) {
    if (key === 'camera') {
      if (/^\d+$/.test(value)) config.camera.deviceIndex = Number(value);
      else config.camera.deviceLabel = value;
      continue;
    }
    const path = (ALIASES[key] ?? key).split('.');
    if (!applyOverride(config as unknown as Record<string, unknown>, path, value)) {
      console.warn(`[config] Parámetro ignorado: ${key}=${value}`);
    }
  }
  return config;
}

function applyOverride(root: Record<string, unknown>, path: string[], raw: string): boolean {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = node[path[i]];
    if (FORBIDDEN_KEYS.has(path[i]) || !Object.hasOwn(node, path[i]) || typeof next !== 'object' || next === null) return false;
    node = next as Record<string, unknown>;
  }

  const key = path[path.length - 1];
  if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(node, key)) return false;
  const current = node[key];

  switch (typeof current) {
    case 'number': {
      const parsed = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(parsed)) return false;
      node[key] = parsed;
      return true;
    }
    case 'boolean':
      node[key] = raw === '' || raw === 'true' || raw === '1';
      return true;
    case 'string':
      node[key] = raw;
      return true;
    case 'object': {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) !== Array.isArray(current)) return false;
        node[key] = Array.isArray(parsed) ? parsed : { ...(current as object), ...parsed };
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
