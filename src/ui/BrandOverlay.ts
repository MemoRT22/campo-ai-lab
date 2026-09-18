import type { Config } from '../config';
import { renderLines, type PlacementResolver } from './InstructionOverlay';
import type { TextAnchor } from './NegativeSpaceLayout';
import { brandBlock, linesOf } from './TextParticleSampler';

export type BrandPlacement = 'center' | 'lower' | 'auto';

/** Revela el nombre del laboratorio en momentos puntuales. Todo el contenido viene de config.branding. */
export class BrandOverlay {
  /** Se invoca cuando la marca aparece, con el lugar donde quedó (null si es centro/fija). */
  onShow: ((anchor: TextAnchor | null, now: number, durationMs: number) => void) | null = null;

  private readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly labEl: HTMLElement;
  private hideAt = 0;
  private isVisible = false;

  constructor(
    root: HTMLElement,
    private readonly branding: Config['branding'],
    private readonly resolvePlacement: PlacementResolver | null = null,
    private readonly typographyScale = 1,
  ) {
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
    this.nameEl = name;
    this.labEl = lab;

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
    if (this.isVisible) {
      this.hideAt = now + durationMs;
      return;
    }
    const anchor = placement === 'auto' && this.resolvePlacement ? this.resolvePlacement('message') : null;
    if (anchor) {
      this.el.dataset.placement = anchor.placement;
      this.el.style.setProperty('--text-x', `${anchor.x}px`);
      this.el.style.setProperty('--text-y', `${anchor.y}px`);
      this.el.style.setProperty('--text-width', `${anchor.width}px`);
      const block = brandBlock(this.branding.brandName, this.branding.labName, anchor.width, {
        width: window.innerWidth,
        height: window.innerHeight,
        typographyScale: this.typographyScale,
      });
      renderLines(this.nameEl, linesOf(block, 'brandName'));
      renderLines(this.labEl, linesOf(block, 'brandLab'));
    } else {
      this.el.dataset.placement = placement === 'auto' ? 'center' : placement;
      this.nameEl.textContent = this.branding.brandName;
      this.labEl.textContent = this.branding.labName;
    }
    this.el.dataset.visible = 'true';
    this.isVisible = true;
    this.hideAt = now + durationMs;
    this.onShow?.(anchor, now, durationMs);
  }

  hide(): void {
    this.el.dataset.visible = 'false';
    this.isVisible = false;
  }

  update(now: number): void {
    if (this.isVisible && now >= this.hideAt) this.hide();
  }
}
