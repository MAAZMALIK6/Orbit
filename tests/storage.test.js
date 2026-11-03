import test from 'node:test';
import assert from 'node:assert/strict';
import { validateShortcuts, MAX_SHORTCUTS } from '../extension/core/storage.js';
import { normalizeUsage } from '../extension/core/providers.js';

test('shortcuts drop invalid and duplicate entries and bound their size', () => {
  const list = validateShortcuts([
    { id: 'a', title: '  Weekly   report ', prompt: ' Summarize this page ' },
    { id: 'a', title: 'Duplicate', prompt: 'Ignored' },
    { id: 'b', prompt: '   ' },
    { id: 7, prompt: 'Bad id' },
    null,
    { id: 'c', prompt: 'x'.repeat(30000) },
  ]);
  assert.deepEqual(list.map(item => item.id), ['a', 'c']);
  assert.equal(list[0].title, 'Weekly report');
  assert.equal(list[0].prompt, 'Summarize this page');
  assert.equal(list[1].title.length, 80);
  assert.equal(list[1].prompt.length, 20000);
  assert.deepEqual(validateShortcuts('not a list'), []);
  const many = Array.from({ length: MAX_SHORTCUTS + 5 }, (_, i) => ({ id: `s${i}`, prompt: `Task ${i}` }));
  assert.equal(validateShortcuts(many).length, MAX_SHORTCUTS);
});

test('usage reports from each protocol normalize to input and output tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5 }), { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, cache_creation_input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 3 }), { inputTokens: 20, outputTokens: 3 });
  assert.deepEqual(normalizeUsage({ promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 7 }), { inputTokens: 8, outputTokens: 9 });
  assert.equal(normalizeUsage(undefined), null);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 'many' }), { inputTokens: 0, outputTokens: 0 });
});
