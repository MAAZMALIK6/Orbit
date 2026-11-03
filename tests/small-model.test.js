// Scripted versions of the mistakes small models make, and how Orbit recovers or stops for the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, repeatedCycle } from '../extension/core/agent.js';
import { DEFAULT_SETTINGS } from '../extension/core/storage.js';
import { complete, outputError, extractJsonObjects } from '../extension/core/providers.js';
import { coerceArgs, toolsFor, TOOLS, looksLikePlaceholder } from '../extension/core/tools.js';
import { formatSnapshot, formatToolResult, pruneObservations } from '../extension/core/observe.js';

const config = { ...DEFAULT_SETTINGS, model: 'small-model', permissionMode: 'auto', maxTurns: 12, compact: true, contextTokens: 8192 };
const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, name, args });
const turn = (...toolCalls) => ({ text: '', toolCalls });
const page = (text = 'Welcome', elements = [{ elementId: 'ab12c-1', tag: 'button', role: 'button', label: 'Save' }]) => ({ tabId: 7, title: 'Example', url: 'https://example.com/', text, elements });

function harness(responses, { rpc } = {}) {
  const actions = [], requests = [];
  const agent = new Agent({
    provider: async args => {
      requests.push({ ...args, messages: structuredClone(args.messages) });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected provider call');
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(args) : response;
    },
    rpc: async message => {
      if (message.type === 'browser') actions.push(message);
      if (rpc) { const result = await rpc(message); if (result !== undefined) return result; }
      if (message.type === 'currentTab') return { tabId: 7, url: 'https://example.com/' };
      if (message.name === 'read_page') return page();
      return { tabId: 7, ok: true };
    },
    storage: { loadSession: async () => null, saveSession: async () => {}, clearSession: async () => {} },
    sleep: async () => {},
  });
  return { agent, actions, requests };
}
const settle = async agent => { while (agent._running) await agent._running; };
// Every tool call in the transcript must have exactly one result, or native APIs reject the history.
function assertPairedResults(messages) {
  const calls = messages.flatMap(message => message.toolCalls || []).map(item => item.id);
  const results = messages.filter(message => message.role === 'tool').map(message => message.toolCallId);
  assert.deepEqual(results.sort(), calls.sort());
}

test('unusable model output is shown to the model and retried instead of failing the run', async () => {
  const h = harness([outputError('Your reply was not a JSON object.'), turn(call('read_page', {})), turn(call('finish', { answer: 'Read it.' }))]);
  await h.agent.start('Read the page', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'completed');
  assert.match(h.requests[1].messages.at(-1).content, /could not be used: Your reply was not a JSON object/);
});

test('three unusable replies in a row stop the run and ask the user; the reply resumes it', async () => {
  const h = harness([outputError('bad 1'), outputError('bad 2'), outputError('bad 3'), turn(call('finish', { answer: 'Done with help.' }))]);
  await h.agent.start('Do it', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'waiting');
  assert.match(h.agent.state.question, /unusable replies 3 times/);
  await h.agent.reply('The button is called Save.'); await settle(h.agent);
  assert.equal(h.agent.state.status, 'completed');
  assert.equal(h.requests.at(-1).messages.at(-1).content, 'The button is called Save.');
});

test('a reply without tools is nudged once, never silently treated as success after an unchecked action', async () => {
  const h = harness([
    turn(call('type_text', { elementId: 'ab12c-1', text: 'hi' })),
    { text: 'I typed it.', toolCalls: [] },
    { text: 'I typed it, all done.', toolCalls: [] },
  ]);
  await h.agent.start('Type hi', config); await settle(h.agent);
  assert.match(h.requests[2].messages.at(-1).content, /without calling a tool/);
  assert.equal(h.agent.state.status, 'waiting');
  assert.equal(h.agent.state.answer, '');
  assert.equal(h.agent.state.question, 'I typed it, all done.');
});

test('a plain-text answer after checked work completes on the second reply', async () => {
  const h = harness([turn(call('read_page', {})), { text: 'The page says Welcome.', toolCalls: [] }, { text: 'The page says Welcome.', toolCalls: [] }]);
  await h.agent.start('What does it say?', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'completed');
  assert.equal(h.agent.state.answer, 'The page says Welcome.');
});

test('finish right after an unchecked action is refused once so the result gets verified', async () => {
  const h = harness([
    turn(call('click', { elementId: 'ab12c-1' })),
    turn(call('finish', { answer: 'Saved!' })),
    turn(call('read_page', {})),
    turn(call('finish', { answer: 'Saved, confirmed.' })),
  ]);
  await h.agent.start('Save', { ...config, autoObserve: false }); await settle(h.agent);
  assert.equal(h.agent.state.status, 'completed');
  assert.equal(h.agent.state.answer, 'Saved, confirmed.');
  assert.ok(h.agent.state.messages.some(message => /has not been checked/.test(message.content)));
});

