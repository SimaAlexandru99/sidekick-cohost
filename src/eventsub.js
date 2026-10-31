import WebSocket from 'ws';

const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';

export function startEventSub({ client, userId, onChat, onError = console.error,
  Socket = WebSocket, onRevoked = () => {} }) {
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
      connect(ENDPOINT, false);
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
      socket.watchdog = setTimeout(() => socket.terminate(), timeout);
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
          retryDelay = 1000;
          arm();
          if (previous && previous !== socket) previous.close();
          if (!handoff) await client.subscribeChat(session.id);
        } else if (type === 'session_keepalive') {
          arm();
        } else if (type === 'session_reconnect') {
          arm();
          const url = new URL(message.payload.session.reconnect_url);
          if (url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv') {
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
          const event = message.payload?.event;
          if (message.metadata.subscription_type === 'channel.chat.message' &&
              typeof event?.message?.text === 'string' && event.chatter_user_id &&
              event.chatter_user_id !== userId) await onChat(event);
        }
      } catch {
        onError('EventSub message handling failed');
        // A failed subscription must not leave a seemingly healthy idle connection.
        if (active === socket) socket.terminate();
      }
    });
  }

  connect(ENDPOINT, false);
  return stop;
}
