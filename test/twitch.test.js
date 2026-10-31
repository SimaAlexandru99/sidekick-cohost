import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchClient } from '../src/twitch.js';

const env = { TWITCH_CLIENT_ID: 'app', TWITCH_CLIENT_SECRET: 'secret',
  TWITCH_ACCESS_TOKEN: 'old', TWITCH_REFRESH_TOKEN: 'refresh', TWITCH_CHANNEL_LOGIN: 'host' };
const auth = { client_id: 'app', user_id: '1', login: 'host',
  scopes: ['user:read:chat', 'user:write:chat', 'user:bot'] };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('configuration and identity are validated', async () => {
  assert.throws(() => createTwitchClient({}), /Missing TWITCH_CLIENT_ID/);
  for (const change of [{ login: 'other' }, { client_id: 'other' }, { scopes: [] }]) {
    const client = createTwitchClient(env, async () => response({ ...auth, ...change }));
    await assert.rejects(client.validate());
  }
});

test('chat subscription and sending use the validated identity; dropped messages fail', async () => {
  const calls = [];
  const replies = [auth, { data: [] }, { data: [{ is_sent: true }] }, { data: [{ is_sent: false }] }];
  const client = createTwitchClient(env, async (url, options) => {
    calls.push({ url, ...options });
    return response(replies.shift());
  });
  assert.throws(() => client.subscribeChat('session'), /Validate/);
  await client.validate();
  await client.subscribeChat('session');
  await client.sendChatMessage('VoHiYo');
  assert.deepEqual(JSON.parse(calls[1].body), {
    type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1', user_id: '1' },
    transport: { method: 'websocket', session_id: 'session' },
  });
  assert.equal(calls[2].url, 'https://api.twitch.tv/helix/chat/messages');
  assert.deepEqual(JSON.parse(calls[2].body), { broadcaster_id: '1', sender_id: '1', message: 'VoHiYo' });
  await assert.rejects(client.sendChatMessage('no'), /did not send/);
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
