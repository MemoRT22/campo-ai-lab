import type { Config } from '../config';
import type { Experience } from '../core/Experience';
import { GROUP_PAIR, type GroupInteraction } from '../particles/GroupInteraction';
import type { ParticleSystem } from '../particles/ParticleSystem';
import type { TargetField } from '../particles/TargetField';
import { screenScale } from '../utils/MathUtils';
import type { GestureEvent, GesturePoint, GestureType } from './GestureEvents';
import { GestureResonance } from './GestureResonance';

/** Traduce eventos de gesto en reacciones visuales y en avance de la narrativa. */
export class InteractionManager {
  lastGesture: GestureEvent | null = null;

  /** Cooldown por gesto y persona: dos personas pueden levantar la mano casi a la vez. */
  private readonly lastTriggered = new Map<string, number>();
  private readonly screenPoint = { x: 0, y: 0 };
  private readonly resonance: GestureResonance;

  constructor(
    private readonly config: Config,
    private readonly particles: ParticleSystem,
    private readonly field: TargetField,
    private readonly experience: Experience,
    private readonly group: GroupInteraction | null = null,
  ) {
    this.resonance = new GestureResonance(config.particles.groupInteraction.resonanceWindowMs);
  }

  handle(event: GestureEvent, now: number): boolean {
    // El reconocedor debe emitir sólo flancos de subida; el cooldown es una segunda red de seguridad.
    const key = `${event.type}:${event.personId}`;
    if (now - (this.lastTriggered.get(key) ?? -Infinity) < this.config.experience.gestureCooldown) return false;
    this.lastTriggered.set(key, now);
    this.lastGesture = event;

    if (event.type === 'ONE_HAND_UP') {
      for (const point of event.points) this.waveAt(point, event.personId, now, 1);
      if (event.points.length > 0) this.resonate(event.points[0], event.personId, now);
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
    this.handle(this.simulatedEvent(type, person, now), now);
  }

  /** Sólo debug: ONE_HAND_UP simultáneo de las dos primeras siluetas confirmadas. */
  simulateGroupWave(now: number): void {
    const people = this.field.lastPeople.filter((p) => p.confirmed).slice(0, 2);
    for (const person of people) this.handle(this.simulatedEvent('ONE_HAND_UP', person, now), now);
  }

  private simulatedEvent(type: GestureType, person: TargetField['lastPeople'][number] | undefined, now: number): GestureEvent {
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
    return { type, personId: person ? person.id : -1, points, timestamp: now, confidence: 1, source: 'simulated' };
  }

  private waveAt(point: GesturePoint, personId: number, now: number, strength: number): void {
    const screen = this.field.cameraToScreen(point.x, point.y, this.screenPoint);
    this.particles.emitWave(screen.x, screen.y, now, strength, personId);
  }

  /** Dos ondas de personas distintas en la ventana: se encuentran a mitad de camino. */
  private resonate(point: GesturePoint, personId: number, now: number): void {
    const group = this.group;
    const settings = this.config.particles;
    if (!group || !settings.groupInteraction.enabled) return;
    const screen = this.field.cameraToScreen(point.x, point.y, this.screenPoint);
    const partner = this.resonance.register(personId, screen.x, screen.y, now);
    if (!partner || group.mode < GROUP_PAIR) return;
    if (this.field.personIndex(personId) < 0 || this.field.personIndex(partner.personId) < 0) return;
    const halfway = Math.hypot(screen.x - partner.x, screen.y - partner.y) / 2;
    const frontSpeed = settings.waveSpeed * screenScale(this.field.width, this.field.height);
    const delay = Math.min(settings.groupInteraction.resonanceMaxDelayMs, halfway / frontSpeed);
    this.particles.resonate((screen.x + partner.x) / 2, (screen.y + partner.y) / 2, delay, now);
  }
}
