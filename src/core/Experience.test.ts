import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import type { GestureEvent } from '../interaction/GestureEvents';
import { Experience, type ExperienceBrand, type ExperienceOverlay, type ExperiencePrivacy } from './Experience';

class OverlaySpy implements ExperienceOverlay {
  activeId: string | null = null;
  shown: string[] = [];
  show(message: { id: string }, _now: number): boolean {
    this.activeId = message.id;
    this.shown.push(message.id);
    return true;
  }
  hide(id: string | null, _now: number): void {
    if (id === null || id === this.activeId) this.activeId = null;
  }
  update(_now: number): void {}
}

class BrandSpy implements ExperienceBrand {
  shows = 0;
  show(): void { this.shows++; }
  hide(): void {}
  update(): void {}
}

class PrivacySpy implements ExperiencePrivacy {
  request(): void {}
  update(): void {}
}

function event(type: GestureEvent['type'], timestamp: number): GestureEvent {
  return { type, personId: 1, points: [{ x: 0.4, y: 0.2 }], timestamp, confidence: 1, source: 'pose' };
}

describe('Experience', () => {
  it('avanza el tutorial una vez y queda en modo libre tras ambos gestos', () => {
    const config = structuredClone(defaultConfig);
    config.experience.greetingDelayMs = 10;
    config.experience.firstInstructionDelayMs = 20;
    config.experience.secondInstructionDelayMs = 10;
    const overlay = new OverlaySpy();
    const experience = new Experience(config, overlay, new BrandSpy(), new PrivacySpy(), 0);

    experience.update(1, 1);
    experience.update(25, 1);
    expect(overlay.shown).toContain('greeting');
    expect(overlay.shown).toContain('raise-hand');

    experience.onGesture(event('ONE_HAND_UP', 30), 30);
    experience.update(41, 1);
    expect(overlay.shown).toContain('try-both');
    experience.onGesture(event('BOTH_HANDS_UP', 50), 50);
    experience.onGesture(event('BOTH_HANDS_UP', 60), 60);
    expect(overlay.shown.filter((id) => id === 'reveal')).toHaveLength(1);

    experience.update(100, 0);
    experience.update(100 + config.experience.absenceGraceMs + 1, 0);
    experience.update(200 + config.experience.absenceGraceMs, 1);
    experience.update(10_000, 1);
    expect(overlay.shown.filter((id) => id === 'raise-hand')).toHaveLength(1);
  });

  it('ACÉRCATE reaparece periódicamente mientras nadie está presente', () => {
    const config = structuredClone(defaultConfig);
    const overlay = new OverlaySpy();
    const experience = new Experience(config, overlay, new BrandSpy(), new PrivacySpy(), 0);
    const { idlePromptDelayMs, idlePromptIntervalMs } = config.experience;
    for (let t = 0; t <= idlePromptDelayMs + idlePromptIntervalMs * 2 + 100; t += 100) experience.update(t, 0);
    expect(overlay.shown.filter((id) => id === 'idle-prompt')).toHaveLength(3);
  });
});
