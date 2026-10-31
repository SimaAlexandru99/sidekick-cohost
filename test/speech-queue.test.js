import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechQueue } from '../src/speech-queue.js';
import { createTts } from '../src/tts.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const item = (type, text = type) => ({ type, name: 'Viewer', text });
function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spoken = [], errors = [];
  const queue = createSpeechQueue({ synthesize: createTts({}),
    play: async utterance => spoken.push(utterance), onError: error => errors.push(error), ...overrides });
  t.after(() => queue.stop());
  return { queue, spoken, errors };
}
async function next(t) { await flush(); t.mock.timers.tick(8000); await flush(); }

test('priorities, FIFO ties and text-only payload reach the playback consumer', async t => {
  const { queue, spoken } = setup(t);
  queue.enqueue(item('highlight', 'active'));
  for (const type of ['follow', 'ask', 'recap', 'sub', 'raid']) queue.enqueue(item(type));
  for (let i = 0; i < 6; i++) await next(t);
  assert.deepEqual(spoken.map(line => line.text), ['active', 'raid', 'sub', 'ask', 'recap', 'follow']);
  assert.ok(spoken.every(line => line.audio === null && line.name === 'Viewer'));
  assert.equal(queue.isIdle(), true);
});

test('full queue drops the lowest priority, including the new item when appropriate', async t => {
  const { queue, spoken } = setup(t);
  queue.enqueue(item('raid', 'active'));
  for (const type of ['highlight', 'follow', 'ask', 'sub', 'raid']) queue.enqueue(item(type));
  assert.equal(queue.enqueue(item('recap')), true);
  assert.equal(queue.enqueue(item('highlight', 'dropped')), false);
  for (let i = 0; i < 6; i++) await next(t);
  assert.deepEqual(spoken.map(line => line.text), ['active', 'raid', 'sub', 'ask', 'recap', 'follow']);
});

test('equal-priority overflow drops newest and pending entries are copied', async t => {
  const { queue, spoken } = setup(t);
  queue.enqueue(item('raid', 'active'));
  const first = item('ask', 'first');
  queue.enqueue(first);
  first.text = 'mutated';
  for (let i = 0; i < 4; i++) queue.enqueue(item('ask', `question ${i}`));
  assert.equal(queue.enqueue(item('recap', 'newest')), false);
  for (let i = 0; i < 6; i++) await next(t);
  assert.deepEqual(spoken.map(line => line.text), ['active', 'first', 'question 0', 'question 1', 'question 2', 'question 3']);
});

test('no overlap or preemption; eight-second gap starts after playback ends', async t => {
  let finish;
  const spoken = [];
  const { queue } = setup(t, { play: utterance => {
    spoken.push(utterance.text);
    return new Promise(resolve => { finish = resolve; });
  } });
  queue.enqueue(item('highlight', 'long utterance'));
  await flush();
  queue.enqueue(item('raid'));
  t.mock.timers.tick(60000);
  await flush();
  assert.deepEqual(spoken, ['long utterance']);
  finish();
  await flush();
  t.mock.timers.tick(7999);
  await flush();
  assert.deepEqual(spoken, ['long utterance']);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(spoken, ['long utterance', 'raid']);
  finish();
  await flush();
});

test('unsafe or invalid entries never reach synthesis', async t => {
  let calls = 0;
  const { queue } = setup(t, { synthesize: async () => { calls++; } });
  for (const entry of [null, item('unknown'), item('toString'), item('ask', 'example.com'),
    item('ask', 'a'.repeat(151)), { ...item('ask'), name: '' }]) {
    assert.equal(queue.enqueue(entry), false);
  }
  await flush();
  assert.equal(calls, 0);
});

test('synthesis and playback failures skip safely and continue after the gap', async t => {
  let attempts = 0;
  const played = [];
  const { queue, errors } = setup(t, {
    synthesize: async () => { if (++attempts === 1) throw new Error('private'); return null; },
    play: async utterance => { if (utterance.text === 'second') throw new Error('private'); played.push(utterance); },
  });
  queue.enqueue(item('ask', 'first'));
  queue.enqueue(item('ask', 'second'));
  queue.enqueue(item('ask', 'third'));
  await next(t);
  await next(t);
  assert.equal(played[0].text, 'third');
  assert.deepEqual(errors, ['Speech failed; skipping utterance', 'Speech failed; skipping utterance']);
});

test('stop aborts synthesis and prevents playback and further enqueues', async t => {
  let resolveAudio, signal;
  const { queue, spoken } = setup(t, { synthesize: (text, abortSignal) => {
    signal = abortSignal;
    return new Promise(resolve => { resolveAudio = resolve; });
  } });
  queue.enqueue(item('ask'));
  queue.enqueue(item('raid'));
  queue.stop();
  assert.equal(signal.aborted, true);
  resolveAudio(null);
  await next(t);
  assert.equal(spoken.length, 0);
  assert.equal(queue.enqueue(item('ask')), false);
});

test('ElevenLabs bytes flow through the queue to playback unchanged', async t => {
  const audio = Buffer.from('test-mp3');
  const { queue, spoken } = setup(t, { synthesize: createTts({ ELEVENLABS_API_KEY: 'key' },
    async () => new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } })) });
  queue.enqueue(item('ask', 'Salut, bun venit!'));
  await flush();
  assert.deepEqual(spoken[0].audio, audio);
  assert.equal(spoken[0].text, 'Salut, bun venit!');
});
