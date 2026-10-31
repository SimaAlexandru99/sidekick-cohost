import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startEventSub } from '../src/eventsub.js';

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [], subscriptions = [], mockSubscriptions = [], chats = [], events = [], errors = [];
  class Socket extends EventEmitter {
    constructor(url) { super(); this.url = url; sockets.push(this); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    terminate() { this.close(); }
    async message(type, payload, metadata = {}) {
      const value = JSON.stringify({ metadata: { message_type: type, ...metadata }, payload });
      await Promise.all(this.listeners('message').map(listener => listener(value)));
    }
    welcome(id = 'session') {
      return this.message('session_welcome', { session: { id, keepalive_timeout_seconds: 10 } });
    }
  }
  const stop = startEventSub({ Socket, userId: '1',
    client: { subscribeEvents: async (id, options) => (options?.mock ? mockSubscriptions : subscriptions).push(id) },
    onChat: async event => chats.push(event), onEvent: async (type, event) => events.push({ type, event }),
    onError: error => errors.push(error), ...options });
  t.after(stop);
  return { sockets, subscriptions, mockSubscriptions, chats, events, errors, stop };
}

test('subscribes, ignores self, and deduplicates chat notifications', async t => {
  const state = setup(t), socket = state.sockets[0];
  await socket.welcome();
  const notify = (id, user) => socket.message('notification', {
    event: { broadcaster_user_id: '1', chatter_user_id: user, message: { text: 'HeyGuys' } },
  }, { message_id: id, subscription_type: 'channel.chat.message' });
  await notify('self', '1');
  await notify('viewer', '2');
  await notify('viewer', '2');
  assert.deepEqual(state.subscriptions, ['session']);
  assert.equal(state.chats.length, 1);
});

test('reconnect handoff keeps subscriptions and closes the old socket after welcome', async t => {
  const state = setup(t), old = state.sockets[0];
  await old.welcome();
  await old.message('session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=1' } });
  assert.equal(old.closed, undefined);
  await state.sockets[1].welcome('replacement');
  assert.equal(old.closed, true);
  assert.deepEqual(state.subscriptions, ['session']);
});

test('keepalives reset the watchdog; timeout creates a fresh subscribed session', async t => {
  const state = setup(t), socket = state.sockets[0];
  await socket.welcome();
  t.mock.timers.tick(9000);
  await socket.message('session_keepalive', {});
  t.mock.timers.tick(9000);
  assert.equal(socket.closed, undefined);
  t.mock.timers.tick(1000);
  assert.equal(socket.closed, undefined);
  t.mock.timers.tick(1000);
  assert.equal(socket.closed, true);
  t.mock.timers.tick(1000);
  await state.sockets[1].welcome('fresh');
  assert.deepEqual(state.subscriptions, ['session', 'fresh']);
});

test('unexpected disconnect reconnects; stop cancels retries', async t => {
  const state = setup(t);
  await state.sockets[0].welcome();
  state.sockets[0].close();
  t.mock.timers.tick(1000);
  assert.equal(state.sockets.length, 2);
  state.stop();
  t.mock.timers.tick(60000);
  assert.equal(state.sockets.length, 2);
});

test('revocation stops connections and reports an actionable error', async t => {
  const state = setup(t);
  await state.sockets[0].welcome();
  await state.sockets[0].message('revocation', {});
  t.mock.timers.tick(60000);
  assert.equal(state.sockets.length, 1);
  assert.equal(state.sockets[0].closed, true);
  assert.match(state.errors[0], /revoked/);
});

test('real and mock connect together, subscribe separately and use the same handler', async t => {
  const state = setup(t, { mockUrl: 'ws://127.0.0.1:8080/ws' });
  assert.deepEqual(state.sockets.map(socket => socket.url), ['wss://eventsub.wss.twitch.tv/ws', 'ws://127.0.0.1:8080/ws']);
  await state.sockets[0].welcome('real');
  await state.sockets[1].welcome('mock');
  assert.deepEqual(state.subscriptions, ['real']);
  assert.deepEqual(state.mockSubscriptions, ['mock']);
  const payload = { event: { broadcaster_user_id: '1', user_id: 'viewer', user_name: 'Viewer' } };
  const metadata = { message_id: 'same-id', subscription_type: 'channel.follow' };
  await state.sockets[0].message('notification', payload, metadata);
  await state.sockets[1].message('notification', payload, metadata);
  await state.sockets[1].message('notification', payload, metadata);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events[0], state.events[1]);
  assert.equal(state.chats.length, 0);
});

