import { isSafeText } from './filters.js';

export function isHighlight(text) {
  if (!isSafeText(text) || text.trimStart().startsWith('!')) return false;
  const length = [...text].length;
  return (length >= 25 && text.includes('?')) || length > 80;
}

export function createHighlights(queue) {
  let candidate;
  let nextAt = 0;
  return {
    consider(event) {
      if (isHighlight(event.message.text)) {
        candidate = { type: 'highlight', name: event.chatter_user_name, text: event.message.text };
      }
    },
    tick() {
      if (!candidate || Date.now() < nextAt || !queue.isIdle()) return;
      if (queue.enqueue(candidate)) {
        candidate = undefined;
        nextAt = Date.now() + 90000;
      }
    },
  };
}
