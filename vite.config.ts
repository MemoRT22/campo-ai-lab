import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
  },
  preview: {
    port: 4180,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
