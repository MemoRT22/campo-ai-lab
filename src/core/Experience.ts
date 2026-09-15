import type { Config } from '../config';
import type { GestureEvent } from '../interaction/GestureEvents';
import type { BrandPlacement } from '../ui/BrandOverlay';
import type { InstructionMessage } from '../ui/InstructionOverlay';
import { StateMachine } from './StateMachine';

export type ExperienceState = 'idle' | 'presence' | 'departure';

interface Session {
  startedAt: number;
  greeted: boolean;
  firstHint: boolean;
  gestureOneAt: number;
  secondHint: boolean;
  revealAt: number;
  brandShown: boolean;
}

export interface ExperienceOverlay {
  readonly activeId: string | null;
  show(message: InstructionMessage, now: number): boolean;
  hide(id: string | null, now: number): void;
  update(now: number): void;
}

export interface ExperienceBrand {
  show(now: number, durationMs: number, placement: BrandPlacement): void;
  hide(): void;
  update(now: number): void;
}

export interface ExperiencePrivacy {
  request(now: number, delayMs: number): void;
  update(now: number): void;
}

const ID = {
  idle: 'idle-prompt',
  greeting: 'greeting',
  raiseHand: 'raise-hand',
  tryBoth: 'try-both',
  reveal: 'reveal',
} as const;

const PRIORITY = { idle: 0, greeting: 1, hint: 2, reveal: 5 } as const;

/**
 * Dirección narrativa de la instalación: qué se dice y cuándo.
 * No sabe nada de partículas ni de visión; sólo recibe cuántas personas hay y qué gestos ocurren.
 *
 *   IDLE ──persona──▶ PRESENCE ──nadie (gracia)──▶ DEPARTURE ──tiempo──▶ IDLE
 *                        ▲                            │
 *                        └─────────persona────────────┘
 */
export class Experience {
  onStateChange: ((from: ExperienceState, to: ExperienceState) => void) | null = null;

  private readonly machine: StateMachine<ExperienceState>;
  private people = 0;
  private absentSince = -1;
  private nextIdlePromptAt = 0;
  private session: Session | null = null;
  private lastDepartureAt = -Infinity;

  constructor(
    private readonly config: Config,
    private readonly overlay: ExperienceOverlay,
    private readonly brand: ExperienceBrand,
    private readonly privacy: ExperiencePrivacy,
    now: number,
  ) {
    this.machine = new StateMachine<ExperienceState>(
      {
        idle: {
          enter: (t) => {
            this.nextIdlePromptAt = t + this.config.experience.idlePromptDelayMs;
          },
          update: (t) => this.updateIdle(t),
          exit: (t) => this.overlay.hide(ID.idle, t),
        },
        presence: {
          enter: (t) => this.enterPresence(t),
          update: (t) => this.updatePresence(t),
        },
        departure: {
          enter: (t) => this.enterDeparture(t),
          update: (t, elapsed) => {
            if (this.people > 0) this.machine.transition('presence', t);
            else if (elapsed > this.config.experience.departureDurationMs) this.machine.transition('idle', t);
          },
        },
      },
      'idle',
      now,
    );
  }

  get state(): ExperienceState {
    return this.machine.current;
  }

  update(now: number, peopleCount: number): void {
    this.people = peopleCount;
    const previous = this.machine.current;
    this.machine.update(now);
    if (this.machine.current !== previous) this.onStateChange?.(previous, this.machine.current);
    this.overlay.update(now);
    this.brand.update(now);
    this.privacy.update(now);
  }

  onGesture(event: GestureEvent, now: number): void {
    const session = this.session;
    if (this.machine.current !== 'presence' || !session) return;
    const { texts, experience } = this.config;

    if (event.type === 'ONE_HAND_UP' && session.gestureOneAt < 0) {
      session.gestureOneAt = now;
      this.overlay.hide(ID.raiseHand, now);
    }

    if (event.type === 'BOTH_HANDS_UP' && session.revealAt < 0) {
      session.revealAt = now;
      session.secondHint = true;
      if (session.gestureOneAt < 0) session.gestureOneAt = now;
      this.brand.hide();
      this.overlay.show(
        {
          id: ID.reveal,
          message: texts.revealTitle,
          subMessage: texts.revealSubtitle,
          placement: 'auto',
          kind: 'title',
          variant: 'title',
          timeout: experience.revealDurationMs,
          priority: PRIORITY.reveal,
          opacity: 0.92,
        },
        now,
      );
    }
  }

