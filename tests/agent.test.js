import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, freshState, compactMessages } from '../extension/core/agent.js';
import { DEFAULT_SETTINGS, validateSettings } from '../extension/core/storage.js';
import { validateToolCall } from '../extension/core/tools.js';

// Most tests script every observation explicitly; auto-observation has its own tests.
const config = { ...DEFAULT_SETTINGS, model: 'test-model', permissionMode: 'auto', maxTurns: 8, autoObserve: false };
const snapshot = (text = 'Page result') => ({ tabId: 7, title: 'Example', url: 'https://example.com/', text, elements: [{ elementId: 'ab12c-1', tag: 'button', role: 'button', label: 'Save' }] });
const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, name, args });
const turn = (...toolCalls) => ({ text: '', toolCalls });
function harness(responses, initial = null, customRpc) {
  let saved = initial && structuredClone(initial);
  const actions = [], requests = [], snapshots = [];
  const agent = new Agent({
    provider: async args => {
      requests.push({ ...args, messages: structuredClone(args.messages) });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected provider call');
      return typeof response === 'function' ? response(args) : response;
    },
    rpc: async message => {
      if (message.type === 'browser') actions.push(message);
      if (customRpc) { const result = await customRpc(message); if (result !== undefined) return result; }
      if (message.type === 'currentTab') return { tabId: 7, url: 'https://example.com' };
      if (message.name === 'read_page') return snapshot();
      return { tabId: 7, ok: true, text: 'Page result' };
    },
    sleep: async () => {},
    storage: {
      loadSession: async () => saved,
      saveSession: async state => { saved = structuredClone(state); snapshots.push(saved); },
      clearSession: async () => { saved = null; },
    },
  });
  return { agent, actions, requests, snapshots, get saved() { return saved; } };
}
async function settle(agent) { if (agent._running) await agent._running; }

test('plan, observations, action and verification complete a sequential task', async () => {
  const h = harness([
    turn(call('update_plan', { steps: [{ step: 'Fill form', status: 'in_progress' }] })),
    turn(call('read_page', { tabId: 7 })),
    turn(call('type_text', { tabId: 7, elementId: 'e1', text: 'Draft' })),
    turn(call('read_page', { tabId: 7 })),
    turn(call('finish', { answer: 'Verified the draft.' })),
  ]);
  await h.agent.start('Fill a draft', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'completed');
  assert.equal(h.agent.state.answer, 'Verified the draft.');
  assert.deepEqual(h.actions.map(action => action.name), ['read_page', 'type_text', 'read_page']);
  assert.ok(h.snapshots.some(state => state.inFlight?.name === 'type_text'));
  assert.equal(h.saved.inFlight, null);
});

test('approval gates mutations, re-reads the page after them, and does not reset the response budget', async () => {
  const h = harness([turn(call('click', { tabId: 7, x: 10, y: 10 })), turn(call('finish', { answer: 'Done' }))]);
  await h.agent.start('Click once', { ...config, permissionMode: 'ask', maxTurns: 2, autoObserve: true }); await settle(h.agent);
  assert.equal(h.agent.state.status, 'approval'); assert.equal(h.actions.length, 0);
  assert.equal(h.agent.state.maxTurns, 2);
  await h.agent.approve(true); await settle(h.agent);
  assert.deepEqual(h.actions.map(action => action.name), ['click', 'read_page']); assert.equal(h.agent.state.maxTurns, 2);
  assert.match(h.requests[1].messages.at(-1).content, /PAGE AFTER THIS ACTION:[\s\S]*\[ab12c-1\] button "Save"/);
  assert.equal(h.agent.state.status, 'completed');
});

