import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startEventSub } from '../src/eventsub.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [], subscriptions = [], chats = [], errors = [];
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
    client: { subscribeChat: async id => subscriptions.push(id) },
    onChat: async event => chats.push(event), onError: error => errors.push(error) });
  t.after(stop);
  return { sockets, subscriptions, chats, errors, stop };
}

test('subscribes, ignores self, and deduplicates chat notifications', async t => {
  const state = setup(t), socket = state.sockets[0];
  await socket.welcome();
  const notify = (id, user) => socket.message('notification', {
    event: { chatter_user_id: user, message: { text: 'HeyGuys' } },
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
