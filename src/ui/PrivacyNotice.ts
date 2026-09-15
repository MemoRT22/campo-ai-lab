import type { Config } from '../config';

/** Aviso discreto y periódico de que no se graba ni se almacena nada. */
export class PrivacyNotice {
  private readonly el: HTMLElement | null = null;
  private visibleUntil = 0;
  private lastShownAt = -Infinity;
  private requestedAt = -1;

  constructor(
    root: HTMLElement,
    private readonly settings: Config['privacy'],
    text: string,
  ) {
    if (!settings.showPrivacyNotice) return;
    this.el = document.createElement('div');
    this.el.className = 'privacy';
    this.el.dataset.visible = 'false';
    this.el.textContent = text;
    root.appendChild(this.el);
  }

  /** Pide mostrarlo tras `delayMs`, salvo que se haya mostrado hace poco. */
  request(now: number, delayMs: number): void {
    if (!this.el || now - this.lastShownAt < this.settings.intervalMs / 2) return;
    this.requestedAt = now + delayMs;
  }

  update(now: number): void {
    if (!this.el) return;
    const visible = now < this.visibleUntil;
    const due = (this.requestedAt >= 0 && now >= this.requestedAt) || now - this.lastShownAt >= this.settings.intervalMs;
    if (!visible && due) {
      this.lastShownAt = now;
      this.visibleUntil = now + this.settings.durationMs;
      this.requestedAt = -1;
      this.el.dataset.visible = 'true';
    } else if (visible !== (this.el.dataset.visible === 'true')) {
      this.el.dataset.visible = String(visible);
    }
  }
}
