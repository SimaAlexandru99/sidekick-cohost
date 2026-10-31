import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveEvents } from '../src/live-events.js';
import { isSafeText } from '../src/filters.js';

const follower = name => ({ user_id: name, user_name: name });
function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const items = [];
  const events = createLiveEvents({ enqueue: item => { items.push(item); return true; } });
  t.after(events.stop);
  return { events, items };
}

test('follows use a fixed five-second window and English list grammar', t => {
  const { events, items } = setup(t);
  events.handle('channel.follow', follower('A'));
  t.mock.timers.tick(3000);
  events.handle('channel.follow', follower('B'));
  events.handle('channel.follow', follower('C'));
  t.mock.timers.tick(1999);
  assert.equal(items.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(items, [{ type: 'follow', name: 'New followers', text: 'Welcome A, B and C' }]);
  events.handle('channel.follow', follower('D'));
  events.handle('channel.follow', follower('E'));
  t.mock.timers.tick(5000);
  assert.equal(items[1].text, 'Welcome D and E');
  events.handle('channel.follow', follower('F'));
  t.mock.timers.tick(5000);
  assert.equal(items[2].text, 'Welcome F');
});

test('duplicate follows are cooled down and long batches split without dropping names', t => {
  const { events, items } = setup(t);
  const names = Array.from({ length: 8 }, (_, i) => `Viewer${i}`.padEnd(25, 'x'));
  for (const name of names) events.handle('channel.follow', follower(name));
  events.handle('channel.follow', follower(names[0]));
  t.mock.timers.tick(5000);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => isSafeText(item.text)));
  for (const name of names) assert.equal(items.filter(item => item.text.includes(name)).length, 1);
});

test('sub, resub, gift and raid create spoken lines with correct priorities', t => {
  const { events, items } = setup(t);
  events.handle('channel.subscribe', follower('Alice'));
  events.handle('channel.subscription.message', { ...follower('Bob'), message: { text: 'unsafe.example' } });
  events.handle('channel.subscribe', { ...follower('Carol'), is_gift: true });
  events.handle('channel.raid', { from_broadcaster_user_id: 'r', from_broadcaster_user_name: 'Raider' });
  assert.deepEqual(items.map(item => [item.type, item.text]), [
    ['sub', 'Alice, thanks for subscribing!'],
    ['sub', 'Welcome back Bob, thanks for resubscribing!'],
    ['sub', 'Carol, enjoy your gifted subscription!'],
    ['raid', 'Welcome Raider and your community, thanks for the raid!'],
  ]);
  assert.ok(items.every(item => isSafeText(item.text)));
});

test('unsafe/malformed actors and unsupported events are ignored without consuming cooldown', t => {
  const { events, items } = setup(t);
  for (const name of ['fuck', 'example.com', '<script>', 'a'.repeat(26), '', 'fu\u200bck']) {
    events.handle('channel.follow', { user_id: 'viewer', user_name: name });
  }
  events.handle('channel.follow', { user_name: 'MissingID' });
  events.handle('channel.unknown', follower('Unknown'));
  events.handle('channel.raid', null);
  events.handle('channel.follow', { user_id: 'viewer', user_name: 'SafeName' });
  t.mock.timers.tick(5000);
  assert.deepEqual(items.map(item => item.text), ['Welcome SafeName']);
});

test('live-event cooldown expires at ten seconds and stop discards pending follows', t => {
  const { events, items } = setup(t);
  events.handle('channel.subscribe', follower('Alice'));
  events.handle('channel.subscription.message', follower('Alice'));
  assert.equal(items.length, 1);
  t.mock.timers.tick(10000);
  events.handle('channel.subscription.message', follower('Alice'));
  assert.equal(items.length, 2);
  events.handle('channel.follow', follower('Bob'));
  events.stop();
  t.mock.timers.tick(5000);
  events.handle('channel.subscribe', follower('Carol'));
  assert.equal(items.length, 2);
});
