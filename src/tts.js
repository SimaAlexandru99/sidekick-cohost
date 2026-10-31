import { isSafeText } from './filters.js';

export function createTts(env, fetcher = fetch) {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || 'IKne3meq5aSn9XLyUdCD';
  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_v4_turbo';

  return async (text, signal) => {
    if (!isSafeText(text)) throw new Error('Speech text rejected by filters');
    signal?.throwIfAborted();
    if (!apiKey) return null;
    try {
      const timeout = AbortSignal.timeout(30000);
      const response = await fetcher(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        { method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: modelId }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('TTS request failed');
      }
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/mpeg') {
        await response.body?.cancel();
        throw new Error('Invalid TTS audio response');
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length) throw new Error('Empty TTS audio response');
      return audio;
    } catch {
      // Never expose provider response bodies or request credentials in logs.
      throw new Error('ElevenLabs synthesis failed');
    }
  };
}
