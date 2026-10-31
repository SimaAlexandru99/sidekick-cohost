import test from 'node:test';
import assert from 'node:assert/strict';
import { createTts } from '../src/tts.js';

const mp3 = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
const audioResponse = () => new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });

test('no key returns text-only fallback without a network request', async () => {
  const synthesize = createTts({}, () => assert.fail('unexpected request'));
  assert.equal(await synthesize('Bună seara!'), null);
});

test('POST uses the configured key, default voice/model and original RO text', async () => {
  const text = 'Ce părere ai despre această rundă?';
  const synthesize = createTts({ ELEVENLABS_API_KEY: 'test-key' }, async (url, options) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/IKne3meq5aSn9XLyUdCD?output_format=mp3_44100_128');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['xi-api-key'], 'test-key');
    assert.equal(options.headers.Accept, 'audio/mpeg');
    assert.deepEqual(JSON.parse(options.body), { text, model_id: 'eleven_v4_turbo' });
    assert.ok(options.signal instanceof AbortSignal);
    return audioResponse();
  });
  assert.deepEqual(await synthesize(text), mp3);
});

test('voice and model overrides are honored', async () => {
  const synthesize = createTts({ ELEVENLABS_API_KEY: 'key', ELEVENLABS_VOICE_ID: 'custom/voice',
    ELEVENLABS_MODEL_ID: 'custom-model' }, async (url, options) => {
    assert.match(url, /custom%2Fvoice\?/);
    assert.equal(JSON.parse(options.body).model_id, 'custom-model');
    return audioResponse();
  });
  await synthesize('Hello!');
});

test('unsafe text is rejected before requests, including without an API key', async () => {
  for (const env of [{}, { ELEVENLABS_API_KEY: 'key' }]) {
    const synthesize = createTts(env, () => assert.fail('unexpected request'));
    await assert.rejects(synthesize('visit example.com'), /rejected by filters/);
  }
});

test('HTTP, network, wrong format and empty audio failures are sanitized and never retried', async () => {
  for (const reply of [() => new Response('private-value', { status: 401 }),
    () => new Response('private-value', { status: 429 }),
    () => new Response('private-value'),
    () => new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
    () => { throw new Error('private-value'); }]) {
    let calls = 0;
    const synthesize = createTts({ ELEVENLABS_API_KEY: 'key' }, async () => { calls++; return reply(); });
    await assert.rejects(synthesize('Hello'), { message: 'ElevenLabs synthesis failed' });
    assert.equal(calls, 1);
  }
});

test('shutdown signal cancels an in-flight request', async () => {
  const controller = new AbortController();
  const synthesize = createTts({ ELEVENLABS_API_KEY: 'key' }, async (url, { signal }) => {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const promise = synthesize('Hello', controller.signal);
  controller.abort();
  await assert.rejects(promise, /ElevenLabs synthesis failed/);
});
