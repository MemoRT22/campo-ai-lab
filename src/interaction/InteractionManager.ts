import type { Config } from '../config';
import type { Experience } from '../core/Experience';
import type { ParticleSystem } from '../particles/ParticleSystem';
import type { TargetField } from '../particles/TargetField';
import type { GestureEvent, GesturePoint, GestureType } from './GestureEvents';

/** Traduce eventos de gesto en reacciones visuales y en avance de la narrativa. */
export class InteractionManager {
  lastGesture: GestureEvent | null = null;

  private readonly lastTriggered: Record<GestureType, number> = {
    ONE_HAND_UP: -Infinity,
    BOTH_HANDS_UP: -Infinity,
  };
  private readonly screenPoint = { x: 0, y: 0 };

  constructor(
    private readonly config: Config,
    private readonly particles: ParticleSystem,
    private readonly field: TargetField,
    private readonly experience: Experience,
  ) {}

  handle(event: GestureEvent, now: number): boolean {
    // El reconocedor debe emitir sólo flancos de subida; el cooldown es una segunda red de seguridad.
    if (now - this.lastTriggered[event.type] < this.config.experience.gestureCooldown) return false;
    this.lastTriggered[event.type] = now;
    this.lastGesture = event;

    if (event.type === 'ONE_HAND_UP') {
      for (const point of event.points) this.waveAt(point, event.personId, now, 1);
    } else {
      const { revealExpandMs, revealSuspendMs, revealRecoverMs } = this.config.particles;
      this.particles.celebrate(now, revealExpandMs + revealSuspendMs + revealRecoverMs, 3);
      for (const point of event.points) this.waveAt(point, event.personId, now, 1.4);
    }
    this.experience.onGesture(event, now);
    return true;
  }

  /** Sólo debug: dispara un gesto sobre la primera silueta confirmada. */
  simulate(type: GestureType, now: number): void {
    const person = this.field.lastPeople.find((p) => p.confirmed);
    const x0 = person ? person.x0 : 0.4;
    const x1 = person ? person.x1 : 0.6;
    const top = person ? person.y0 + (person.y1 - person.y0) * 0.06 : 0.35;
    const width = x1 - x0;
    const points: GesturePoint[] =
      type === 'ONE_HAND_UP'
        ? [{ x: x0 + width * 0.18, y: top }]
        : [
            { x: x0 + width * 0.18, y: top },
            { x: x1 - width * 0.18, y: top },
          ];
    this.handle({ type, personId: person ? person.id : -1, points, timestamp: now, confidence: 1, source: 'simulated' }, now);
  }

  private waveAt(point: GesturePoint, personId: number, now: number, strength: number): void {
    const screen = this.field.cameraToScreen(point.x, point.y, this.screenPoint);
    this.particles.emitWave(screen.x, screen.y, now, strength, personId);
  }
}