test('denial returns a tool result without dispatching the action', async () => {
  const h = harness([turn(call('close_tab', { tabId: 7 })), { text: 'I left the tab open.', toolCalls: [] }]);
  await h.agent.start('Close tab', { ...config, permissionMode: 'ask' }); await settle(h.agent);
  await h.agent.approve(false); await settle(h.agent);
  assert.equal(h.actions.length, 0);
  assert.match(h.agent.state.messages.find(message => message.role === 'tool').content, /declined/);
});

test('interrupted mutation is resolved as unknown and never blindly replayed', async () => {
  const interrupted = call('click', { tabId: 7, x: 2, y: 3 });
  const initial = { ...freshState(), task: 'Submit draft', status: 'running', pendingCalls: [interrupted], inFlight: interrupted,
    messages: [{ role: 'user', content: 'Submit draft' }, { role: 'assistant', content: '', toolCalls: [interrupted] }] };
  const h = harness([turn(call('read_page', { tabId: 7 })), turn(call('finish', { answer: 'Verified.' }))], initial);
  await h.agent.init(); assert.equal(h.agent.state.status, 'paused');
  await h.agent.resume(config); await settle(h.agent);
  assert.deepEqual(h.actions.map(action => action.name), ['read_page']);
  assert.match(h.agent.state.messages.find(message => message.toolCallId === interrupted.id).content, /UNKNOWN/);
});

test('pause aborts a pending model request and dispatches no later action', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = harness([({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    entered();
  })]);
  await h.agent.start('Wait for model', config); await ready;
  await h.agent.pause(); await settle(h.agent);
  assert.equal(h.agent.state.status, 'paused'); assert.equal(h.actions.length, 0);
});

test('stop during dispatched browser action records its result and starts no new actions', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = harness([turn(call('click', { tabId: 7, x: 1, y: 2 }), call('click', { tabId: 7, x: 3, y: 4 }))], null, async message => {
    if (message.type === 'browser') { entered(); return new Promise(resolve => { release = resolve; }); }
  });
  await h.agent.start('Two clicks', config); await ready;
  await h.agent.stop(); release({ clicked: true }); await settle(h.agent);
  assert.equal(h.agent.state.status, 'stopped'); assert.equal(h.actions.length, 1);
  assert.equal(h.agent.state.inFlight, null);
});

test('asking user pauses and reply supplies the matching tool result', async () => {
  const question = call('ask_user', { question: 'What title?' });
  const h = harness([turn(question), turn(call('finish', { answer: 'Title saved.' }))]);
  await h.agent.start('Prepare title', config); await settle(h.agent);
  assert.equal(h.agent.state.status, 'waiting');
  await h.agent.reply('Research draft'); await settle(h.agent);
  assert.match(h.agent.state.messages.find(message => message.toolCallId === question.id).content, /Research draft/);
  assert.equal(h.agent.state.status, 'completed');
});

test('step exhaustion pauses without losing pending observations', async () => {
  const h = harness([turn(call('read_page', { tabId: 7 }))]);
  await h.agent.start('Research', { ...config, maxTurns: 1 }); await settle(h.agent);
  assert.equal(h.agent.state.status, 'paused'); assert.equal(h.agent.state.turn, 1); assert.equal(h.actions.length, 1);
});

test('model switch drops incompatible signatures and old queued actions but preserves findings', async () => {
  const h = harness([turn(call('click', { tabId: 7, x: 10, y: 20 })), turn(call('finish', { answer: 'Reconsidered.' }))]);
  await h.agent.start('Work', { ...config, permissionMode: 'ask' }); await settle(h.agent);
  h.agent.state.notes = 'A useful source';
  await h.agent.resume({ ...config, model: 'different-model' }); await settle(h.agent);
  assert.equal(h.actions.length, 0); assert.match(h.requests[1].system, /A useful source/);
  assert.ok(h.requests[1].messages.every(message => !message.providerData && !message.toolCalls));
  // The new model must re-observe before it may claim success.
  assert.match(h.agent.state.messages.at(-1).content, /has not been checked/);
});

