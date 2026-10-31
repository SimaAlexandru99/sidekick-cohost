# Sidekick

Twitch co-host bot for the Codex x TwitchCon Hackathon. Listen to chat and live
events, speak via TTS, and display speech in an OBS overlay. The key feature is
`!recap`: summarize recent stream events for viewers joining late.

## Stack and workflow

- Node.js 22+, plain JavaScript ESM, no build step or TypeScript. Only dependency: `ws`.
- Use built-in `fetch`, `node --env-file=.env`, and `node:test`.
- Base Twitch integration on https://dev.twitch.tv/docs/chat/chatbot-guide/.
- Build one slice per user message. Finish affected checks and commit locally after
  each slice. Do not advance to the next slice without another user message.
- Slice 1 must begin with `.gitignore` ignoring `.env` and `node_modules/`.
  Ignore other `.env.*` files except `.env.example`. Never commit secrets or log tokens.
- Public repository, MIT license. Keep implementation minimal; reuse shared handlers.

## Configuration and authentication

One Twitch account is both broadcaster and bot. Obtain the user access token with:

```sh
twitch token -u -s "user:read:chat user:write:chat user:bot moderator:read:followers channel:read:subscriptions"
```

Environment variables (provide a secret-free `.env.example`):

- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_ACCESS_TOKEN`,
  `TWITCH_REFRESH_TOKEN`, `TWITCH_CHANNEL_LOGIN`.
- Optional `EVENTSUB_MOCK_URL`, `ELEVENLABS_API_KEY`.
- `ELEVENLABS_VOICE_ID` defaults to `IKne3meq5aSn9XLyUdCD`;
  `ELEVENLABS_MODEL_ID` defaults to `eleven_v4_turbo`.
- `OPENAI_API_KEY`, `OPENAI_MODEL`; `PORT` defaults to `3030`.

Validate account/channel identity. On a Twitch API 401, refresh once and retry
once; share concurrent refreshes. No OAuth server. Keep refreshed tokens in memory;
do not rewrite `.env`. Restart may require fresh CLI tokens. Require credentials
only when their slice needs them; ElevenLabs is always optional.

## EventSub

- Real WebSocket: `wss://eventsub.wss.twitch.tv/ws`.
- Subscribe to `channel.chat.message` v1 (`broadcaster_user_id`, `user_id`),
  `channel.follow` v2 (`broadcaster_user_id`, `moderator_user_id`),
  `channel.subscribe` and `channel.subscription.message` (`broadcaster_user_id`),
  and `channel.raid` (`to_broadcaster_user_id`).
- Handle welcome, keepalive timeout, `session_reconnect`, unexpected disconnects,
  and revocations. Reconnect handoff preserves subscriptions; fresh sessions recreate
  them. Deduplicate notification IDs with a bounded cache.
- When `EVENTSUB_MOCK_URL` is set (typically `ws://127.0.0.1:8080/ws`), open a
  second connection. Subscribe mock follow/sub/raid events through
  `http://localhost:8080/eventsub/subscriptions`. Both sources use the same handler.

## Behavior

- Ignore messages from the bot itself. Before speaking, apply a blocklist, reject
  links, enforce a 150-character limit and a per-user cooldown.
- Slice 2 defaults: 10-second per-user cooldown on accepted chat, no cooldown for
  rejected text. Count Unicode code points; preserve original text. The local RO/EN
  blocklist is lexical, not comprehensive moderation; reject control/format characters.
- `!ask <q>`: OpenAI answers in one sentence and refuses toxic questions. Speak
  the answer and post it with `POST /helix/chat/messages`.
- `!recap`: keep an in-memory log of events and highlights from the last 15 minutes.
  OpenAI summarizes it in at most two sentences; speak and post it to chat.
  Global cooldown: 60 seconds.
- Highlight candidates are non-command messages with at least 25 characters and
  a `?`, or more than 80 characters. Select the latest candidate, at most once
  every 90 seconds, only when the queue is empty. Read verbatim in the original language.
- Follow/sub/raid announcements are spoken only. Batch follows in the same window:
  "Welcome A, B and C". Welcome each raid in a single sentence.
- Generated lines are English. Read Romanian/English chat as-is.

## Speech and overlay

- Queue priority: raid > sub > ask/recap > follow > highlight.
- One utterance at a time, minimum 8-second gap. Maximum five queued items;
  when full, drop the lowest priority first.
- Five means pending items, excluding the active utterance. Equal priorities are
  FIFO; overflow drops the newest item at the lowest priority. Do not preempt speech.
  Wait for playback completion, then the 8-second gap. Synthesis/playback failures
  skip the item and keep the gap; never log provider response bodies or retry paid TTS.
- `createSpeechQueue({ synthesize, play })` accepts `{ type, name, text }` items.
  `createTts(env)` returns MP3 bytes, or `null` without a key. `play(item, signal)`
  must resolve on actual playback completion and honor shutdown cancellation.
  Slice 3 supplies this playback consumer; slice 2 does not play audio in the terminal.
- ElevenLabs: `POST /v1/text-to-speech/{voice_id}`, configured `model_id`, MP3 output.
  Without its API key, send text only; the overlay uses browser `speechSynthesis`.
- `GET /overlay`: one HTML page receiving SSE events, showing the speaker name
  and current line, and playing audio. One OBS Browser Source with "Control audio via OBS".

## Slices and verification

1. Skeleton + chat read/send: `.gitignore` first, package/scripts/lockfile,
   `.env.example`, auth/API client and real chat EventSub. Expose
   `sendChatMessage(text)` and check `is_sent`. Use the guide's spectator
   `HeyGuys` -> `VoHiYo` exchange for initial verification. Shut down cleanly
   on SIGINT/SIGTERM.
2. Filters + priority TTS queue + ElevenLabs.
3. Overlay SSE + audio.
4. Follow/sub/raid + mock connection.
5. `!ask` + `!recap`.
6. English README + polish: purpose, Twitch app setup, CLI token command,
   environment setup, OBS setup, Twitch CLI trigger demo, and how Codex built it;
   include MIT license.

Use `node:test` for filters, queue priority/dropping, follow batching, and highlight
selection. Slice 1 also tests identity mismatch, single refresh/retry and final
failure, subscription/send payloads, self-message filtering, deduplication,
keepalive expiry, and reconnect without duplicate subscriptions using simulated
transports. Run affected checks and report commands with exit codes. Verify ignore
rules and staged changes before commits. Live Twitch checks need credentials and
a second account; explicitly report when they were not run.