test('queued steps after a page-changing action are skipped and still answered', async () => {
  const h = harness([
    turn(call('click', { elementId: 'ab12c-1' }), call('type_text', { elementId: 'ab12c-2', text: 'x' }), call('remember', { note: 'clicked' }), call('finish', { answer: 'Done' })),
    turn(call('finish', { answer: 'Checked and done.' })),
  ]);
  await h.agent.start('Click then type', config); await settle(h.agent);
  assert.deepEqual(h.actions.map(action => action.name), ['click', 'read_page']);
  assert.equal(h.agent.state.notes, 'clicked');
  assert.equal(h.agent.state.answer, 'Checked and done.');
  assertPairedResults(h.agent.state.messages);
});

test('three failing steps in a row stop for help, and queued steps get results', async () => {
  const h = harness([
    turn(call('click', { elementId: 'gone-1' })),
    turn(call('click', { elementId: 'gone-2' })),
    turn(call('click', { elementId: 'gone-3' }), call('read_page', {})),
  ], { rpc: message => (message.name === 'click' ? Promise.reject(new Error('STALE_ELEMENT: Read the page again.')) : undefined) });
  await h.agent.start('Click', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'waiting');
  assert.match(h.agent.state.question, /last 3 steps failed.*STALE_ELEMENT/);
  assertPairedResults(h.agent.state.messages);
});

test('repeating the same step without the page changing stops for help', async () => {
  const scroll = () => turn(call('scroll', { direction: 'down' }));
  const h = harness([scroll(), scroll(), scroll()], { rpc: message => (message.name === 'scroll' ? { tabId: 7, action: 'scroll', direction: 'down', amount: 650 } : undefined) });
  await h.agent.start('Find the footer', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'waiting');
  assert.match(h.agent.state.question, /same step three times/);
});

test('a multi-step loop with unchanged results is warned once, then stops for help', async () => {
  const cycle = () => [turn(call('read_page', {})), turn(call('find', { query: 'Starter' })), turn(call('find', { query: 'Studio' }))];
  const h = harness([...cycle(), ...cycle(), ...cycle(), turn(call('read_page', {}))], { rpc: message => (message.name === 'find' ? { tabId: 7, query: message.args.query, matches: [] } : undefined) });
  await h.agent.start('Compare the plans', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'waiting');
  assert.match(h.agent.state.question, /same 3 steps three times/);
  assert.equal(h.actions.length, 9);
  assert.ok(!h.requests[5].messages.some(message => /repeated these same steps/.test(message.content)));
  assert.match(h.requests[6].messages.at(-1).content, /repeated these same steps/);
  assertPairedResults(h.agent.state.messages);
});

test('step cycles are found only when the same steps and results repeat back to back', () => {
  assert.equal(repeatedCycle(['a', 'a', 'a']), 1);
  assert.equal(repeatedCycle(['x', 'a', 'b', 'a', 'b', 'a', 'b']), 2);
  assert.equal(repeatedCycle(['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'], 2), 4);
  assert.equal(repeatedCycle(['a', 'b', 'a', 'b', 'a', 'c']), 0);
  assert.equal(repeatedCycle(['a', 'b', 'a', 'b']), 0);
});

test('placeholder text is refused before typing so the model asks for the real value', async () => {
  const h = harness([
    turn(call('type_text', { elementId: 'ab12c-1', text: '[Your Name]' })),
    turn(call('ask_user', { question: 'What name should I use?' })),
  ]);
  await h.agent.start("Send a message saying I'd like a demo", config); await settle(h.agent);
  assert.ok(!h.actions.some(action => action.name === 'type_text'));
  assert.match(h.requests[1].messages.at(-1).content, /placeholder text.*ask_user.*No action was taken/);
  assert.equal(h.agent.state.status, 'waiting');
  assert.equal(h.agent.state.question, 'What name should I use?');
});

test('placeholder-looking text the user asked for is typed', async () => {
  const h = harness([turn(call('type_text', { elementId: 'ab12c-1', text: '[Your Name]' })), turn(call('read_page', {})), turn(call('finish', { answer: 'Typed.' }))]);
  await h.agent.start('Type [Your Name] into the template field', config); await settle(h.agent);
  assert.ok(h.actions.some(action => action.name === 'type_text'));
  assert.equal(h.agent.state.status, 'completed');
});

