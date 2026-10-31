import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatFilter, isSafeText } from '../src/filters.js';

test('accepts RO/EN, whole-word matches, and exactly 150 Unicode code points', () => {
  for (const text of ['Ce părere ai despre această rundă?', 'This is a classic play!', '  Hello!  ',
    'a'.repeat(150), '😀'.repeat(150)]) assert.equal(isSafeText(text), true, text);
  for (const text of ['', '   ', undefined, 123, 'a'.repeat(151), '😀'.repeat(151)]) {
    assert.equal(isSafeText(text), false);
  }
});

test('blocks profanity with case, diacritics and width normalization', () => {
  for (const text of ['FUCK!', 'what the fucking hell', 'MUÍE', 'ｆｕｃｋ', 'pula']) {
    assert.equal(isSafeText(text), false, text);
  }
});

test('blocks URLs, bare domains, IP links and invisible/control characters', () => {
  for (const text of ['https://example.com', 'HTTP://example.com', 'www.example.com',
    'visit twitch.tv/host', 'example.ro', 'пример.рф', 'example.xn--p1ai', 'ftp://host/file', '127.0.0.1:8080',
    'localhost:3030', 'ｅｘａｍｐｌｅ．ｃｏｍ', 'fu\u200bck', 'hello\nworld', 'hello\x1b[0m']) {
    assert.equal(isSafeText(text), false, text);
  }
});

test('cooldown is per user, accepts at 10s, and rejected text consumes no cooldown', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const accept = createChatFilter();
  assert.equal(accept('a', 'example.com'), false);
  assert.equal(accept('a', 'hello'), true);
  assert.equal(accept('a', 'again'), false);
  assert.equal(accept('b', 'hello'), true);
  t.mock.timers.tick(9999);
  assert.equal(accept('a', 'too early'), false);
  t.mock.timers.tick(1);
  assert.equal(accept('a', 'welcome back'), true);
  assert.equal(accept('', 'hello'), false);
});
