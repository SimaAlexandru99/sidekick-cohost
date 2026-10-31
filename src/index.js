import { createTwitchClient } from './twitch.js';
import { startEventSub } from './eventsub.js';
import { createChatFilter } from './filters.js';
import { createTts } from './tts.js';
import { createSpeechQueue } from './speech-queue.js';
import { startOverlay } from './overlay.js';
import { createHighlights } from './highlights.js';
import { createLiveEvents } from './live-events.js';

let stop;
let validationTimer;
let highlightTimer;
let overlay;
let queue;
let liveEvents;
let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  clearInterval(validationTimer);
  clearInterval(highlightTimer);
  stop?.();
  liveEvents?.stop();
  queue?.stop();
  void overlay?.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  const port = Number(process.env.PORT || 3030);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const client = createTwitchClient(process.env);
  const userId = await client.validate();
  const acceptChat = createChatFilter();
  if (shuttingDown) process.exit(0);
  overlay = await startOverlay({ port, onConnect: () => queue?.resume() });
  if (shuttingDown) {
    await overlay.close();
    process.exit(0);
  }
  queue = createSpeechQueue({ synthesize: createTts(process.env),
    play: overlay.play, canPlay: overlay.isConnected });
  const highlights = createHighlights(queue);
  liveEvents = createLiveEvents(queue);
  highlightTimer = setInterval(() => highlights.tick(), 1000);
  stop = startEventSub({ client, userId, mockUrl: process.env.EVENTSUB_MOCK_URL?.trim(),
    onEvent: liveEvents.handle,
    onRevoked: () => { shutdown(); process.exitCode = 1; }, onChat: async event => {
    if (!acceptChat(event.chatter_user_id, event.message.text)) return;
    console.log(JSON.stringify({ name: event.chatter_user_name, text: event.message.text }));
    highlights.consider(event);
    if (event.message.text.trim() === 'HeyGuys') {
      try { await client.sendChatMessage('VoHiYo'); }
      catch { console.error('Chat reply failed'); }
    }
  } });
  validationTimer = setInterval(async () => {
    try { await client.validate(); }
    catch { console.error('Token validation failed; stopping'); shutdown(); process.exitCode = 1; }
  }, 60 * 60 * 1000);
  console.log('Sidekick listening for Twitch chat');
  console.log(`OBS Browser Source: ${overlay.url} (Control audio via OBS)`);
} catch (error) {
  console.error(error instanceof TypeError ? 'Twitch connection failed' : error.message);
  shutdown();
  process.exitCode = 1;
}
