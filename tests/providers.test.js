import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, testConnection, PROVIDER_PRESETS } from '../extension/core/providers.js';

const tools = [
  { name: 'read_page', description: 'Read a page', parameters: { type: 'object', properties: { tabId: { type: 'integer' } } } },
  { name: 'click', description: 'Click an element', parameters: { type: 'object', properties: { elementId: { type: 'string' } }, required: ['elementId'] } },
];
const settings = { provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'test-model', apiKey: '', toolMode: 'native', vision: true, maxTokens: 4096 };
const image = { data: 'aGVsbG8=', mimeType: 'image/png' };
const user = { role: 'user', content: 'Read this page' };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const chat = (content = 'Ready', calls, finish = 'stop') => ({ choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const run = (override = {}) => complete({ settings, system: 'You are Orbit.', messages: [user], tools, ...override });

test('presets cover hosted and local providers without hardcoded model dependencies', () => {
  assert.deepEqual(PROVIDER_PRESETS.map((preset) => preset.id), ['openai', 'anthropic', 'gemini', 'openrouter', 'nvidia', 'ollama', 'lmstudio', 'custom']);
  assert.equal(PROVIDER_PRESETS.find((preset) => preset.id === 'ollama').baseUrl, 'http://localhost:11434/v1');
});

test('OpenAI-native tools and modern token limit use expected wire format', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const body = JSON.parse(init.body);
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.tools[0].function.name, 'read_page');
    return response(chat(null, [call('c1', 'read_page', { tabId: 12 })], 'tool_calls'));
  });
  const result = await run({ settings: { ...settings, provider: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKey: 'test-secret' } });
  assert.deepEqual(result.toolCalls, [{ id: 'c1', name: 'read_page', args: { tabId: 12 } }]);
  assert.equal(result.usage.prompt_tokens, 10);
});

test('compatible local server works without Authorization and uses max_tokens', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(JSON.parse(init.body).max_tokens, 4096);
    return response(chat());
  });
  assert.equal((await run()).text, 'Ready');
});

test('OpenAI screenshots follow all parallel tool results without breaking adjacency', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    assert.equal(messages[3].tool_call_id, 'c1');
    assert.equal(messages[4].tool_call_id, 'c2');
    assert.equal(messages[5].content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
    return response(chat());
  });
  await run({ messages: [user,
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_page', args: {} }, { id: 'c2', name: 'read_page', args: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_page', content: 'Page A', images: [image] },
    { role: 'tool', toolCallId: 'c2', name: 'read_page', content: 'Page B' },
  ] });
});

test('vision-disabled requests omit screenshots entirely', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.body.includes(image.data), false);
    assert.equal(JSON.parse(init.body).messages[1].content, 'Read this page');
    return response(chat());
  });
  await run({ settings: { ...settings, vision: false }, messages: [{ ...user, images: [image] }] });
});

test('Anthropic groups tool results and embeds screenshots in tool_result content', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'secret');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(init.body);
    assert.equal(body.system, 'You are Orbit.');
    assert.equal(body.tools[0].input_schema.type, 'object');
    assert.deepEqual(body.messages.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.equal(body.messages[2].content[0].tool_use_id, 'c1');
    assert.equal(body.messages[2].content[0].content[1].source.data, image.data);
    assert.equal(body.messages[2].content[1].tool_use_id, 'c2');
    return response({ content: [{ type: 'text', text: 'Next action' }, { type: 'tool_use', id: 'c3', name: 'click', input: { elementId: 'e1' } }], stop_reason: 'tool_use' });
  });
  const result = await run({ settings: { ...settings, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'secret' }, messages: [user,
    { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_page', args: {} }, { id: 'c2', name: 'read_page', args: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'Page', images: [image] },
    { role: 'tool', toolCallId: 'c2', content: 'Page 2' },
  ] });
  assert.deepEqual(result.toolCalls, [{ id: 'c3', name: 'click', args: { elementId: 'e1' } }]);
});

