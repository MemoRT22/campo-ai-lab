import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { App } from './core/App';
import { resolveConfig } from './core/configOverrides';

const config = resolveConfig(window.location.search);

try {
  new App(config).start();
} catch (error) {
  // Al público nunca se le muestra un error: la pantalla simplemente permanece negra.
  console.error('[campo] No se pudo iniciar la instalación', error);
}
