import { isSafeText } from './filters.js';

const PRIORITY = { raid: 4, sub: 3, ask: 2, recap: 2, follow: 1, highlight: 0 };

// play({ type, name, text, audio }, signal) resolves only when playback has ended.
export function createSpeechQueue({ synthesize, play, onError = console.error }) {
  if (typeof synthesize !== 'function' || typeof play !== 'function') {
    throw new Error('Speech queue requires synthesis and playback handlers');
  }
  const pending = [];
  const controller = new AbortController();
  let active = false;
  let gapTimer;

  async function run(item) {
    active = true;
    try {
      const audio = await synthesize(item.text, controller.signal);
      if (!controller.signal.aborted) await play({ ...item, audio }, controller.signal);
    } catch {
      if (!controller.signal.aborted) onError('Speech failed; skipping utterance');
    } finally {
      active = false;
      if (!controller.signal.aborted) {
        gapTimer = setTimeout(() => { gapTimer = undefined; pump(); }, 8000);
      }
    }
  }

  function pump() {
    if (!controller.signal.aborted && !active && !gapTimer && pending.length) {
      void run(pending.shift());
    }
  }

  return {
    enqueue(item) {
      if (controller.signal.aborted || !item || !Object.hasOwn(PRIORITY, item.type) ||
          typeof item.name !== 'string' || !item.name.trim() || !isSafeText(item.text)) return false;
      const entry = { type: item.type, name: item.name, text: item.text };
      pending.push(entry);
      pending.sort((a, b) => PRIORITY[b.type] - PRIORITY[a.type]);
      // Stable sorting keeps FIFO ties; the newest lowest-priority item is dropped.
      const dropped = pending.length > 5 ? pending.pop() : undefined;
      pump();
      return dropped !== entry;
    },
    isIdle: () => !controller.signal.aborted && !active && !gapTimer && pending.length === 0,
    stop() {
      controller.abort();
      clearTimeout(gapTimer);
      pending.length = 0;
    },
  };
}