test('Gemini preserves exact signed response parts and function IDs across turns', async (t) => {
  const config = { ...settings, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'secret' };
  const parts = [{ text: 'Inspecting', thoughtSignature: 'text-signature' }, { functionCall: { id: 'google-1', name: 'read_page', args: {} }, thoughtSignature: 'opaque-signature' }];
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requestCount++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    assert.equal(url.includes('secret'), false);
    assert.equal(init.headers['x-goog-api-key'], 'secret');
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
    if (requestCount === 1) return response({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });
    assert.deepEqual(body.contents[1].parts, parts);
    assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: 'read_page', response: { title: 'Page' }, id: 'google-1' });
    assert.equal(body.contents[2].parts[1].inlineData.data, image.data);
    return response({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] });
  });
  const first = await run({ settings: config });
  assert.equal(first.toolCalls[0].id, 'google-1');
  const result = await run({ settings: config, messages: [user,
    { role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerData: first.providerData },
    { role: 'tool', toolCallId: 'google-1', content: '{"title":"Page"}', images: [image] },
  ] });
  assert.equal(result.text, 'Done');
});

test('Gemini assigns canonical IDs when provider omits them', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_page', args: {} } }] }, finishReason: 'STOP' }] }));
  const result = await run({ settings: { ...settings, provider: 'gemini', apiKey: 'secret' } });
  assert.match(result.toolCalls[0].id, /^call_/);
});

test('Gemini correlates results after the engine renames a duplicate canonical ID', async (t) => {
  const parts = [{ functionCall: { id: 'provider-id', name: 'read_page', args: {} }, thoughtSignature: 'signature' }];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents[1].parts, parts);
    assert.equal(body.contents[2].parts[0].functionResponse.id, 'provider-id');
    return response({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] });
  });
  await run({ settings: { ...settings, provider: 'gemini', apiKey: 'secret' }, messages: [user,
    { role: 'assistant', toolCalls: [{ id: 'renamed-id', name: 'read_page', args: {} }], providerData: { provider: 'gemini', model: 'test-model', parts } },
    { role: 'tool', toolCallId: 'renamed-id', content: 'Page' },
  ] });
});

test('OpenRouter reasoning details survive native transcript replay', async (t) => {
  const reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque-data' }];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.messages[2].reasoning_details, reasoningDetails);
    const result = chat();
    result.choices[0].message.reasoning_details = reasoningDetails;
    return response(result);
  });
  const result = await run({ messages: [user, { role: 'assistant', content: 'Working', providerData: { provider: 'compatible', reasoningDetails } }] });
  assert.deepEqual(result.providerData.reasoningDetails, reasoningDetails);
});

test('JSON mode works with ordinary chat roles and parses fenced JSON without native tools', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.ok(body.messages[0].content.includes('TOOL PROTOCOL'));
    assert.equal(body.messages.some((message) => message.role === 'tool'), false);
    assert.equal(body.messages[2].tool_calls, undefined);
    assert.equal(JSON.parse(body.messages[2].content).toolCalls[0].name, 'read_page');
    assert.match(body.messages[3].content, /TOOL RESULT/);
    return response(chat('```json\n{"text":"Clicking","toolCalls":[{"name":"click","args":{"elementId":"e1"}}]}\n```'));
  });
  const result = await run({ settings: { ...settings, toolMode: 'json' }, messages: [user,
    { role: 'assistant', content: 'Reading', toolCalls: [{ id: 'c1', name: 'read_page', args: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_page', content: 'Page content' },
  ] });
  assert.equal(result.text, 'Clicking');
  assert.deepEqual(result.toolCalls[0].args, { elementId: 'e1' });
});

test('JSON mode rejects prose and malformed shapes instead of reporting a successful task', async (t) => {
  for (const content of ['I clicked the button.', '{"answer":"Done"}', '{"text":"Done","toolCalls":{}}', '{"text":"Click","toolCalls":[{"name":"click","args":[]}]}']) {
    t.mock.method(globalThis, 'fetch', async () => response(chat(content)));
    await assert.rejects(run({ settings: { ...settings, toolMode: 'json' } }), /not a JSON object|fields|array|JSON object/);
  }
});

test('native malformed argument JSON is rejected; no silent empty object substitution', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(chat(null, [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{broken' } }], 'tool_calls')));
  await assert.rejects(run(), /invalid JSON tool arguments/);
});

test('unknown tools, duplicate IDs, arrays, missing calls and legacy function_call fail closed', async (t) => {
  const bodies = [
    chat(null, [call('c1', 'delete_everything', {})]),
    chat(null, [call('c1', 'read_page', {}), call('c1', 'read_page', {})]),
    chat(null, [call('c1', 'read_page', [])]),
    chat(null, [], 'tool_calls'),
    { choices: [{ message: { function_call: { name: 'read_page', arguments: '{}' } } }] },
  ];
  for (const body of bodies) {
    t.mock.method(globalThis, 'fetch', async () => response(body));
    await assert.rejects(run(), /unknown|duplicate|JSON object|legacy/);
  }
});

test('truncated, empty, filtered, and malformed native responses never yield actions', async (t) => {
  for (const body of [chat(null, [call('c1', 'click', { elementId: 'e1' })], 'length'), chat(''), chat('', undefined, 'content_filter'), { choices: [] }]) {
    t.mock.method(globalThis, 'fetch', async () => response(body));
    await assert.rejects(run(), /limit|empty|declined|no chat completion/);
  }
});

test('Gemini and Anthropic reject truncated tool output', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ content: [{ type: 'tool_use', name: 'click', input: { elementId: 'x' } }], stop_reason: 'max_tokens' }));
  await assert.rejects(run({ settings: { ...settings, provider: 'anthropic', apiKey: 'secret' } }), /output-token limit/);
  t.mock.method(globalThis, 'fetch', async () => response({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_page' } }] }, finishReason: 'MAX_TOKENS' }] }));
  await assert.rejects(run({ settings: { ...settings, provider: 'gemini', apiKey: 'secret' } }), /MAX_TOKENS/);
});

test('transient errors retry with a strict limit of three total attempts', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return response({ error: { message: 'Busy' } }, 429, { 'Retry-After': '0' });
  });
  await assert.rejects(run(), /HTTP 429/);
  assert.equal(attempts, 3);
});

