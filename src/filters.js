const BLOCKLIST = new Set([
  'fuck', 'fucking', 'shit', 'bitch', 'cunt',
  'pula', 'pule', 'pizda', 'muie', 'futut', 'futu',
]);
const LINK = /[a-z][a-z\d+.-]*:\/\/|www\.|(?:[\p{L}\d-]+\.)+(?:xn--[a-z\d-]+|[\p{L}]{2,63})(?![\p{L}\p{N}-])|\b(?:\d{1,3}\.){3}\d{1,3}\b|\blocalhost(?::\d+|\/)/iu;
const USER_COOLDOWN_MS = 10000;

export function isSafeText(text) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > 150) return false;
  if (/[\p{Cc}\p{Cf}]/u.test(text)) return false;
  const normalized = text.normalize('NFKC');
  if (LINK.test(normalized)) return false;
  const words = normalized.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  // shortcut: lexical RO/EN blocklist cannot detect all abuse, expand with moderation before wider use.
  return !words.some(word => BLOCKLIST.has(word));
}

export function createChatFilter() {
  const cooldowns = new Map();
  return (userId, text) => {
    if (typeof userId !== 'string' || !userId || !isSafeText(text)) return false;
    const now = Date.now();
    for (const [id, until] of cooldowns) {
      if (until <= now) cooldowns.delete(id);
    }
    if (cooldowns.has(userId)) return false;
    cooldowns.set(userId, now + USER_COOLDOWN_MS);
    return true;
  };
}
