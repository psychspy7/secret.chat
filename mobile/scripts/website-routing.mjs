export function legacyPreviewPlugin() {
  const legacy = /^\/(?:legacy|r|create|SECRET|secret|host)(?:\/|$|\?)/;
  return {
    name: 'preserve-legacy-preview',
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (legacy.test(req.url || '')) req.url = '/legacy.html';
        next();
      });
    },
  };
}
