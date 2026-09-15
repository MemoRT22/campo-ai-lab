import type { TextAnchor, TextKind } from './NegativeSpaceLayout';

/** `auto` busca espacio negativo junto a las siluetas en el momento de mostrarse. */
export type InstructionPlacement = 'center' | 'lower' | 'auto';
export type InstructionVariant = 'prompt' | 'message' | 'instruction' | 'title';
export type PlacementResolver = (kind: TextKind) => TextAnchor;
export type InstructionIcon = 'none' | 'raise-hand';

export interface InstructionMessage {
  id: string;
  message: string;
  subMessage?: string;
  icon?: InstructionIcon;
  placement?: InstructionPlacement;
  /** Qué tipo de texto es, para elegir su espacio cuando placement es `auto`. */
  kind?: TextKind;
  variant?: InstructionVariant;
  /** Tiempo visible en ms; 0 = hasta que se oculte explícitamente. */
  timeout?: number;
  /** Un mensaje de mayor prioridad no puede ser reemplazado por uno de menor. */
  priority?: number;
  opacity?: number;
}

const FADE_MS = 950;

const ICONS: Record<InstructionIcon, string> = {
  none: '',
  'raise-hand':
    '<svg viewBox="0 0 24 64" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true">' +
    '<path class="icon-stroke" d="M12 60 V6 M5.5 12.5 L12 6 L18.5 12.5" vector-effect="non-scaling-stroke"/></svg>',
};

/**
 * Una sola línea de instrucciones a la vez (progressive disclosure).
 * El cambio entre mensajes siempre pasa por un fundido: nunca se reemplaza texto visible.
 */
export class InstructionOverlay {
  /** Se invoca cuando un mensaje realmente aparece, con el lugar donde quedó. */
  onRender: ((message: InstructionMessage, anchor: TextAnchor | null, now: number) => void) | null = null;

  private readonly el: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly iconEl: HTMLElement;

  private current: InstructionMessage | null = null;
  private shownAt = 0;
  private pending: InstructionMessage | null = null;
  private fadeCompleteAt = 0;

  constructor(root: HTMLElement, private readonly resolvePlacement: PlacementResolver | null = null) {
    this.el = document.createElement('div');
    this.el.className = 'instruction';
    this.el.dataset.visible = 'false';
    this.el.setAttribute('role', 'status');
    this.messageEl = document.createElement('div');
    this.messageEl.className = 'instruction__message';
    this.subEl = document.createElement('div');
    this.subEl.className = 'instruction__sub';
    this.iconEl = document.createElement('div');
    this.iconEl.className = 'instruction__icon';
    this.el.append(this.messageEl, this.subEl, this.iconEl);
    root.appendChild(this.el);
  }

  get activeId(): string | null {
    return this.pending?.id ?? this.current?.id ?? null;
  }

  show(message: InstructionMessage, now: number): boolean {
    const active = this.pending ?? this.current;
    if (active?.id === message.id) {
      if (this.current === active) this.shownAt = now;
      return true;
    }
    if (active && (active.priority ?? 0) > (message.priority ?? 0)) return false;

    if (this.current) this.fadeOut(now);
    if (now < this.fadeCompleteAt) {
      this.pending = message;
    } else {
      this.pending = null;
      this.render(message, now);
    }
    return true;
  }

  hide(id: string | null, now: number): void {
    if (this.pending && (id === null || this.pending.id === id)) this.pending = null;
    if (this.current && (id === null || this.current.id === id)) this.fadeOut(now);
  }

  update(now: number): void {
    const current = this.current;
    if (current && current.timeout && now - this.shownAt > current.timeout) this.fadeOut(now);
    if (this.pending && now >= this.fadeCompleteAt) {
      const next = this.pending;
      this.pending = null;
      this.render(next, now);
    }
  }

  private fadeOut(now: number): void {
    this.current = null;
    this.el.dataset.visible = 'false';
    this.fadeCompleteAt = now + FADE_MS;
  }

  private render(message: InstructionMessage, now: number): void {
    this.current = message;
    this.shownAt = now;
    this.messageEl.textContent = message.message;
    this.subEl.textContent = message.subMessage ?? '';
    this.subEl.hidden = !message.subMessage;
    const icon = message.icon ?? 'none';
    this.iconEl.innerHTML = ICONS[icon];
    this.iconEl.hidden = icon === 'none';
    const anchor = message.placement === 'auto' && this.resolvePlacement ? this.resolvePlacement(message.kind ?? 'message') : null;
    if (anchor) {
      // La posición se decide aquí, al aparecer: un texto visible nunca cambia de lugar.
      this.el.dataset.placement = anchor.placement;
      this.el.style.setProperty('--text-x', `${anchor.x}px`);
      this.el.style.setProperty('--text-y', `${anchor.y}px`);
      this.el.style.setProperty('--text-width', `${anchor.width}px`);
    } else {
      this.el.dataset.placement = message.placement === 'auto' ? 'center' : message.placement ?? 'lower';
    }
    this.el.dataset.variant = message.variant ?? 'instruction';
    this.el.style.setProperty('--instruction-opacity', String(message.opacity ?? 0.8));
    // Fuerza un reflow para que la transición parta del estado oculto aunque el texto acabe de cambiar.
    void this.el.offsetWidth;
    this.el.dataset.visible = 'true';
    this.onRender?.(message, anchor, now);
  }
}
