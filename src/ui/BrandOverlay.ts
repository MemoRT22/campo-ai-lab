import type { Config } from '../config';

export type BrandPlacement = 'center' | 'lower';

/** Revela el nombre del laboratorio en momentos puntuales. Todo el contenido viene de config.branding. */
export class BrandOverlay {
  private readonly el: HTMLElement;
  private hideAt = 0;
  private isVisible = false;

  constructor(root: HTMLElement, branding: Config['branding']) {
    this.el = document.createElement('div');
    this.el.className = 'brand';
    this.el.dataset.visible = 'false';

    if (branding.logoEnabled && branding.logoPath) {
      const logo = document.createElement('img');
      logo.className = 'brand__logo';
      logo.src = branding.logoPath;
      logo.alt = '';
      this.el.appendChild(logo);
    }
    const name = document.createElement('div');
    name.className = 'brand__name';
    name.textContent = branding.brandName;
    const rule = document.createElement('div');
    rule.className = 'brand__rule';
    const lab = document.createElement('div');
    lab.className = 'brand__lab';
    lab.textContent = branding.labName;
    this.el.append(name, rule, lab);

    if (branding.tagline) {
      const tagline = document.createElement('div');
      tagline.className = 'brand__tagline';
      tagline.textContent = branding.tagline;
      this.el.appendChild(tagline);
    }
    root.appendChild(this.el);
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(now: number, durationMs: number, placement: BrandPlacement): void {
    // Si ya está visible sólo se extiende: cambiar de posición en pantalla se vería como un salto.
    if (!this.isVisible) this.el.dataset.placement = placement;
    this.el.dataset.visible = 'true';
    this.isVisible = true;
    this.hideAt = now + durationMs;
  }

  hide(): void {
    this.el.dataset.visible = 'false';
    this.isVisible = false;
  }

  update(now: number): void {
    if (this.isVisible && now >= this.hideAt) this.hide();
  }
}
