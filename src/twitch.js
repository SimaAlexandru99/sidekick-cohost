const HELIX = 'https://api.twitch.tv/helix';

async function readJson(response) {
  try { return await response.json(); }
  catch { throw new Error('Invalid Twitch JSON response'); }
}

export function createTwitchClient(env, fetcher = fetch) {
  for (const key of ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_ACCESS_TOKEN',
    'TWITCH_REFRESH_TOKEN', 'TWITCH_CHANNEL_LOGIN']) {
    if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
  }
  let accessToken = env.TWITCH_ACCESS_TOKEN;
  let refreshToken = env.TWITCH_REFRESH_TOKEN;
  let refreshing;
  let userId;

  async function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const response = await fetcher('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
            client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Token refresh failed (${response.status})`);
        const data = await readJson(response);
        if (!data.access_token || !data.refresh_token) throw new Error('Invalid token refresh response');
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
      })().finally(() => { refreshing = undefined; });
    }
    await refreshing;
  }

  async function request(url, options = {}, validation = false) {
    const token = accessToken;
    const send = () => fetcher(url, { ...options, signal: AbortSignal.timeout(15000),
      headers: { 'Client-Id': env.TWITCH_CLIENT_ID, 'Content-Type': 'application/json',
        Authorization: `${validation ? 'OAuth' : 'Bearer'} ${accessToken}` } });
    let response = await send();
    if (response.status === 401) {
      if (accessToken === token) await refresh();
      response = await send();
    }
    if (!response.ok) throw new Error(`Twitch request failed (${response.status})`);
    return readJson(response);
  }

  async function validate() {
    const auth = await request('https://id.twitch.tv/oauth2/validate', {}, true);
    if (auth.client_id !== env.TWITCH_CLIENT_ID || !auth.user_id ||
        auth.login?.toLowerCase() !== env.TWITCH_CHANNEL_LOGIN.toLowerCase()) {
      throw new Error('Token must belong to the configured app and broadcaster account');
    }
    if (!['user:read:chat', 'user:write:chat', 'user:bot', 'moderator:read:followers',
      'channel:read:subscriptions'].every(scope => auth.scopes?.includes(scope))) {
      throw new Error('Token is missing required Twitch scopes');
    }
    userId = auth.user_id;
    return userId;
  }

  function requireIdentity() {
    if (!userId) throw new Error('Validate the Twitch account first');
  }

  return {
    validate,
    async subscribeEvents(sessionId, { mock = false } = {}) {
      requireIdentity();
      const subscriptions = [
        { type: 'channel.follow', version: '2',
          condition: { broadcaster_user_id: userId, moderator_user_id: userId } },
        { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: userId } },
        { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: userId } },
        { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: userId } },
      ];
      if (!mock) subscriptions.unshift({ type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: userId, user_id: userId } });
      await Promise.all(subscriptions.map(async subscription => {
        const options = { method: 'POST', body: JSON.stringify({ ...subscription,
          transport: { method: 'websocket', session_id: sessionId } }) };
        if (!mock) return request(`${HELIX}/eventsub/subscriptions`, options);
        const response = await fetcher('http://localhost:8080/eventsub/subscriptions', {
          // Twitch CLI requires a Client-Id header, but never needs real credentials.
          ...options, headers: { 'Content-Type': 'application/json', 'Client-Id': 'sidekick-mock' },
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (response.status !== 202) throw new Error(`Mock subscription failed (${response.status})`);
        return readJson(response);
      }));
    },
    async sendChatMessage(text) {
      requireIdentity();
      const result = await request(`${HELIX}/chat/messages`, { method: 'POST',
        body: JSON.stringify({ broadcaster_id: userId, sender_id: userId, message: text }) });
      if (result.data?.[0]?.is_sent !== true) throw new Error('Twitch did not send the chat message');
    },
  };
}
