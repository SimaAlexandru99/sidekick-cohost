import { isSafeText } from './filters.js';

export function createCommands({ openai, queue, recap, sendChatMessage, onError = console.error }) {
  return async function handle(name, text) {
    const match = /^!(ask|recap)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match) return false;
    const [, command, question = ''] = match;
    if (command.toLowerCase() === 'ask' && (!question.trim() || !isSafeText(question))) return true;
    if (command.toLowerCase() === 'recap' && !recap.allow()) return true;
    try {
      const answer = command.toLowerCase() === 'ask'
        ? await openai('Answer in one concise English sentence. If the question is toxic, abusive, or unsafe, refuse briefly and politely.', question.trim(), 100)
        : await openai('Summarize these recent stream events in English in at most two concise sentences. If there are no events, say there is nothing notable yet.', recap.getEvents().join('\n') || 'No recent events.', 120);
      if (!isSafeText(answer)) throw new Error('Unsafe generated answer');
      if (!queue.enqueue({ type: command.toLowerCase(), name: 'Sidekick', text: answer })) {
        onError('Speech queue full; response skipped');
        return true;
      }
      await sendChatMessage(answer);
    } catch { onError(`!${command.toLowerCase()} failed`); }
    return true;
  };
}
