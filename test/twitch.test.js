import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchClient } from '../src/twitch.js';

const env = { TWITCH_CLIENT_ID: 'app', TWITCH_CLIENT_SECRET: 'secret',
  TWITCH_ACCESS_TOKEN: 'old', TWITCH_REFRESH_TOKEN: 'refresh', TWITCH_CHANNEL_LOGIN: 'host' };
const auth = { client_id: 'app', user_id: '1', login: 'host',
  scopes: ['user:read:chat', 'user:write:chat', 'user:bot', 'moderator:read:followers', 'channel:read:subscriptions'] };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('configuration and identity are validated', async () => {
  assert.throws(() => createTwitchClient({}), /Missing TWITCH_CLIENT_ID/);
  for (const change of [{ login: 'other' }, { client_id: 'other' }, { scopes: [] }]) {
    const client = createTwitchClient(env, async () => response({ ...auth, ...change }));
    await assert.rejects(client.validate());
  }
});

test('real subscriptions and chat sending use the validated identity', async () => {
  const calls = [];
  let sent = true;
  const client = createTwitchClient(env, async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/validate')) return response(auth);
    if (url.endsWith('/chat/messages')) return response({ data: [{ is_sent: sent }] });
    return response({ data: [] }, 202);
  });
  await assert.rejects(client.subscribeEvents('session'), /Validate/);
  await client.validate();
  await client.subscribeEvents('session');
  const subscriptions = calls.slice(1).map(call => JSON.parse(call.body));
  assert.deepEqual(subscriptions.map(({ type, version, condition }) => ({ type, version, condition })), [
    { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1', user_id: '1' } },
    { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '1', moderator_user_id: '1' } },
    { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: '1' } },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: '1' } },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '1' } },
  ]);
  for (const subscription of subscriptions) {
    assert.deepEqual(subscription.transport, { method: 'websocket', session_id: 'session' });
  }
  await client.sendChatMessage('VoHiYo');
  const call = calls.at(-1);
  assert.equal(call.url, 'https://api.twitch.tv/helix/chat/messages');
  assert.deepEqual(JSON.parse(call.body), { broadcaster_id: '1', sender_id: '1', message: 'VoHiYo' });
  sent = false;
  await assert.rejects(client.sendChatMessage('no'), /did not send/);
});

test('mock subscribes only follow/sub/raid, without credentials or token refresh', async () => {
  const calls = [];
  let status = 202;
  const client = createTwitchClient(env, async (url, options) => {
    if (url.endsWith('/validate')) return response(auth);
    calls.push({ url, ...options });
    return response({ data: [] }, status);
  });
  await client.validate();
  await client.subscribeEvents('mock-session', { mock: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => JSON.parse(call.body).type), [
    'channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.raid',
  ]);
  for (const call of calls) {
    assert.equal(call.url, 'http://localhost:8080/eventsub/subscriptions');
    assert.deepEqual(call.headers, { 'Content-Type': 'application/json', 'Client-Id': 'sidekick-mock' });
    assert.equal(call.redirect, 'error');
    assert.deepEqual(JSON.parse(call.body).transport, { method: 'websocket', session_id: 'mock-session' });
  }
  status = 401;
  await assert.rejects(client.subscribeEvents('bad', { mock: true }), /Mock subscription failed/);
  assert.equal(calls.length, 8);
});

test('validation requires follower and subscription scopes', async () => {
  for (const missing of ['moderator:read:followers', 'channel:read:subscriptions']) {
    const client = createTwitchClient(env, async () => response({ ...auth, scopes: auth.scopes.filter(scope => scope !== missing) }));
    await assert.rejects(client.validate(), /required Twitch scopes/);
  }
});

test('401 refreshes once and retries with the new token', async () => {
  const calls = [];
  const replies = [response({}, 401), response({ access_token: 'new', refresh_token: 'next' }), response(auth)];
  const client = createTwitchClient(env, async (url, options) => {
    calls.push({ url, ...options }); return replies.shift();
  });
  await client.validate();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.get('grant_type'), 'refresh_token');
  assert.equal(calls[2].headers.Authorization, 'OAuth new');
  assert.equal(env.TWITCH_ACCESS_TOKEN, 'old');
});

test('repeated 401 and refresh failure stop without loops', async () => {
  for (const replies of [
    [response({}, 401), response({ access_token: 'new', refresh_token: 'next' }), response({}, 401)],
    [response({}, 401), response({}, 400)],
  ]) {
    const client = createTwitchClient(env, async () => {
      assert.ok(replies.length); return replies.shift();
    });
    await assert.rejects(client.validate());
    assert.equal(replies.length, 0);
  }
});

test('concurrent unauthorized requests share one refresh', async () => {
  let refreshes = 0;
  const client = createTwitchClient(env, async (url, options) => {
    if (url.endsWith('/token')) {
      refreshes++;
      await new Promise(resolve => setImmediate(resolve));
      return response({ access_token: 'new', refresh_token: 'next' });
    }
    return options.headers.Authorization.endsWith('old') ? response({}, 401) : response(auth);
  });
  await Promise.all([client.validate(), client.validate()]);
  assert.equal(refreshes, 1);
});

test('malformed responses cannot expose response contents in errors', async () => {
  const client = createTwitchClient(env, async () => new Response('private-response-value'));
  await assert.rejects(client.validate(), error => {
    assert.equal(error.message, 'Invalid Twitch JSON response');
    return true;
  });
});