test('placeholder detection catches template values but not ordinary text', () => {
  for (const text of ['[Your Name]', '<email>', '{{phone}}', 'Your phone number', 'Enter name', 'John Doe', 'Call 123-456-7890']) assert.ok(looksLikePlaceholder(text), text);
  for (const text of ['Alex Kim', 'Thanks for your email!', '[urgent] Fix login', 'Launch research', "I'd like a product demo."]) assert.ok(!looksLikePlaceholder(text), text);
});

test('sloppy arguments are repaired without inventing values', () => {
  assert.deepEqual(coerceArgs(call('click', { tabId: '7', elementId: '[ab12c-1]', reason: 'save', x: null })), { tabId: 7, elementId: 'ab12c-1' });
  assert.deepEqual(coerceArgs(call('click', { element_id: 12 })), { elementId: '12' });
  assert.deepEqual(coerceArgs(call('type_text', { id: 'ab12c-1', value: 'hello', clear: 'true' })), { elementId: 'ab12c-1', text: 'hello', clear: true });
  assert.deepEqual(coerceArgs(call('scroll', { direction: 'Down', amount: '400' })), { direction: 'down', amount: 400 });
  assert.deepEqual(coerceArgs(call('navigate', { url: 7 })), { url: 7 });
  assert.deepEqual(coerceArgs(call('wait', { ms: 500.4 })), { milliseconds: 500 });
});

test('small-model mode offers fewer, simpler tools and hides vision-only tools', () => {
  const names = tools => tools.map(tool => tool.name);
  const compact = toolsFor({ compact: true, vision: false });
  assert.ok(!names(compact).includes('screenshot') && !names(compact).includes('update_plan') && !names(compact).includes('drag'));
  const click = compact.find(tool => tool.name === 'click');
  assert.deepEqual(click.parameters.required, ['elementId']);
  assert.ok(!('x' in click.parameters.properties));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(TOOLS).length * 0.6);
  assert.ok(names(toolsFor({ compact: false, vision: true })).includes('screenshot'));
});

test('observations are compact text with ids, hints for sign-in and CAPTCHA, and bounded size', () => {
  const login = formatSnapshot({ ...page('Sign in to continue', [
    { elementId: 'ab12c-1', role: 'textbox', type: 'email', label: 'Email', value: '' },
    { elementId: 'ab12c-2', role: 'textbox', type: 'password', label: 'Password', value: '[redacted]' },
    { elementId: 'ab12c-3', role: 'combobox', label: 'Plan', options: [{ value: 'a', label: 'Starter', selected: true }, { value: 'b', label: 'Team' }] },
  ]) });
  assert.match(login, /\[ab12c-1\] textbox\(email\) "Email"/);
  assert.match(login, /options: "a"="Starter" \(selected\), "b"="Team"/);
  assert.match(login, /HINT: This page asks for a password/);
  assert.match(formatSnapshot(page('Please verify you are human')), /CAPTCHA/);
  const many = Array.from({ length: 400 }, (_, i) => ({ elementId: `ab12c-${i}`, role: 'link', label: `Link number ${i}`, url: `https://example.com/${i}` }));
  const big = formatSnapshot(page('x'.repeat(50000), many), { maxChars: 4000 });
  assert.ok(big.length <= 4400);
  assert.match(big, /More content exists than shown/);
});

test('only the newest observations stay in full', () => {
  const messages = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < 4; i++) {
    const { content, summary } = formatToolResult('read_page', page(`Page ${i}`));
    messages.push({ role: 'assistant', content: '', toolCalls: [call('read_page', {}, `c${i}`)] }, { role: 'tool', toolCallId: `c${i}`, name: 'read_page', content, summary });
  }
  pruneObservations(messages, 2);
  const tools = messages.filter(message => message.role === 'tool');
  assert.match(tools[0].content, /Older observation removed/);
  assert.match(tools[1].content, /Older observation removed/);
  assert.match(tools[3].content, /Page 3/);
});

test('history is trimmed to the configured context window', async () => {
  const responses = [];
  for (let i = 0; i < 8; i++) responses.push(turn(call('get_page_text', {})));
  responses.push(turn(call('finish', { answer: 'Done' })));
  const h = harness(responses, { rpc: message => (message.name === 'get_page_text' ? { tabId: 7, title: 'Long', url: 'https://example.com/', text: 'word '.repeat(2000), offset: 0, totalLength: 10000 } : undefined) });
  await h.agent.start('Read everything', { ...config, contextTokens: 4096, maxTokens: 1024 }); await settle(h.agent);
  const largest = Math.max(...h.requests.map(request => JSON.stringify(request.messages).length));
  assert.ok(largest < 4096 * 3.2, `history ${largest} chars exceeds the window`);
  assert.ok(h.requests.at(-1).messages.some(message => message.compactionNote));
});

