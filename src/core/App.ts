import type { Config } from '../config';
import { InteractionManager } from '../interaction/InteractionManager';
import { ParticleSystem } from '../particles/ParticleSystem';
import { TargetField } from '../particles/TargetField';
import { Renderer } from '../render/Renderer';
import { BrandOverlay } from '../ui/BrandOverlay';
import { DebugPanel } from '../ui/DebugPanel';
import { InstructionOverlay } from '../ui/InstructionOverlay';
import { PrivacyNotice } from '../ui/PrivacyNotice';
import { setupKiosk } from '../utils/Kiosk';
import { PerformanceMonitor } from '../utils/PerformanceMonitor';
import { CameraVisionSource } from '../vision/CameraVisionSource';
import { MockVisionSource } from '../vision/MockVisionSource';
import type { VisionSource } from '../vision/types';
import { Experience } from './Experience';

const MAX_DT_SECONDS = 0.1;
const MAX_STORED_ERRORS = 20;
const IDLE_BEFORE_RELOAD_MS = 10_000;

/**
 * Orquestador. Un solo requestAnimationFrame: toma el último resultado de visión si hay uno,
 * actualiza la narrativa, simula y dibuja. La visión corre a su propio ritmo en otro hilo.
 */
export class App {
  private readonly renderer: Renderer;
  private readonly field: TargetField;
  private readonly particles: ParticleSystem;
  private readonly experience: Experience;
  private readonly interaction: InteractionManager;
  private readonly source: VisionSource;
  private readonly perf = new PerformanceMonitor();
  private readonly debug: DebugPanel | null = null;
  private readonly errors: string[] = [];
  private lastFrameTime = 0;
  private idleSince = 0;

  constructor(private readonly config: Config) {
    const canvas = document.querySelector<HTMLCanvasElement>('#field');
    const overlayRoot = document.querySelector<HTMLElement>('#overlay');
    if (!canvas || !overlayRoot) throw new Error('Faltan #field u #overlay en index.html');
    document.documentElement.style.setProperty('--type-scale', String(config.typography.scale));

    const now = performance.now();
    this.renderer = new Renderer(canvas, config.render, config.particles.particleCount);
    this.field = new TargetField(config);
    this.particles = new ParticleSystem(config.particles);
    const overlay = new InstructionOverlay(overlayRoot);
    const brand = new BrandOverlay(overlayRoot, config.branding);
    const privacy = new PrivacyNotice(overlayRoot, config.privacy, config.texts.privacy);
    this.experience = new Experience(config, overlay, brand, privacy, now);
    this.interaction = new InteractionManager(config, this.particles, this.field, this.experience);
    this.source = config.mockVision ? new MockVisionSource(config) : new CameraVisionSource(config);

    this.experience.onStateChange = (from, to) => {
      if (to === 'idle') this.idleSince = performance.now();
      if (config.debugMode) console.info(`[experience] ${from} → ${to}`);
    };

    if (config.debugMode) {
      this.debug = new DebugPanel(overlayRoot, {
        config,
        source: this.source,
        perf: this.perf,
        particles: this.particles,
        experience: this.experience,
        interaction: this.interaction,
        errors: this.errors,
      });
    }
  }

  start(): void {
    window.addEventListener('error', (event) => this.reportError(event.error ?? event.message));
    window.addEventListener('unhandledrejection', (event) => this.reportError(event.reason));

    this.resize();
    window.addEventListener('resize', this.resize);
    setupKiosk(this.config, () => this.experience.state === 'idle' && performance.now() - this.idleSince > IDLE_BEFORE_RELOAD_MS);
    if (this.debug) window.addEventListener('keydown', this.handleDebugKey);

    try {
      this.source.start();
    } catch (error) {
      // Sin cámara la instalación sigue viva en modo ambiental.
      this.reportError(error);
    }
    if (!this.renderer.available) this.reportError('WebGL2 no disponible');
    requestAnimationFrame(this.loop);
  }

  private readonly loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = this.lastFrameTime ? Math.min((now - this.lastFrameTime) / 1000, MAX_DT_SECONDS) : 1 / 60;
    this.lastFrameTime = now;
    this.perf.beginFrame(now);

    try {
      this.source.update(now);
      const frame = this.source.takeFrame();
      if (frame) {
        this.field.update(frame, now);
        this.particles.applyTargets(this.field, now);
        this.perf.recordVision(frame.inferenceMs, frame.processingMs, frame.timestamp, now);
        this.debug?.drawFrame(frame);
      } else if ((this.field.activeCount > 0 || this.field.peopleCount > 0) && now - this.source.lastFrameAt > this.config.vision.staleFrameMs) {
        // Visión detenida: no dejar una silueta congelada en pantalla.
        this.field.clear();
        this.particles.applyTargets(this.field, now);
      }

      this.experience.update(now, this.field.peopleCount);

      this.particles.step(dt, now);
      this.renderer.draw(this.particles.renderData, this.particles.renderCount);
    } catch (error) {
      this.reportError(error);
    }

    this.perf.endFrame();
    this.debug?.update(now);
  };

  private readonly resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.resize(width, height, window.devicePixelRatio || 1);
    this.field.resize(width, height);
    this.particles.resize(width, height);
  };

  private readonly handleDebugKey = (event: KeyboardEvent): void => {
    const now = performance.now();
    if (event.key === '1') this.interaction.simulate('hand-raised', now);
    else if (event.key === '2') this.interaction.simulate('both-hands-raised', now);
    else if (event.key === 'd' || event.key === 'D') this.debug?.toggle();
  };

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const last = this.errors[this.errors.length - 1];
    if (last !== message) {
      console.error('[campo]', error);
      this.errors.push(message);
      if (this.errors.length > MAX_STORED_ERRORS) this.errors.shift();
    }
  }
}
