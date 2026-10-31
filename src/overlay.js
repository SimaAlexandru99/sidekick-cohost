import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function startOverlay({ port = 3030, onConnect = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid overlay port');
  const html = await readFile(new URL('../public/overlay.html', import.meta.url));
  let viewer;
  let current;
  let closed = false;

  function send(event, data) {
    viewer?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function finish(error) {
    if (!current) return;
    const playing = current;
    current = undefined;
    clearTimeout(playing.timer);
    playing.signal?.removeEventListener('abort', playing.abort);
    send('stop', { id: playing.id });
    if (error) playing.reject(error);
    else playing.resolve();
  }

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host;
    const localPort = server.address().port;
    if (![ `127.0.0.1:${localPort}`, `localhost:${localPort}` ].includes(host) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403).end();
      return;
    }
    const path = req.url;
    if (req.method === 'GET' && path === '/overlay') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } else if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      if (viewer) {
        res.end('event: busy\ndata: {}\n\n');
        return;
      }
      viewer = res;
      res.write('retry: 1000\nevent: ready\ndata: {}\n\n');
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      res.on('close', () => {
        clearInterval(heartbeat);
        if (viewer === res) {
          viewer = undefined;
          finish(new Error('Overlay disconnected'));
        }
      });
      onConnect();
    } else if (req.method === 'GET' && current?.audio && path === `/audio/${current.id}.mp3`) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': current.audio.length });
      res.end(current.audio);
    } else if (req.method === 'POST' && req.headers.origin === `http://${host}` &&
        current && [ `/playback/${current.id}/ended`, `/playback/${current.id}/error` ].includes(path)) {
      req.resume();
      finish(path.endsWith('/error') ? new Error('Overlay playback failed') : undefined);
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${server.address().port}/overlay`,
    isConnected: () => Boolean(viewer) && !closed,
    play(item, signal) {
      if (closed || !viewer || current || signal?.aborted) {
        return Promise.reject(new Error('Overlay is not available for playback'));
      }
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const abort = () => finish(new Error('Playback cancelled'));
        current = { id, audio: item.audio, signal, abort, resolve, reject,
          timer: setTimeout(() => finish(new Error('Overlay playback timed out')), 60000) };
        signal?.addEventListener('abort', abort, { once: true });
        send('speech', { id, name: item.name, text: item.text,
          audioUrl: item.audio ? `/audio/${id}.mp3` : null });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      finish(new Error('Overlay shutting down'));
      viewer?.end();
      viewer = undefined;
      const done = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await done;
    },
  };
}
