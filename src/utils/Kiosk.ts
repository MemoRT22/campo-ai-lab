import type { Config } from '../config';

function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch((error: unknown) => {
    console.warn('[kiosk] No se pudo entrar a pantalla completa', error);
  });
}

async function acquireWakeLock(): Promise<void> {
  if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch (error) {
    console.warn('[kiosk] Wake lock no disponible', error);
  }
}

/** Comportamiento de instalación: sin cursor, sin scroll ni zoom, pantalla siempre encendida. */
export function setupKiosk(config: Config, canReload: () => boolean): void {
  const { hideCursorAfterMs, wakeLock, reloadEveryHours } = config.kiosk;

  let cursorTimer = 0;
  const revealCursor = (): void => {
    document.body.classList.remove('cursor-hidden');
    window.clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => document.body.classList.add('cursor-hidden'), hideCursorAfterMs);
  };
  window.addEventListener('pointermove', revealCursor, { passive: true });
  revealCursor();

  window.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
    if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
  window.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });

  if (wakeLock) {
    // El navegador libera el wake lock al ocultar la pestaña: se vuelve a pedir al regresar.
    document.addEventListener('visibilitychange', () => void acquireWakeLock());
    void acquireWakeLock();
  }

  if (reloadEveryHours > 0) {
    const reloadAfterMs = reloadEveryHours * 3_600_000;
    window.setInterval(() => {
      if (performance.now() > reloadAfterMs && canReload()) window.location.reload();
    }, 60_000);
  }
}
