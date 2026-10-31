import { createTwitchClient } from './twitch.js';
import { startEventSub } from './eventsub.js';

let stop;
let validationTimer;
let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  clearInterval(validationTimer);
  stop?.();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  const client = createTwitchClient(process.env);
  const userId = await client.validate();
  if (shuttingDown) process.exit(0);
  stop = startEventSub({ client, userId,
    onRevoked: () => { shutdown(); process.exitCode = 1; }, onChat: async event => {
    console.log(JSON.stringify({ name: event.chatter_user_name, text: event.message.text }));
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
} catch (error) {
  console.error(error instanceof TypeError ? 'Twitch connection failed' : error.message);
  shutdown();
  process.exitCode = 1;
}
