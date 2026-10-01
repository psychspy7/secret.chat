import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  base: './',
  build: { target: 'es2022', sourcemap: false },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
