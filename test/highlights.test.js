import test from 'node:test';
import assert from 'node:assert/strict';
import { createHighlights, isHighlight } from '../src/highlights.js';

const message = text => ({ chatter_user_name: 'Viewer', message: { text } });

test('highlight boundaries, commands and unsafe text', () => {
  assert.equal(isHighlight('a'.repeat(23) + '?'), false);
  assert.equal(isHighlight('a'.repeat(24) + '?'), true);
  assert.equal(isHighlight('a'.repeat(80)), false);
  assert.equal(isHighlight('a'.repeat(81)), true);
  assert.equal(isHighlight('a'.repeat(150)), true);
  assert.equal(isHighlight('a'.repeat(151)), false);
  assert.equal(isHighlight('  !ask ' + 'a'.repeat(85)), false);
  assert.equal(isHighlight('a'.repeat(81) + ' example.com'), false);
  assert.equal(isHighlight('😀'.repeat(24) + '?'), true);
});

test('only latest candidate is spoken verbatim when idle; cooldown is 90s', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const queued = [];
  let idle = false;
  const highlights = createHighlights({ isIdle: () => idle, enqueue: item => { queued.push(item); return true; } });
  highlights.consider(message('What happened in the previous round?'));
  highlights.consider(message('Ce părere ai despre această rundă?'));
  highlights.consider(message('short'));
  highlights.tick();
  assert.equal(queued.length, 0);
  idle = true;
  highlights.tick();
  assert.deepEqual(queued[0], { type: 'highlight', name: 'Viewer', text: 'Ce părere ai despre această rundă?' });
  highlights.consider(message('How will the next round play out?'));
  t.mock.timers.tick(89999);
  highlights.tick();
  assert.equal(queued.length, 1);
  t.mock.timers.tick(1);
  highlights.tick();
  highlights.tick();
  assert.equal(queued.length, 2);
});

test('failed enqueue retains candidate without consuming cooldown', () => {
  let accepted = false;
  const calls = [];
  const highlights = createHighlights({ isIdle: () => true, enqueue: item => { calls.push(item); return accepted; } });
  highlights.consider(message('What happened in the previous round?'));
  highlights.tick();
  accepted = true;
  highlights.tick();
  assert.equal(calls.length, 2);
});
