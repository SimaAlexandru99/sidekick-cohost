# Sidekick

Twitch co-host bot for the **Codex × TwitchCon Hackathon**. It listens to chat and live events, speaks with TTS, shows the line in an OBS overlay, and answers `!ask` / `!recap` so late joiners catch up fast.

Key feature: **`!recap`** — summarize the last 15 minutes of follows, subs, raids, and chat highlights in at most two sentences, then speak and post the summary.

## Requirements

- Node.js 22+
- [Twitch CLI](https://dev.twitch.tv/docs/cli/) (token + optional EventSub mock)
- One Twitch account used as both broadcaster and bot
- Optional: [ElevenLabs](https://elevenlabs.io/) API key (without it the overlay falls back to browser `speechSynthesis`)
- Optional: OpenAI API key (needed for `!ask` and `!recap`)

## Twitch app setup

1. Create an application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Note the **Client ID** and generate a **Client Secret**.
3. Use the Twitch CLI to mint a user access token with the scopes this bot needs:

```sh
twitch token -u -s "user:read:chat user:write:chat user:bot moderator:read:followers channel:read:subscriptions"
```

4. Copy Client ID, Client Secret, access token, refresh token, and your channel login into `.env` (see below).

## Environment

```sh
cp .env.example .env
```

| Variable | Required | Notes |
| --- | --- | --- |
| `TWITCH_CLIENT_ID` | yes | App client id |
| `TWITCH_CLIENT_SECRET` | yes | App secret (refresh) |
| `TWITCH_ACCESS_TOKEN` | yes | From `twitch token` |
| `TWITCH_REFRESH_TOKEN` | yes | From `twitch token` |
| `TWITCH_CHANNEL_LOGIN` | yes | Broadcaster login (lowercase) |
| `EVENTSUB_MOCK_URL` | no | e.g. `ws://127.0.0.1:8080/ws` for CLI mock |
| `ELEVENLABS_API_KEY` | no | Without it, overlay uses browser TTS |
| `ELEVENLABS_VOICE_ID` | no | Default `IKne3meq5aSn9XLyUdCD` |
| `ELEVENLABS_MODEL_ID` | no | Default `eleven_v4_turbo` |
| `OPENAI_API_KEY` | for commands | Needed for `!ask` / `!recap` |
| `OPENAI_MODEL` | no | OpenAI model id |
| `PORT` | no | Default `3030` (overlay binds `127.0.0.1`) |

Never commit `.env`. Tokens stay in memory after refresh; a restart may need a fresh CLI token.

## Install and run

```sh
npm install
npm start
```

Overlay URL (local only):

```text
http://127.0.0.1:3030/overlay
```

## OBS Browser Source

1. In OBS, add a **Browser Source**.
2. URL: `http://127.0.0.1:3030/overlay` (match `PORT` if you changed it).
3. Enable **Control audio via OBS** so stream audio includes TTS playback.
4. Keep a single overlay tab/source open — only one SSE consumer owns playback; extra clients see a busy notice.

## Chat commands

- `!ask <question>` — one-sentence OpenAI answer, spoken and posted to chat.
- `!recap` — up to two sentences covering the last 15 minutes (60s global cooldown).

Chat is filtered (blocklist, no links, 150 Unicode code points, per-user cooldown). Follow / sub / raid announcements are spoken only.

## Twitch CLI mock EventSub demo

Use this to exercise follow / sub / raid without waiting for live traffic.

Terminal 1 — start the mock websocket (Twitch CLI):

```sh
twitch event websocket start-websocket
```

Point Sidekick at the mock (in `.env`):

```env
EVENTSUB_MOCK_URL=ws://127.0.0.1:8080/ws
```

Restart `npm start`. Sidekick keeps the real EventSub connection and opens a second mock connection. Mock HTTP uses Client-Id `sidekick-mock` and never receives your Twitch credentials.

Trigger sample events (second terminal), for example:

```sh
twitch event trigger channel.follow -t <broadcaster_user_id>
twitch event trigger channel.subscribe -t <broadcaster_user_id>
twitch event trigger channel.raid --to_broadcaster_user_id <broadcaster_user_id>
```

Exact flags follow your Twitch CLI version; see `twitch event trigger --help`.

## Tests

```sh
npm test
```

Uses Node's built-in test runner (`node:test`) for filters, speech queue, live-event batching, highlights, EventSub helpers, overlay, Twitch client, TTS, and OpenAI wrappers.

## How Codex built it

This repo was implemented with **Codex** against `AGENTS.md` as the single product/engineering brief for the Codex × TwitchCon Hackathon.

Work landed in six vertical slices (one user message → one slice → local commit):

1. Skeleton, auth, chat EventSub read/send  
2. Filters + priority TTS queue + ElevenLabs  
3. OBS overlay (SSE + audio playback)  
4. Follow / sub / raid + mock EventSub  
5. `!ask` + `!recap` (OpenAI)  
6. English README + polish (this file) + MIT license  

Stack stays minimal on purpose: Node.js 22+ ESM, `ws` only, no TypeScript/build step, `node --env-file=.env` and `node:test`.

## License

[MIT](./LICENSE)
