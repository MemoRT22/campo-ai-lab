import type { Config } from '../config';
import { InteractionManager } from '../interaction/InteractionManager';
import { GestureRecognizer } from '../interaction/GestureRecognizer';
import { GroupInteraction } from '../particles/GroupInteraction';
import { ParticleSystem } from '../particles/ParticleSystem';
import { TargetField } from '../particles/TargetField';
import { Renderer } from '../render/Renderer';
import { BrandOverlay } from '../ui/BrandOverlay';
import { CalibrationPanel } from '../ui/CalibrationPanel';
import { DebugPanel } from '../ui/DebugPanel';
import { InstructionOverlay } from '../ui/InstructionOverlay';
import { NegativeSpaceLayout } from '../ui/NegativeSpaceLayout';
import { PrivacyNotice } from '../ui/PrivacyNotice';
import { brandBlock, revealBlock, sampleTypeBlock, type TypeViewport } from '../ui/TextParticleSampler';
import { setupKiosk } from '../utils/Kiosk';
import { screenScale } from '../utils/MathUtils';
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
  private readonly group: GroupInteraction;
  private readonly experience: Experience;
  private readonly interaction: InteractionManager;
  private readonly gestures: GestureRecognizer;
  private readonly layout: NegativeSpaceLayout;
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
    this.group = new GroupInteraction(config.particles.groupInteraction);
    this.particles.setGroup(this.group);
    this.layout = new NegativeSpaceLayout(config.layout);
    const resolvePlacement = this.layout.resolve.bind(this.layout);
    const overlay = new InstructionOverlay(overlayRoot, resolvePlacement, config.typography.scale);
    const brand = new BrandOverlay(overlayRoot, config.branding, resolvePlacement, config.typography.scale);
    const privacy = new PrivacyNotice(overlayRoot, config.privacy, config.texts.privacy);
    this.experience = new Experience(config, overlay, brand, privacy, now);
    this.interaction = new InteractionManager(config, this.particles, this.field, this.experience, this.group);
    this.gestures = new GestureRecognizer(config.gestures);
    this.source = config.mockVision ? new MockVisionSource(config) : new CameraVisionSource(config);

    // Las partículas del reveal y de la marca apuntan al lugar donde el texto realmente apareció.
    const p = config.particles;
    overlay.onRender = (message, anchor, now) => {
      if (message.variant !== 'title' || !anchor) return;
      const viewport = this.viewport();
      const block = revealBlock(message.message, message.subMessage ?? '', anchor.width, viewport);
      this.particles.startTextFlight(sampleTypeBlock(block, anchor.x, anchor.y, p.textParticleMaxTargets, viewport), now, {
        startAt: Math.max(now, this.particles.celebrationPeakAt),
        travelMs: p.revealTravelMs,
        holdMs: p.revealHoldMs,
        returnMs: p.revealReturnMs,
      });
    };
    brand.onShow = (anchor, now, durationMs) => {
      if (!anchor || this.experience.state !== 'presence') return;
      const viewport = this.viewport();
      const block = brandBlock(config.branding.brandName, config.branding.labName, anchor.width, viewport);
      this.particles.startTextFlight(sampleTypeBlock(block, anchor.x, anchor.y, p.textParticleMaxTargets, viewport), now, {
        startAt: now,
        travelMs: p.brandTravelMs,
        holdMs: Math.max(0, durationMs - p.brandTravelMs - p.brandReturnMs),
        returnMs: p.brandReturnMs,
      });
    };

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
        gestures: this.gestures,
        field: this.field,
        group: this.group,
        layout: this.layout,
        errors: this.errors,
      });
    }
    if (config.calibrationMode) new CalibrationPanel(overlayRoot, config);
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
        this.layout.update(this.field, now);
        this.particles.applyTargets(this.field, now);
        this.perf.recordVision(frame.inferenceMs, frame.processingMs, frame.timestamp, now);
        if (frame.poseTimestamp !== null) {
          for (const event of this.gestures.update(frame.poses, frame.people, frame.poseTimestamp)) this.interaction.handle(event, now);
          this.perf.recordPose(frame.poseInferenceMs, frame.poseTimestamp, now);
        }
        this.debug?.drawFrame(frame);
      } else if ((this.field.activeCount > 0 || this.field.peopleCount > 0) && now - this.source.lastFrameAt > this.config.vision.staleFrameMs) {
        // Visión detenida: no dejar una silueta congelada en pantalla.
        this.field.clear();
        this.layout.update(this.field, now);
        this.particles.applyTargets(this.field, now);
        this.gestures.reset();
      }

      this.experience.update(now, this.field.peopleCount);
      this.group.update(this.field, now, screenScale(this.field.width, this.field.height));

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
    this.layout.update(this.field, performance.now());
    this.particles.resize(width, height);
  };

  private viewport(): TypeViewport {
    return { width: window.innerWidth, height: window.innerHeight, typographyScale: this.config.typography.scale };
  }

  private readonly handleDebugKey = (event: KeyboardEvent): void => {
    const now = performance.now();
    if (event.key === '1') this.interaction.simulate('ONE_HAND_UP', now);
    else if (event.key === '2') this.interaction.simulate('BOTH_HANDS_UP', now);
    else if (event.key === '3') this.interaction.simulateGroupWave(now);
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
