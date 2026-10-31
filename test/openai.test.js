import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI } from '../src/openai.js';
import { createCommands } from '../src/commands.js';
import { createRecap } from '../src/recap.js';

test('OpenAI sends Responses API request privately and parses output text', async () => {
  const openai = createOpenAI({ OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test-model' }, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(options.body), { model: 'test-model', instructions: 'rule', input: 'hello', max_output_tokens: 100, store: false });
    return Response.json({ output: [{ content: [{ type: 'output_text', text: 'A concise answer.' }] }] });
  });
  assert.equal(await openai('rule', 'hello', 100), 'A concise answer.');
});

test('OpenAI rejects HTTP errors, multiline and oversized responses without exposing provider text', async () => {
  for (const reply of [new Response('secret body', { status: 500 }),
    Response.json({ output: [{ content: [{ type: 'output_text', text: 'one\ntwo' }] }] }),
    Response.json({ output: [{ content: [{ type: 'output_text', text: 'a'.repeat(151) }] }] })]) {
    const openai = createOpenAI({ OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'test' }, async () => reply);
    await assert.rejects(openai('rule', 'input', 100), { message: 'OpenAI response unavailable' });
  }
});

test('ask answers are spoken and posted; empty, unsafe and unrelated messages do nothing', async () => {
  const spoken = [], posted = [], requests = [];
  const commands = createCommands({ openai: async (...args) => { requests.push(args); return 'One useful answer.'; },
    queue: { enqueue: item => { spoken.push(item); return true; } }, recap: createRecap(),
    sendChatMessage: async text => posted.push(text) });
  assert.equal(await commands('Viewer', 'hello'), false);
  assert.equal(await commands('Viewer', '!ask'), true);
  assert.equal(await commands('Viewer', '!ask visit example.com'), true);
  assert.equal(await commands('Viewer', '!ask How do I improve this play?'), true);
  assert.deepEqual(requests[0], ['Answer in one concise English sentence. If the question is toxic, abusive, or unsafe, refuse briefly and politely.', 'How do I improve this play?', 100]);
  assert.deepEqual(spoken, [{ type: 'ask', name: 'Sidekick', text: 'One useful answer.' }]);
  assert.deepEqual(posted, ['One useful answer.']);
});

test('recap summarizes recent events in at most two sentences with 60s cooldown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const spoken = [], posted = [], requests = [];
  const recap = createRecap();
  recap.record('highlight', 'Viewer: What happened in that last round?');
  recap.record('channel.raid', 'Raider: channel.raid');
  const commands = createCommands({ openai: async (...args) => { requests.push(args); return 'A big raid arrived.'; },
    queue: { enqueue: item => { spoken.push(item); return true; } }, recap,
    sendChatMessage: async text => posted.push(text) });
  await commands('Viewer', '!recap');
  await commands('Viewer', '!recap');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], ['Summarize these recent stream events in English in at most two concise sentences. If there are no events, say there is nothing notable yet.', 'highlight: Viewer: What happened in that last round?\nchannel.raid: Raider: channel.raid', 120]);
  assert.equal(spoken[0].type, 'recap');
  assert.deepEqual(posted, ['A big raid arrived.']);
  t.mock.timers.tick(60000);
  await commands('Viewer', '!recap');
  assert.equal(requests.length, 2);
});

test('recap expires events after 15 minutes', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const recap = createRecap();
  recap.record('highlight', 'old moment');
  t.mock.timers.tick(14 * 60 * 1000);
  recap.record('raid', 'recent raid');
  t.mock.timers.tick(60 * 1000);
  assert.deepEqual(recap.getEvents(), ['raid: recent raid']);
});
