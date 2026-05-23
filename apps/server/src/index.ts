import { appName, appVersion } from '@bunny2/shared';

const port = Number(Bun.env.PORT ?? 4317);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/status') {
      return Response.json({
        app: appName,
        version: appVersion,
        phase: '1.1',
        ok: true,
      });
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[${appName}] server listening on http://localhost:${server.port}`);