test('transient retry can recover without changing the request', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(init.body);
    return requests.length === 1 ? response({}, 503, { 'Retry-After': '0' }) : response(chat('Recovered'));
  });
  assert.equal((await run()).text, 'Recovered');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});

test('authentication failures are not retried and cannot echo the API key', async (t) => {
  let attempts = 0;
  const apiKey = 'private-value+/=';
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return response({ error: { message: `Invalid key ${apiKey}; ${encodeURIComponent(apiKey)}; Bearer abcdef` } }, 401);
  });
  await assert.rejects(run({ settings: { ...settings, apiKey } }), (error) => {
    assert.match(error.message, /Check your API key/);
    assert.equal(error.message.includes(apiKey), false);
    assert.equal(error.message.includes(encodeURIComponent(apiKey)), false);
    assert.equal(error.message.includes('abcdef'), false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('invalid HTTP-success JSON and provider errors are surfaced clearly', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>not an API</html>'));
  await assert.rejects(run(), /invalid JSON/);
  t.mock.method(globalThis, 'fetch', async () => response({ error: { message: 'Unknown model' } }));
  await assert.rejects(run(), /Unknown model/);
});

test('oversized responses are rejected before parsing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(chat(), 200, { 'Content-Length': '5000000' }));
  await assert.rejects(run(), /too large/);
});

test('pre-aborted requests never reach fetch', async (t) => {
  let requested = false;
  t.mock.method(globalThis, 'fetch', async () => { requested = true; return response(chat()); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requested, false);
});

test('in-flight cancellation propagates without retrying', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    attempts++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  const controller = new AbortController();
  const request = run({ signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('retry backoff is immediately cancellable', async (t) => {
  let attempts = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return response({}, 429, { 'Retry-After': '10' });
  });
  const request = run({ signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('model requests time out and release the pending fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
  }));
  const request = run();
  const rejected = assert.rejects(request, /timed out after 120 seconds/);
  t.mock.timers.tick(120_000);
  await rejected;
  assert.equal(aborted, true);
});

test('invalid settings fail before networking', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return response(chat()); });
  for (const patch of [{ model: '' }, { provider: 'unknown' }, { baseUrl: 'https://user:secret@example.com/v1' }, { baseUrl: 'file:///tmp' }, { baseUrl: 'http://example.com/v1' }, { baseUrl: 'http://localhost.attacker.example/v1' }, { baseUrl: 'https://example.com/v1?key=secret' }, { provider: 'openai', apiKey: '' }, { maxTokens: -1 }]) {
    await assert.rejects(run({ settings: { ...settings, ...patch } }));
  }
  assert.equal(attempts, 0);
});

test('connection test uses generation without tool calls even when configured for JSON mode', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content.includes('TOOL PROTOCOL'), false);
    return response(chat('Ready.'));
  });
  const result = await testConnection({ ...settings, toolMode: 'json' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Ready.');
  assert.equal(typeof result.latencyMs, 'number');
});
