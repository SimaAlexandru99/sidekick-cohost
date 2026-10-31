export function createOpenAI(env, fetcher = fetch) {
  const key = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!key || !model) throw new Error('Missing OPENAI_API_KEY or OPENAI_MODEL');
  return async function complete(instructions, input, maxOutputTokens) {
    try {
      const response = await fetcher('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, instructions, input, max_output_tokens: maxOutputTokens, store: false }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('OpenAI request failed'); }
      const data = await response.json();
      const text = data.output?.flatMap(item => item.content ?? [])
        .find(item => item.type === 'output_text')?.text?.trim();
      if (!text || !/^[^\r\n]+[.!?]?$/.test(text) || [...text].length > 150) {
        throw new Error('Invalid OpenAI response');
      }
      return text;
    } catch { throw new Error('OpenAI response unavailable'); }
  };
}
