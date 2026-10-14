import { preview } from 'vite';
import { fileURLToPath } from 'node:url';
import { legacyPreviewPlugin } from './website-routing.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await preview({
  root,
  preview: { host: '127.0.0.1', port: 5176, strictPort: true },
  plugins: [legacyPreviewPlugin()],
});
server.printUrls();