test('mock reconnect supports CLI port handoff without resubscribing', async t => {
  const state = setup(t, { mockUrl: 'ws://127.0.0.1:8080/ws' });
  await state.sockets[0].welcome('real');
  await state.sockets[1].welcome('mock');
  await state.sockets[1].message('session_reconnect', { session: { reconnect_url: 'ws://127.0.0.1:8081/ws' } });
  await state.sockets[2].welcome('moved');
  assert.equal(state.sockets[1].closed, true);
  assert.equal(state.sockets[0].closed, undefined);
  assert.deepEqual(state.mockSubscriptions, ['mock']);
  state.sockets[2].close();
  t.mock.timers.tick(1000);
  assert.equal(state.sockets[3].url, 'ws://127.0.0.1:8080/ws');
  await state.sockets[3].welcome('fresh');
  assert.deepEqual(state.mockSubscriptions, ['mock', 'fresh']);
});

test('mock revocation leaves the real connection alive; stop closes both sources', async t => {
  const state = setup(t, { mockUrl: 'ws://localhost:8080/ws' });
  await state.sockets[0].welcome();
  await state.sockets[1].welcome();
  await state.sockets[1].message('revocation', {});
  assert.equal(state.sockets[0].closed, undefined);
  assert.equal(state.sockets[1].closed, true);
  assert.match(state.errors[0], /^Mock:/);
  state.stop();
  t.mock.timers.tick(60000);
  assert.equal(state.sockets[0].closed, true);
  assert.equal(state.sockets.length, 2);
});

test('notifications for other broadcasters and malformed events are ignored', async t => {
  const state = setup(t);
  await state.sockets[0].welcome();
  const cases = [
    ['channel.follow', { broadcaster_user_id: 'other' }],
    ['channel.raid', { to_broadcaster_user_id: 'other' }],
    ['channel.chat.message', { broadcaster_user_id: 'other', chatter_user_id: '2', message: { text: 'HeyGuys' } }],
    ['channel.follow', null],
  ];
  for (const [index, [type, event]] of cases.entries()) {
    await state.sockets[0].message('notification', { event }, { message_id: String(index), subscription_type: type });
  }
  assert.equal(state.events.length, 0);
  assert.equal(state.chats.length, 0);
  assert.equal(state.errors.length, 0);
});

test('mock URLs cannot point to remote hosts', () => {
  for (const mockUrl of ['ws://evil.example/ws', 'https://localhost/ws', 'ws://user:pass@localhost/ws']) {
    assert.throws(() => startEventSub({ mockUrl }), /loopback WebSocket/);
  }
});

test('failed mock subscriptions back off without interrupting real chat', async t => {
  const state = setup(t, { mockUrl: 'ws://127.0.0.1:8080/ws',
    client: { subscribeEvents: async (id, options) => { if (options?.mock) throw new Error('rejected'); } } });
  await state.sockets[0].welcome('real');
  await state.sockets[1].welcome('mock');
  assert.equal(state.sockets[0].closed, undefined);
  t.mock.timers.tick(1000);
  assert.equal(state.sockets.length, 3);
  await state.sockets[2].welcome('retry');
  t.mock.timers.tick(1000);
  assert.equal(state.sockets.length, 3);
  t.mock.timers.tick(1000);
  assert.equal(state.sockets.length, 4);
  assert.equal(state.sockets[0].closed, undefined);
});

test('a keepalive arriving just after its nominal deadline keeps the connection alive', async t => {
  const state = setup(t);
  const socket = state.sockets[0];
  await socket.welcome();
  t.mock.timers.tick(10050);
  assert.equal(socket.closed, undefined);
  await socket.message('session_keepalive', {});
  t.mock.timers.tick(10050);
  assert.equal(socket.closed, undefined);
  assert.equal(state.sockets.length, 1);
});
