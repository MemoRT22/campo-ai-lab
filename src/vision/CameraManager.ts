import type { Config } from '../config';
import type { CameraDiagnostics, CameraStatus } from './types';

type CameraSettings = Config['camera'];

const LATENCY_SMOOTHING = 0.1;

interface Classified {
  status: CameraStatus;
  message: string;
}

function classify(error: unknown): Classified {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { status: 'denied', message: 'Permiso de cámara denegado' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { status: 'not-found', message: 'No se encontró la cámara solicitada' };
    case 'NotReadableError':
    case 'AbortError':
      return { status: 'busy', message: 'La cámara está ocupada por otra aplicación o no responde' };
    default:
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Abre la cámara, la mantiene viva y la recupera si se pierde.
 * El <video> nunca es visible: sólo existe como fuente de frames.
 */
export class CameraManager {
  readonly video: HTMLVideoElement;
  status: CameraStatus = 'idle';
  detail = '';
  devices: string[] = [];
  measuredFps = 0;
  readonly diagnostics: CameraDiagnostics;
  onStatusChange: (() => void) | null = null;
  /**
   * Se dispara en cuanto el navegador presenta un frame nuevo, antes del siguiente
   * requestAnimationFrame. Capturar aquí quita hasta un frame de espera y, sobre todo, el jitter
   * de que la cámara y la pantalla vayan a ritmos distintos.
   */
  onNewFrame: ((now: number) => void) | null = null;

  private stream: MediaStream | null = null;
  private retryAttempt = 0;
  private retryTimer = 0;
  private opening = false;
  private stopped = true;
  private lastVideoTime = -1;
  private lastAdvanceAt = 0;
  private fpsWindowAt = 0;
  private fpsFrames = 0;
  private videoFrameCallback = 0;
  private cameraIds: string[] = [];

  constructor(private readonly settings: CameraSettings) {
    this.diagnostics = {
      label: '',
      deviceIndex: -1,
      requestedWidth: settings.cameraWidth,
      requestedHeight: settings.cameraHeight,
      requestedFps: settings.frameRate,
      deliveredWidth: 0,
      deliveredHeight: 0,
      deliveredFps: 0,
      aspectRatio: 0,
      captureLatencyMs: 0,
    };
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.disablePictureInPicture = true;
    video.className = 'camera-source';
    video.setAttribute('aria-hidden', 'true');
    document.body.appendChild(video);
    this.video = video;
    navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChange);
  }

  start(): void {
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    this.release();
    this.setStatus('idle', '');
  }

  /** true si hay un frame nuevo desde la última llamada. También detecta video congelado. */
  pollFrame(now: number): boolean {
    if (this.status !== 'live') return false;
    const video = this.video;
    const time = video.currentTime;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && time !== this.lastVideoTime) {
      this.lastVideoTime = time;
      this.lastAdvanceAt = now;
      // Fallback para navegadores sin requestVideoFrameCallback. En navegadores modernos el
      // monitor independiente mide todos los frames, no sólo los capturados para inferencia.
      if (!('requestVideoFrameCallback' in video)) {
        this.fpsFrames++;
        if (this.fpsWindowAt === 0) this.fpsWindowAt = now;
        const elapsed = now - this.fpsWindowAt;
        if (elapsed >= 1000) {
          this.measuredFps = (this.fpsFrames * 1000) / elapsed;
          this.fpsFrames = 0;
          this.fpsWindowAt = now;
          this.onStatusChange?.();
        }
      }
      return true;
    }
    if (now - this.lastAdvanceAt > this.settings.frozenFrameTimeoutMs) {
      this.handleLoss('La cámara dejó de entregar frames');
    }
    return false;
  }

  private async open(): Promise<void> {
    if (this.opening || this.stopped) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail({ status: 'unsupported', message: 'getUserMedia no disponible: se requiere https o localhost' });
      return;
    }

    this.opening = true;
    this.setStatus(this.retryAttempt > 0 ? 'reconnecting' : 'requesting', '');
    try {
      let stream = await navigator.mediaDevices.getUserMedia(this.constraints(null));
      // Los nombres de las cámaras sólo están disponibles después de conceder el permiso.
      const preferred = await this.findPreferredDevice();
      const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (preferred && preferred !== currentId) {
        stream.getTracks().forEach((track) => track.stop());
        stream = await navigator.mediaDevices.getUserMedia(this.constraints(preferred));
      }
      if (this.stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.attach(stream);
      await this.video.play();
      this.retryAttempt = 0;
      this.lastVideoTime = -1;
      this.lastAdvanceAt = performance.now();
      this.fpsWindowAt = 0;
      this.fpsFrames = 0;

      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      this.diagnostics.label = track.label;
      this.diagnostics.deviceIndex = this.cameraIds.indexOf(s.deviceId ?? '');
      this.diagnostics.deliveredWidth = s.width ?? this.video.videoWidth;
      this.diagnostics.deliveredHeight = s.height ?? this.video.videoHeight;
      this.diagnostics.deliveredFps = s.frameRate ?? 0;
      this.diagnostics.aspectRatio = s.aspectRatio ?? (
        this.diagnostics.deliveredHeight > 0 ? this.diagnostics.deliveredWidth / this.diagnostics.deliveredHeight : 0
      );
      this.setStatus('live', `${track.label} · ${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)} fps`);
      this.startFrameMonitor();
    } catch (error) {
      this.release();
      this.fail(classify(error));
    } finally {
      this.opening = false;
    }
  }

  private constraints(deviceId: string | null): MediaStreamConstraints {
    const { cameraWidth, cameraHeight, frameRate } = this.settings;
    return {
      audio: false,
      video: {
        width: { ideal: cameraWidth },
        height: { ideal: cameraHeight },
        frameRate: { ideal: frameRate },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
  }

  private async findPreferredDevice(): Promise<string | null> {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    this.cameraIds = cameras.map((d) => d.deviceId);
    this.devices = cameras.map((d, i) => `${i}: ${d.label || `cámara ${i}`}`);

    const { deviceLabel, deviceIndex } = this.settings;
    if (deviceLabel) {
      const needle = deviceLabel.toLowerCase();
      const match = cameras.find((d) => d.label.toLowerCase().includes(needle));
      if (match) return match.deviceId;
      console.warn(`[camera] Ninguna cámara coincide con "${deviceLabel}". Disponibles:`, this.devices);
    }
    if (deviceIndex >= 0 && deviceIndex < cameras.length) return cameras[deviceIndex].deviceId;
    return null;
  }

  private attach(stream: MediaStream): void {
    this.stream = stream;
    this.video.srcObject = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', this.handleTrackEnded, { once: true });
    }
  }

  private release(): void {
    if (this.videoFrameCallback && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.videoFrameCallback);
    }
    this.videoFrameCallback = 0;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.removeEventListener('ended', this.handleTrackEnded);
        track.stop();
      }
    }
    this.stream = null;
    this.video.srcObject = null;
    this.measuredFps = 0;
    this.diagnostics.deliveredWidth = 0;
    this.diagnostics.deliveredHeight = 0;
    this.diagnostics.deliveredFps = 0;
    this.diagnostics.aspectRatio = 0;
  }

  /** Mide frames realmente entregados por el elemento de video, independiente del ritmo de inferencia. */
  private startFrameMonitor(): void {
    if (!('requestVideoFrameCallback' in this.video)) return;
    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
      if (this.status !== 'live') return;
      this.lastAdvanceAt = now;
      this.fpsFrames++;
      // Sensor → navegador. Chrome lo entrega para streams de getUserMedia.
      const capturedAt = metadata.captureTime;
      if (typeof capturedAt === 'number' && capturedAt > 0) {
        const latency = now - capturedAt;
        if (latency >= 0 && latency < 1000) {
          this.diagnostics.captureLatencyMs += (latency - this.diagnostics.captureLatencyMs) * LATENCY_SMOOTHING;
        }
      }
      if (this.fpsWindowAt === 0) this.fpsWindowAt = now;
      const elapsed = now - this.fpsWindowAt;
      if (elapsed >= 1000) {
        this.measuredFps = (this.fpsFrames * 1000) / elapsed;
        this.fpsFrames = 0;
        this.fpsWindowAt = now;
        this.onStatusChange?.();
      }
      this.videoFrameCallback = this.video.requestVideoFrameCallback(onFrame);
      this.onNewFrame?.(now);
    };
    this.videoFrameCallback = this.video.requestVideoFrameCallback(onFrame);
  }

  private handleTrackEnded = (): void => {
    this.handleLoss('La cámara se desconectó');
  };

  private handleDeviceChange = (): void => {
    if (this.stopped || this.opening || this.status === 'live') return;
    window.clearTimeout(this.retryTimer);
    void this.open();
  };

  private handleLoss(reason: string): void {
    if (this.status !== 'live') return;
    console.warn(`[camera] ${reason}. Reintentando…`);
    this.release();
    this.setStatus('reconnecting', reason);
    this.scheduleRetry();
  }

  private fail({ status, message }: Classified): void {
    console.error(`[camera] ${message}`);
    this.setStatus(status, message);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delays = this.settings.retryDelaysMs;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt++;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.open(), delay);
  }

  private setStatus(status: CameraStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    this.onStatusChange?.();
  }
}
