import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { startOverlay } from '../src/overlay.js';

async function setup(t) {
  const overlay = await startOverlay({ port: 0 });
  const base = new URL(overlay.url).origin;
  const controllers = [];
  t.after(async () => { controllers.forEach(controller => controller.abort()); await overlay.close(); });
  async function connect() {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    return {
      controller,
      async next(type) {
        while (true) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = frame.split('\n');
            if (lines.includes(`event: ${type}`)) {
              return JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6));
            }
          } else {
            const result = await reader.read();
            if (result.done) throw new Error('SSE stream ended');
            buffer += decoder.decode(result.value, { stream: true });
          }
        }
      },
    };
  }
  const ack = (id, result = 'ended', origin = base) => fetch(`${base}/playback/${id}/${result}`, {
    method: 'POST', headers: { Origin: origin },
  });
  return { overlay, base, connect, ack };
}
const line = { name: 'Viewer', text: 'Ce părere ai despre această rundă?', audio: null };

test('serves the single overlay page and rejects foreign hosts/origins', async t => {
  const { overlay, base } = await setup(t);
  const response = await fetch(overlay.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /new EventSource/);
  assert.match(html, /speechSynthesis/);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    get(overlay.url, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/events`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/events`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('SSE preserves text, waits for matching acknowledgement, and permits one consumer', async t => {
  const { overlay, connect, ack } = await setup(t);
  await assert.rejects(overlay.play(line), /not available/);
  const events = await connect();
  await events.next('ready');
  const second = await connect();
  await second.next('busy');
  assert.equal(overlay.isConnected(), true);
  let ended = false;
  const played = overlay.play(line).then(() => { ended = true; });
  const speech = await events.next('speech');
  assert.equal(speech.text, line.text);
  assert.equal(speech.name, line.name);
  assert.equal(speech.audioUrl, null);
  assert.equal(ended, false);
  assert.equal((await ack('stale-id')).status, 404);
  assert.equal((await ack(speech.id, 'ended', 'https://evil.example')).status, 403);
  assert.equal(ended, false);
  await assert.rejects(overlay.play(line), /not available/);
  assert.equal((await ack(speech.id)).status, 204);
  await played;
  assert.equal(ended, true);
  assert.equal((await ack(speech.id)).status, 404);
});

test('audio bytes exist only during the current utterance', async t => {
  const { overlay, base, connect, ack } = await setup(t);
  const events = await connect();
  await events.next('ready');
  const audio = Buffer.from('test MP3 bytes');
  const played = overlay.play({ ...line, audio });
  const speech = await events.next('speech');
  const response = await fetch(`${base}${speech.audioUrl}`);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  await ack(speech.id);
  await played;
  assert.equal((await fetch(`${base}${speech.audioUrl}`)).status, 404);
});

test('playback errors reject and release the consumer for another line', async t => {
  const { overlay, connect, ack } = await setup(t);
  const events = await connect();
  await events.next('ready');
  const failed = assert.rejects(overlay.play(line), /playback failed/);
  const speech = await events.next('speech');
  await ack(speech.id, 'error');
  await failed;
  const next = overlay.play(line);
  const nextSpeech = await events.next('speech');
  await ack(nextSpeech.id);
  await next;
});

test('disconnect cancels playback; reconnect does not replay the stale line', async t => {
  const { overlay, connect } = await setup(t);
  const events = await connect();
  await events.next('ready');
  const failed = assert.rejects(overlay.play(line), /disconnected/);
  await events.next('speech');
  events.controller.abort();
  await failed;
  assert.equal(overlay.isConnected(), false);
  const next = await connect();
  await next.next('ready');
  assert.equal(overlay.isConnected(), true);
});

test('shutdown signal cancels playback and sends a stop event', async t => {
  const { overlay, connect } = await setup(t);
  const events = await connect();
  await events.next('ready');
  const controller = new AbortController();
  const failed = assert.rejects(overlay.play(line, controller.signal), /cancelled/);
  const speech = await events.next('speech');
  controller.abort();
  await failed;
  assert.deepEqual(await events.next('stop'), { id: speech.id });
});

test('a missing playback acknowledgement times out after 60 seconds', async t => {
  const { overlay, connect } = await setup(t);
  const events = await connect();
  await events.next('ready');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(overlay.play(line), /timed out/);
  const speech = await events.next('speech');
  t.mock.timers.tick(60000);
  await failed;
  assert.deepEqual(await events.next('stop'), { id: speech.id });
  t.mock.timers.reset();
});
