import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preview } from 'vite';
import { legacyPreviewPlugin } from '../mobile/scripts/website-routing.mjs';
const prefixes = ['legacy', 'r', 'create', 'SECRET', 'secret', 'host'];
const cases = [
  ...prefixes.flatMap(p => ['/' + p, '/' + p + '/', '/' + p + '/example', '/' + p + '?from=old'].map(url => [url, 'legacy'])),
  ...['/', '/rooms', '/account', '/secrets', '/hostile', '/legacy-new'].map(url => [url, 'modern']),
];
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
const redirects = [...netlify.matchAll(/\[\[redirects\]\]\s+from = "([^"]+)"\s+to = "([^"]+)"/g)].map(m => ({ from: m[1], to: m[2] }));
const matches = (pattern, pathname) => {
  if (pattern === '/(.*)' || pattern === '/*') return true;
  if (pattern.endsWith('/:path*')) {
    const base = pattern.slice(0, -7);
    return pathname === base || pathname.startsWith(base + '/');
  }
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
};
test('all hosting configurations preserve legacy route boundaries', () => {
  for (const [url, entry] of cases) {
    const pathname = new URL(url, 'http://localhost').pathname;
    const expected = '/' + (entry === 'legacy' ? 'legacy' : 'index') + '.html';
    assert.equal(vercel.rewrites.find(r => matches(r.source, pathname))?.destination, expected, 'Vercel ' + url);
    assert.equal(redirects.find(r => matches(r.from, pathname))?.to, expected, 'Netlify ' + url);
  }
});
test('real preview requests select the same modern or legacy entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'secretchat-routes-'));
  let server;
  try {
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/index.html'), 'modern');
    await writeFile(path.join(root, 'dist/legacy.html'), 'legacy');
    server = await preview({ root, configFile: false, logLevel: 'silent', plugins: [legacyPreviewPlugin()], preview: { host: '127.0.0.1', port: 0 } });
    const port = server.httpServer.address().port;
    for (const [url, entry] of cases) {
      const response = await fetch('http://127.0.0.1:' + port + url);
      assert.equal(response.status, 200, url);
      assert.equal(await response.text(), entry, url);
    }
  } finally {
    if (server) await server.httpServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
