import WebSocket from 'ws';

const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';

function startConnection({ endpoint, subscribe, onNotification, onError, Socket, onRevoked, mock }) {
  const sockets = new Set();
  const seen = new Set();
  let active;
  let pending;
  let retry;
  let stopped = false;
  let retryDelay = 1000;

  function stop() {
    stopped = true;
    clearTimeout(retry);
    for (const socket of sockets) {
      clearTimeout(socket.watchdog);
      socket.terminate();
    }
    sockets.clear();
  }

  function reconnect() {
    if (stopped || retry || pending) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect(endpoint, false);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  function connect(url, handoff) {
    const socket = new Socket(url);
    sockets.add(socket);
    pending = socket;
    let timeout = 10000;
    const arm = () => {
      clearTimeout(socket.watchdog);
      // Allow delivery jitter when the server sends a keepalive at the deadline.
      socket.watchdog = setTimeout(() => socket.terminate(), timeout + 1000);
    };
    arm();
    socket.on('error', () => onError('EventSub connection error'));
    socket.on('close', () => {
      clearTimeout(socket.watchdog);
      sockets.delete(socket);
      if (pending === socket) pending = undefined;
      if (active === socket) active = undefined;
      if (!active) reconnect();
    });
    socket.on('message', async raw => {
      if (stopped || socket.closed) return;
      try {
        const message = JSON.parse(raw.toString());
        const type = message.metadata?.message_type;
        if (type === 'session_welcome') {
          const session = message.payload?.session;
          if (!session?.id) throw new Error('Invalid EventSub session');
          timeout = (session.keepalive_timeout_seconds ?? 10) * 1000;
          if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid keepalive timeout');
          const previous = active;
          active = socket;
          pending = undefined;
          arm();
          if (previous && previous !== socket) previous.close();
          if (!handoff) await subscribe(session.id);
          retryDelay = 1000;
        } else if (type === 'session_keepalive') {
          arm();
        } else if (type === 'session_reconnect') {
          arm();
          const url = new URL(message.payload.session.reconnect_url);
          if (mock ? !isMockUrl(url) :
              url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv' || url.username || url.password) {
            throw new Error('Invalid EventSub reconnect URL');
          }
          if (!pending) connect(url.href, true);
        } else if (type === 'revocation') {
          onError('EventSub subscription revoked; check token permissions and restart');
          stop();
          onRevoked();
        } else if (type === 'notification') {
          arm();
          const id = message.metadata.message_id;
          if (!id || seen.has(id)) return;
          seen.add(id);
          if (seen.size > 1000) seen.delete(seen.values().next().value);
          await onNotification(message.metadata.subscription_type, message.payload?.event);
        }
      } catch {
        onError('EventSub message handling failed');
        // A failed subscription must not leave a seemingly healthy idle connection.
        if (active === socket) socket.terminate();
      }
    });
  }

  connect(endpoint, false);
  return stop;
}

function isMockUrl(url) {
  return ['ws:', 'wss:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password;
}

export function startEventSub({ client, userId, onChat, onEvent = () => {}, mockUrl,
  onError = console.error, Socket = WebSocket, onRevoked = () => {} }) {
  if (mockUrl && !isMockUrl(new URL(mockUrl))) throw new Error('EVENTSUB_MOCK_URL must be a loopback WebSocket URL');
  const onNotification = async (type, event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const target = type === 'channel.raid' ? event.to_broadcaster_user_id : event.broadcaster_user_id;
    if (target !== userId) return;
    if (type === 'channel.chat.message') {
      if (typeof event.message?.text === 'string' && typeof event.chatter_user_id === 'string' &&
          event.chatter_user_id && event.chatter_user_id !== userId) await onChat(event);
    } else {
      await onEvent(type, event);
    }
  };
  const stopReal = startConnection({ endpoint: ENDPOINT,
    subscribe: id => client.subscribeEvents(id), onNotification, Socket, onRevoked,
    onError: message => onError(`Twitch: ${message}`) });
  let stopMock;
  try {
    if (mockUrl) stopMock = startConnection({ endpoint: mockUrl, mock: true,
      subscribe: id => client.subscribeEvents(id, { mock: true }), onNotification, Socket,
      onRevoked: () => {}, onError: message => onError(`Mock: ${message}`) });
  } catch (error) {
    stopReal();
    throw error;
  }
  return () => { stopReal(); stopMock?.(); };
}
