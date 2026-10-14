import { build } from 'vite';
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Preserve legacy invitations while serving the same account-based UI as Android.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(repo, 'dist');
await build({ root: repo, base: '/', build: { outDir: output, emptyOutDir: true } });
await copyFile(path.join(output, 'index.html'), path.join(output, 'legacy.html'));
await build({ root: path.join(repo, 'mobile'), base: '/', build: { outDir: output, emptyOutDir: false } });
const [modern, legacy] = await Promise.all(['index.html', 'legacy.html'].map(file => readFile(path.join(output, file), 'utf8')));
if (!modern.includes('id="app"') || !legacy.includes('id="app"') || modern === legacy) throw new Error('Modern and legacy website entry points were not created.');
console.log('Website ready: shared account-based app, with legacy invitation routes preserved.');