const settings = { provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: 'small', apiKey: '', toolMode: 'json', vision: false, maxTokens: 1024 };
const chat = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tools = toolsFor({ compact: true });

test('JSON mode accepts JSON wrapped in prose, other key names, bare calls and thinking tags', async (t) => {
  const cases = [
    ['Sure! Here is my answer:\n{"text":"Clicking","toolCalls":[{"name":"click","args":{"elementId":"ab12c-1"}}]}\nHope that helps.', 'click'],
    ['{"name":"read_page","arguments":{}}', 'read_page'],
    ['<think>The user wants {braces}.</think>{"thought":"x","tool_calls":[{"function":{"name":"find","arguments":"{\\"query\\":\\"save\\"}"}}]}', 'find'],
    ['```json\n{"text":"","actions":[{"tool":"finish","parameters":{"answer":"ok"}}]}\n```', 'finish'],
  ];
  for (const [content, name] of cases) {
    t.mock.method(globalThis, 'fetch', async () => reply(chat(content)));
    const result = await complete({ settings, system: 's', messages: [{ role: 'user', content: 'go' }], tools });
    assert.equal(result.toolCalls[0].name, name, content);
  }
  t.mock.method(globalThis, 'fetch', async () => reply(chat('{"text":"All done, the page says Welcome."}')));
  const text = await complete({ settings, system: 's', messages: [{ role: 'user', content: 'go' }], tools });
  assert.deepEqual(text.toolCalls, []);
  t.mock.method(globalThis, 'fetch', async () => reply(chat('I clicked it.')));
  await assert.rejects(complete({ settings, system: 's', messages: [{ role: 'user', content: 'go' }], tools }), error => error.code === 'model_output');
});

test('JSON mode lists tools as short signatures with an example', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    assert.match(prompt, /- click\(tabId\?: integer, elementId: string\): Click a control/);
    assert.match(prompt, /Example: \{"text":"Opening the form"/);
    assert.ok(!prompt.includes('"additionalProperties"'));
    return reply(chat('{"text":"","toolCalls":[{"name":"read_page","args":{}}]}'));
  });
  await complete({ settings, system: 's', messages: [{ role: 'user', content: 'go' }], tools });
});

test('native transcripts sent to the API keep every tool result paired with its call across turns', async (t) => {
  const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const replies = [
    [toolCall('c1', 'read_page', {})],
    [toolCall('c2', 'click', { elementId: 'ab12c-1' }), toolCall('c3', 'type_text', { elementId: 'ab12c-1', text: 'x' })],
    [toolCall('c4', 'finish', { answer: 'Done' })],
  ];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    // Chat Completions rejects a tool message whose id is not in the preceding assistant tool_calls.
    messages.forEach((message, index) => {
      if (message.role !== 'tool') return;
      const owner = messages.slice(0, index).reverse().find(item => item.role === 'assistant');
      assert.ok(owner?.tool_calls?.some(item => item.id === message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
    });
    return reply({ choices: [{ message: { content: null, tool_calls: replies.shift() }, finish_reason: 'tool_calls' }] });
  });
  const agent = new Agent({
    rpc: async message => (message.type === 'currentTab' ? { tabId: 7 } : message.name === 'read_page' ? page() : { tabId: 7, ok: true }),
    storage: { loadSession: async () => null, saveSession: async () => {}, clearSession: async () => {} },
    sleep: async () => {},
  });
  await agent.start('Click save', { ...config, toolMode: 'native' }); await settle(agent);
  assert.equal(agent.state.status, 'completed');
  assert.equal(replies.length, 0);
});

test('native mode recovers tool calls a local model printed as text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => reply(chat('<tool_call>\n{"name": "click", "arguments": {"elementId": "ab12c-1"}}\n</tool_call>')));
  const result = await complete({ settings: { ...settings, toolMode: 'native' }, system: 's', messages: [{ role: 'user', content: 'go' }], tools });
  assert.deepEqual(result.toolCalls.map(({ name, args }) => ({ name, args })), [{ name: 'click', args: { elementId: 'ab12c-1' } }]);
  assert.equal(result.text, '');
  t.mock.method(globalThis, 'fetch', async () => reply(chat('Use the format {"name": "value"} when you write config.')));
  const prose = await complete({ settings: { ...settings, toolMode: 'native' }, system: 's', messages: [{ role: 'user', content: 'go' }], tools });
  assert.deepEqual(prose.toolCalls, []);
});

test('JSON extraction respects strings containing braces', () => {
  const found = extractJsonObjects('noise {"a":"}{","b":{"c":1}} tail {"d":2}');
  assert.deepEqual(found.map(item => item.value), [{ a: '}{', b: { c: 1 } }, { d: 2 }]);
});