test('invalid tool args never reach the browser', async () => {
  const h = harness([turn(call('navigate', { url: 7 })), turn(call('finish', { answer: 'Failed safely.' }))]);
  await h.agent.start('Navigate', config); await settle(h.agent);
  assert.equal(h.actions.length, 0); assert.ok(h.agent.state.events.some(event => event.kind === 'error'));
});

test('compaction keeps the original task and whole native tool groups', () => {
  const messages = [{ role: 'user', content: 'original task' }];
  for (let i = 0; i < 10; i++) messages.push({ role: 'assistant', content: '', toolCalls: [call('read_page', {}, `c${i}`)] }, { role: 'tool', toolCallId: `c${i}`, content: 'x'.repeat(1000) });
  const compact = compactMessages(messages, 2500);
  assert.equal(compact[0].content, 'original task'); assert.ok(compact.length < messages.length);
  assert.ok(compact[1].compactionNote);
  assert.equal(compactMessages(compact, 2500).filter(message => message.compactionNote).length, 1);
  for (let i = 2; i < compact.length; i += 2) assert.equal(compact[i].toolCalls[0].id, compact[i + 1].toolCallId);
});

test('tool schema rejects unexpected arguments and unsafe settings', () => {
  assert.throws(() => validateToolCall(call('click', { x: 3, y: 2, code: 'alert(1)' })), /Unknown argument/);
  assert.throws(() => validateToolCall(call('wait', { milliseconds: 60000 })), /range/);
  assert.throws(() => validateToolCall(call('click', { x: 1 })), /both x and y/);
  assert.throws(() => validateSettings({ ...config, baseUrl: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => validateSettings({ ...config, baseUrl: 'https://example.com/v1?key=secret' }), /query/);
  assert.equal(validateSettings(config).baseUrl, 'http://localhost:11434/v1');
});

test('allowing a site approves later actions on that host only, with a guard on dispatch', async () => {
  const hosts = { a: 'example.com', b: 'example.com', c: 'other.example' };
  const h = harness([
    turn(call('click', { tabId: 7, x: 1, y: 1 }, 'a')),
    turn(call('click', { tabId: 7, x: 2, y: 2 }, 'b')),
    turn(call('click', { tabId: 8, x: 3, y: 3 }, 'c')),
  ], null, async message => {
    if (message.type === 'actionHost') return hosts[h.agent.state.pendingCalls[0].id];
  });
  await h.agent.start('Click around', { ...config, permissionMode: 'ask' }); await settle(h.agent);
  assert.equal(h.agent.state.pendingApproval.host, 'example.com');
  await h.agent.approve(true, { site: true }); await settle(h.agent);
  assert.deepEqual(h.agent.state.allowedSites, ['example.com']);
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions[0].siteGuard, undefined);
  assert.equal(h.actions[1].siteGuard, 'example.com');
  assert.equal(h.agent.state.status, 'approval');
  assert.equal(h.agent.state.pendingApproval.host, 'other.example');
});

test('actions without a resolvable host still need individual approval', async () => {
  const h = harness([turn(call('press_key', { key: 'Enter' })), turn(call('finish', { answer: 'Done' }))], null, async message => {
    if (message.type === 'actionHost') throw new Error('No tab');
  });
  await h.agent.start('Press enter', { ...config, permissionMode: 'ask' }); await settle(h.agent);
  assert.equal(h.agent.state.status, 'approval');
  assert.equal(h.agent.state.pendingApproval.host, undefined);
  assert.equal(h.actions.length, 0);
});

test('token usage accumulates across turns in every provider format', async () => {
  const h = harness([
    { ...turn(call('read_page', { tabId: 7 })), usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { ...turn(call('finish', { answer: 'Done' })), usage: { input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 5 } },
  ]);
  await h.agent.start('Read', config); await settle(h.agent);
  assert.deepEqual(h.agent.state.usage, { inputTokens: 175, outputTokens: 25 });
});