  private updateIdle(now: number): void {
    if (this.people > 0) {
      this.machine.transition('presence', now);
      return;
    }
    // ACÉRCATE respira: aparece, se desvanece y vuelve después de un silencio.
    if (now >= this.nextIdlePromptAt) {
      this.nextIdlePromptAt = now + this.config.experience.idlePromptIntervalMs;
      this.overlay.show(
        {
          id: ID.idle,
          message: this.config.texts.idlePrompt,
          placement: 'center',
          variant: 'prompt',
          timeout: this.config.experience.idlePromptDurationMs,
          priority: PRIORITY.idle,
          opacity: 0.46,
        },
        now,
      );
    }
  }

  private enterPresence(now: number): void {
    this.absentSince = -1;
    const resumed = this.session !== null && now - this.lastDepartureAt < this.config.experience.returnWithinMs;
    if (!resumed) {
      this.session = { startedAt: now, greeted: false, firstHint: false, gestureOneAt: -1, secondHint: false, revealAt: -1, brandShown: false };
    }
    this.brand.hide();
    this.privacy.request(now, this.config.privacy.presenceDelayMs);
  }

  private updatePresence(now: number): void {
    const { experience, texts, branding } = this.config;
    const session = this.session;
    if (!session) return;

    if (this.people === 0) {
      if (this.absentSince < 0) this.absentSince = now;
      else if (now - this.absentSince > experience.absenceGraceMs) this.machine.transition('departure', now);
      return;
    }
    this.absentSince = -1;

    const t = now - session.startedAt;

    if (!session.greeted && t > experience.greetingDelayMs) {
      session.greeted = true;
      if (experience.showDetectedMessage) {
        this.overlay.show(
          {
            id: ID.greeting,
            message: texts.detected,
            placement: 'auto',
            kind: 'message',
            variant: 'message',
            timeout: experience.greetingDurationMs,
            priority: PRIORITY.greeting,
            opacity: 0.66,
          },
          now,
        );
      }
    }

    if (!session.firstHint && t > experience.firstInstructionDelayMs) {
      session.firstHint = true;
      if (session.gestureOneAt < 0) this.overlay.show(
        { id: ID.raiseHand, message: texts.raiseHand, icon: 'raise-hand', placement: 'auto', kind: 'hint', timeout: experience.instructionTimeout, priority: PRIORITY.hint },
        now,
      );
    }

    if (session.gestureOneAt >= 0 && !session.secondHint && now - session.gestureOneAt > experience.secondInstructionDelayMs) {
      session.secondHint = true;
      this.overlay.show(
        { id: ID.tryBoth, message: texts.tryBoth, icon: 'raise-hand', placement: 'auto', kind: 'hint', timeout: experience.instructionTimeout, priority: PRIORITY.hint },
        now,
      );
    }

    if (branding.showBranding && !session.brandShown) {
      const afterReveal = session.revealAt >= 0 && now - session.revealAt > experience.revealDurationMs + experience.brandAfterRevealMs;
      const afterLongStay = t > experience.brandAfterPresenceMs && this.overlay.activeId === null;
      if (afterReveal || afterLongStay) {
        session.brandShown = true;
        this.brand.show(now, experience.brandDurationMs, 'auto');
      }
    }
  }

  private enterDeparture(now: number): void {
    const { experience, branding } = this.config;
    this.lastDepartureAt = now;
    this.overlay.hide(null, now);
    const engaged = this.session !== null && now - this.session.startedAt > experience.engagedMinMs;
    // Al irse, la pantalla le dice a la persona dónde estuvo.
    if (branding.showBranding && engaged) this.brand.show(now, experience.departureDurationMs, 'center');
  }
}
