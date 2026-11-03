import { Agent } from '../core/agent.js';
import { DEFAULT_SETTINGS, MAX_SHORTCUTS, loadSettings, saveSettings, loadShortcuts, saveShortcuts } from '../core/storage.js';
import { PROVIDER_PRESETS, testConnection } from '../core/providers.js';

const $ = (id) => document.getElementById(id);
const activeStatuses = new Set(['running', 'approval', 'waiting']);
const statusLabels = { idle: 'Ready', running: 'Working', paused: 'Paused', approval: 'Your approval', waiting: 'Your input', completed: 'Complete', error: 'Needs attention', stopped: 'Stopped' };
const eventLabels = { user: 'You', assistant: 'Orbit', tool: 'Browser action', error: 'Something needs attention', system: 'Update' };
const eventMarkers = { user: '↗', assistant: '✳', tool: '✓', error: '!', system: '·' };
let settings = { ...DEFAULT_SETTINGS };
let state = { status: 'idle', events: [], plan: [], notes: [], turn: 0 };
let agent;
let ready = false;
let actionBusy = false;
let testController = null;
let lastRunId = null;
let shortcuts = [];
const eventNodes = new Map();

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}

function message(error) { return error instanceof Error ? error.message : String(error || 'Something went wrong. Please try again.'); }
function notify(text, tone = 'error') {
  $('notification-text').textContent = text;
  $('notification').dataset.tone = tone;
  $('notification').hidden = false;
}
function bind(id, event, handler) {
  $(id).addEventListener(event, (ev) => {
    try { Promise.resolve(handler(ev)).catch((error) => notify(message(error))); }
    catch (error) { notify(message(error)); }
  });
}

// Small, safe Markdown subset. Model text is always rendered as text nodes.
function inline(parent, text) {
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[2]) parent.append(node('strong', '', match[2]));
    else if (match[3]) parent.append(node('code', '', match[3]));
    else {
      const link = node('a', '', match[4]);
      link.href = match[5];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
    }
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

function renderProse(target, input) {
  target.replaceChildren();
  const lines = String(input || '').split('\n');
  let paragraph = [];
  let code = null;
  let list = null;
  function flush() {
    if (paragraph.length) {
      const p = node('p');
      inline(p, paragraph.join('\n'));
      target.append(p);
      paragraph = [];
    }
    list = null;
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code !== null) {
        const pre = node('pre');
        pre.append(node('code', '', code.join('\n')));
        target.append(pre);
        code = null;
      } else { flush(); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flush(); const h = node('h3'); inline(h, heading[1]); target.append(h); continue; }
    const item = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
    if (item) {
      const listType = item[1] ? 'UL' : 'OL';
      if (!list || list.tagName !== listType) { flush(); list = node(listType.toLowerCase()); target.append(list); }
      const li = node('li'); inline(li, item[2]); list.append(li); continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  if (code !== null) { const pre = node('pre'); pre.append(node('code', '', code.join('\n'))); target.append(pre); }
}

function updateModelLabel() {
  $('model-label').textContent = settings.model || 'Choose a model';
  $('model-button').title = settings.model ? `${settings.model} — change model` : 'Connect your model';
  $('getting-started').hidden = Boolean(settings.model);
  let runModel = '';
  try { runModel = state.connection ? JSON.parse(state.connection)[2] : ''; } catch { /* Older runs may not have a connection descriptor. */ }
  $('run-model').textContent = runModel || settings.model || 'Model not configured';
}

function renderPlan(plan) {
  const steps = Array.isArray(plan) ? plan : [];
  $('plan-card').hidden = steps.length === 0;
  $('plan-progress').textContent = `${steps.filter((step) => step.status === 'done').length} / ${steps.length}`;
  $('plan-list').replaceChildren(...steps.map((step, index) => {
    const li = node('li', step.status === 'in_progress' ? 'in-progress' : step.status === 'done' ? 'done' : '');
    const symbol = node('span', 'plan-symbol', step.status === 'done' ? '✓' : step.status === 'in_progress' ? '•' : index + 1);
    symbol.setAttribute('aria-hidden', 'true');
    const copy = node('span', '', step.step || 'Untitled step');
    copy.append(node('span', 'sr-only', ` (${String(step.status || 'pending').replaceAll('_', ' ')})`));
    li.append(symbol, copy);
    return li;
  }));
}

function eventNode(event) {
  const item = node('article', 'event');
  item.dataset.kind = event.kind || 'system';
  const marker = node('span', 'event-marker', eventMarkers[event.kind] || '·');
  marker.setAttribute('aria-hidden', 'true');
  const content = node('div');
  const heading = node('div', 'event-title');
  heading.append(node('span', '', eventLabels[event.kind] || 'Update'));
  const date = new Date(event.at);
  if (!Number.isNaN(date.getTime())) {
    const time = node('time', 'event-time', date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = date.toISOString();
    heading.append(time);
  }
  const body = node('div', 'event-body prose');
  renderProse(body, event.text);
  content.append(heading, body);
  if (event.details !== undefined && event.details !== null) {
    const details = node('details', 'details');
    const summary = node('summary', '', 'View details');
    const pre = node('pre', '', printableDetails(event.details));
    details.append(summary, pre);
    content.append(details);
  }
  item.append(marker, content);
  return item;
}

function printableDetails(details) {
  const filtered = scrubObject(details);
  const text = typeof filtered === 'string' ? filtered : JSON.stringify(filtered, null, 2);
  return String(text ?? '').slice(0, 30000);
}

function renderEvents(events) {
  const items = Array.isArray(events) ? events : [];
  const ids = new Set(items.map((event, index) => String(event.id ?? index)));
  for (const [id, record] of eventNodes) {
    if (!ids.has(id)) { record.element.remove(); eventNodes.delete(id); }
  }
  for (const [index, event] of items.entries()) {
    const id = String(event.id ?? index);
    const signature = JSON.stringify(event);
    const old = eventNodes.get(id);
    if (old?.signature === signature) continue;
    const element = eventNode(event);
    if (old) old.element.replaceWith(element);
    else $('events').append(element);
    eventNodes.set(id, { signature, element });
  }
}

function renderControls() {
  const active = activeStatuses.has(state.status);
  const canResume = ['paused', 'error'].includes(state.status) && Boolean(state.task);
  $('pause-button').hidden = state.status !== 'running';
  $('resume-button').hidden = !canResume;
  $('stop-button').hidden = !active && state.status !== 'paused';
  for (const id of ['pause-button', 'resume-button', 'stop-button', 'new-task-button', 'approve-button', 'approve-site-button', 'deny-button']) $(id).disabled = !ready || actionBusy;
  $('new-task-button').disabled = !ready || actionBusy || state.status === 'running';
  $('task-input').disabled = !ready || active || actionBusy;
  $('start-button').disabled = !ready || active || actionBusy || !$('task-input').value.trim();
  $('start-button').title = active ? 'Pause or stop the current task before starting another' : 'Start task (Ctrl+Enter)';
  $('task-input').placeholder = active ? 'Orbit is working on your task…' : state.task ? 'What would you like to do next?' : 'What would you like to get done?';
  $('working-indicator').hidden = state.status !== 'running';
  $('panel-note').lastChild.textContent = active ? ' Keep this panel open. Closing it interrupts the run.' : ' Keep this panel open while Orbit works. Open it anytime with Alt+Shift+O.';
  $('save-shortcut-button').disabled = !ready || !state.task;
}

function render(next) {
  state = next || state;
  const scroll = $('workspace');
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const newRun = state.id !== lastRunId;
  if (newRun) { eventNodes.clear(); $('events').replaceChildren(); lastRunId = state.id; }
  $('status-label').textContent = statusLabels[state.status] || 'Ready';
  $('status-pill').dataset.status = state.status;
  const hasTask = Boolean(state.task);
  $('welcome').hidden = hasTask;
  $('run').hidden = !hasTask;
  $('task-heading').textContent = state.task || '';
  updateModelLabel();
  $('turn-count').textContent = `Step ${state.turn || 0} of ${state.maxTurns || settings.maxTurns || 40}`;
  const tokens = (state.usage?.inputTokens || 0) + (state.usage?.outputTokens || 0);
  $('token-count').hidden = $('token-separator').hidden = !tokens;
  $('token-count').textContent = `${formatTokens(tokens)} tokens`;
  $('token-count').title = tokens ? `${state.usage.inputTokens.toLocaleString()} input · ${state.usage.outputTokens.toLocaleString()} output` : '';
  renderPlan(state.plan);
  renderEvents(state.events);
  renderControls();
  const approval = state.status === 'approval' && state.pendingApproval;
  $('approval-card').hidden = !approval;
  if (approval) {
    $('approval-reason').textContent = approval.reason || 'This action can change the page or send information. Review it before continuing.';
    $('approval-action').textContent = String(approval.name || 'Browser action').replaceAll('_', ' ');
    $('approval-details').textContent = printableDetails(approval.args || {});
    $('approve-site-button').hidden = !approval.host;
    $('approve-site-button').textContent = approval.host ? `Allow on ${approval.host} for this task` : '';
  }
  $('question-card').hidden = state.status !== 'waiting' || !state.question;
  $('agent-question').textContent = typeof state.question === 'string' ? state.question : state.question?.question || '';
  const help = state.questionCall?.name === 'help';
  $('question-title').textContent = help ? 'Orbit needs a hand.' : 'Over to you.';
  $('reply-input').placeholder = help ? 'Tell Orbit what to do next, or do the step yourself and reply “done”…' : 'Add the details Orbit needs…';
  $('answer-card').hidden = !state.answer;
  if (state.answer) renderProse($('answer-content'), state.answer);
  $('paused-note').hidden = !['paused', 'stopped', 'error'].includes(state.status);
  $('paused-message').textContent = state.status === 'error' ? 'The run needs attention. Check the error above, update your settings if needed, and resume when ready.' : state.status === 'stopped' ? 'This task has stopped. Start a new task whenever you’re ready.' : 'Your progress is saved. Resume when you’re ready; the next step will use your current model settings.';
  const notes = Array.isArray(state.notes) ? state.notes.join('\n\n') : String(state.notes || '');
  $('notes-details').hidden = !notes;
  if (notes) renderProse($('notes-content'), notes);
  if (newRun) scroll.scrollTop = 0;
  else if (follow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function formatTokens(count) {
  return count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}k` : String(count);
}

function renderShortcuts() {
  $('shortcuts').hidden = shortcuts.length === 0;
  $('shortcut-list').replaceChildren(...shortcuts.map((shortcut) => {
    const item = node('li', 'shortcut-item');
    const use = node('button', 'suggestion');
    use.type = 'button';
    use.title = shortcut.prompt.slice(0, 500);
    const icon = node('span', 'suggestion-icon', '↻');
    icon.setAttribute('aria-hidden', 'true');
    const copy = node('span');
    copy.append(node('strong', '', shortcut.title), node('small', '', shortcut.prompt.replace(/\s+/g, ' ').slice(0, 90)));
    use.append(icon, copy);
    use.addEventListener('click', () => {
      $('task-input').value = shortcut.prompt;
      $('task-input').focus();
      renderControls();
    });
    const remove = node('button', 'shortcut-delete', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete shortcut ${shortcut.title}`);
    remove.title = 'Delete shortcut';
    remove.addEventListener('click', () => {
      shortcuts = shortcuts.filter((entry) => entry.id !== shortcut.id);
      saveShortcuts(shortcuts).then((saved) => { shortcuts = saved; renderShortcuts(); }, (error) => notify(message(error)));
      renderShortcuts();
    });
    item.append(use, remove);
    return item;
  }));
}

async function saveCurrentAsShortcut() {
  if (!state.task) return;
  if (shortcuts.some((entry) => entry.prompt === state.task)) { notify('This task is already saved as a shortcut.', 'info'); return; }
  if (shortcuts.length >= MAX_SHORTCUTS) throw new Error(`You can keep up to ${MAX_SHORTCUTS} shortcuts. Delete one first.`);
  const title = state.task.replace(/\s+/g, ' ').trim();
  shortcuts = await saveShortcuts([{ id: crypto.randomUUID(), title: title.length > 60 ? `${title.slice(0, 57)}…` : title, prompt: state.task }, ...shortcuts]);
  renderShortcuts();
  notify('Saved. Start it again from the home screen with New task.', 'success');
}

function cancelTest() { testController?.abort(); testController = null; }

function fillSettings(value) {
  const match = PROVIDER_PRESETS.find((preset) => preset.provider === value.provider && preset.baseUrl.replace(/\/+$/, '') === String(value.baseUrl).replace(/\/+$/, ''));
  $('preset').value = match?.id || 'custom';
  $('provider').value = value.provider || DEFAULT_SETTINGS.provider;
  $('base-url').value = value.baseUrl || '';
  $('model').value = value.model || '';
  $('api-key').value = value.apiKey || '';
  $('tool-mode').value = value.toolMode || 'native';
  $('vision').checked = Boolean(value.vision);
  $('compact').checked = Boolean(value.compact);
  $('auto-observe').checked = value.autoObserve !== false;
  $('context-tokens').value = value.contextTokens || DEFAULT_SETTINGS.contextTokens;
  $('remember-key').checked = Boolean(value.rememberKey);
  $('permission-mode').value = value.permissionMode || 'ask';
  $('max-turns').value = value.maxTurns || 40;
  $('max-tokens').value = value.maxTokens || 4096;
  $('settings-feedback').textContent = '';
  $('test-result').textContent = '';
  updatePermissionDescription();
}

function readSettingsForm() {
  if (!$('settings-form').reportValidity()) return null;
  const value = {
    provider: $('provider').value, baseUrl: $('base-url').value.trim(), model: $('model').value.trim(),
    apiKey: $('api-key').value.trim(), toolMode: $('tool-mode').value, vision: $('vision').checked,
    rememberKey: $('remember-key').checked, permissionMode: $('permission-mode').value,
    maxTurns: Number($('max-turns').value), maxTokens: Number($('max-tokens').value),
    compact: $('compact').checked, autoObserve: $('auto-observe').checked, contextTokens: Number($('context-tokens').value),
  };
  if (!value.model) throw new Error('Enter the exact model ID from your provider.');
  const url = new URL(value.baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS for cloud APIs or HTTP on localhost for local models.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Use an API base URL without credentials, a query, or a fragment.');
  if (value.provider !== 'compatible' && !value.apiKey) throw new Error('This provider needs an API key.');
  return value;
}

function updatePermissionDescription() {
  $('permission-description').textContent = $('permission-mode').value === 'auto'
    ? 'Orbit can click, type, submit forms, and change tabs without individual approvals. It still asks for information it needs.'
    : 'Orbit asks before browser actions that can change a page or send information.';
}

async function openSettings() {
  if (ready) settings = await loadSettings();
  fillSettings(settings);
  $('api-key').type = 'password';
  $('toggle-key').textContent = 'Show';
  $('toggle-key').setAttribute('aria-label', 'Show API key');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
}

async function currentSettings() {
  settings = await loadSettings();
  if (!settings.model || !settings.baseUrl) {
    await openSettings();
    throw new Error('Connect a model in settings, then start your task.');
  }
  // Persist and validate the exact configuration used by this run or resume.
  settings = await saveSettings(settings);
  updateModelLabel();
  return settings;
}

async function act(work) {
  if (!ready) throw new Error('Orbit is still starting.');
  if (actionBusy) return;
  actionBusy = true;
  renderControls();
  try { await work(); }
  finally { actionBusy = false; renderControls(); }
}

function scrubString(value) {
  let text = String(value);
  if (settings.apiKey) for (const secret of [settings.apiKey, encodeURIComponent(settings.apiKey)]) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:sk-[\w-]{10,}|AIza[\w-]{10,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|secret)=)[^&#\s]+/gi, '$1[redacted]');
}

function scrubObject(value, depth = 0) {
  if (depth > 12) return '[omitted]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((entry) => scrubObject(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:api[_-]?key|authorization|password|cookie|set-cookie|token|access[_-]?token|secret|images?|data)$/i.test(key)) output[key] = '[omitted]';
    else output[key] = scrubObject(entry, depth + 1);
  }
  return output;
}

function exportRun() {
  const exported = scrubObject({
    format: 'orbit-run-v1', exportedAt: new Date().toISOString(),
    note: 'Connection keys, image data, and raw tool payloads are excluded. Conversation text may contain page content or user-provided information.',
    id: state.id, task: state.task, status: state.status, turn: state.turn, maxTurns: state.maxTurns,
    plan: state.plan, notes: state.notes, answer: state.answer, usage: state.usage, allowedSites: state.allowedSites,
    events: (state.events || []).map(({ id, kind, text, at }) => ({ id, kind, text, at })),
  });
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = node('a');
  anchor.href = url;
  anchor.download = `orbit-run-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('Log exported. It may include page content from the conversation.', 'success');
}

for (const preset of PROVIDER_PRESETS) {
  const option = node('option', '', preset.label);
  option.value = preset.id;
  $('preset').append(option);
}

for (const id of ['settings-button', 'connect-button', 'model-button']) bind(id, 'click', openSettings);
for (const id of ['close-settings', 'cancel-settings']) bind(id, 'click', () => $('settings-dialog').close());
bind('settings-dialog', 'close', cancelTest);
bind('dismiss-notification', 'click', () => { $('notification').hidden = true; });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); $('workspace').scrollTo({ top: 0, behavior: 'smooth' }); });

bind('preset', 'change', () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === $('preset').value);
  if (!preset) return;
  cancelTest();
  $('provider').value = preset.provider;
  $('base-url').value = preset.baseUrl;
  $('model').value = preset.model;
  $('api-key').value = '';
  $('tool-mode').value = preset.toolMode || 'native';
  $('vision').checked = preset.vision;
  $('compact').checked = Boolean(preset.compact);
  if (preset.contextTokens) $('context-tokens').value = preset.contextTokens;
  $('test-result').textContent = '';
  $('settings-feedback').textContent = '';
});
bind('provider', 'change', () => { $('preset').value = 'custom'; $('api-key').value = ''; });
bind('base-url', 'input', () => { $('preset').value = 'custom'; });
bind('permission-mode', 'change', updatePermissionDescription);
bind('toggle-key', 'click', () => {
  const show = $('api-key').type === 'password';
  $('api-key').type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? 'Hide' : 'Show';
  $('toggle-key').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  $('toggle-key').setAttribute('aria-pressed', String(show));
});
bind('settings-form', 'input', () => { cancelTest(); $('test-result').textContent = ''; $('settings-feedback').textContent = ''; });

bind('settings-form', 'submit', async (event) => {
  event.preventDefault();
  try {
    const value = readSettingsForm();
    if (!value) return;
    settings = await saveSettings(value);
    updateModelLabel();
    $('settings-dialog').close();
    notify('Settings saved. They apply when you start or resume a task.', 'success');
    $('task-input').focus();
  } catch (error) { $('settings-feedback').textContent = message(error); }
});

bind('test-connection', 'click', async () => {
  let controller;
  try {
    const value = readSettingsForm();
    if (!value) return;
    cancelTest();
    controller = new AbortController();
    testController = controller;
    $('test-connection').disabled = true;
    $('test-connection').textContent = 'Testing connection…';
    $('test-result').dataset.tone = '';
    $('test-result').textContent = 'Sending a small request to your selected model.';
    const result = await testConnection(value, controller.signal);
    if (controller.signal.aborted) return;
    $('test-result').textContent = `Connected${result?.latencyMs ? ` in ${(result.latencyMs / 1000).toFixed(1)}s` : ''}. The model responded. This checks the connection; tool and vision support depend on the model.`;
  } catch (error) {
    if (!controller?.signal.aborted) { $('test-result').textContent = message(error); $('test-result').dataset.tone = 'error'; }
  } finally {
    if (testController === controller || !testController) {
      testController = null;
      $('test-connection').disabled = false;
      $('test-connection').textContent = 'Test connection ↗';
    }
  }
});

for (const button of document.querySelectorAll('.suggestion')) button.addEventListener('click', () => {
  $('task-input').value = button.dataset.prompt;
  $('task-input').focus();
  renderControls();
});
bind('task-input', 'input', renderControls);
bind('task-input', 'keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('start-button').disabled) $('task-form').requestSubmit(); }
});
bind('task-form', 'submit', async (event) => {
  event.preventDefault();
  const task = $('task-input').value.trim();
  if (!task || activeStatuses.has(state.status)) return;
  await act(async () => {
    const value = await currentSettings();
    $('notification').hidden = true;
    await agent.start(task, value);
    $('task-input').value = '';
  });
});
bind('pause-button', 'click', () => act(() => agent.pause()));
bind('resume-button', 'click', () => act(async () => { const value = await currentSettings(); $('notification').hidden = true; await agent.resume(value); }));
bind('stop-button', 'click', () => act(() => agent.stop()));
bind('approve-button', 'click', () => act(() => agent.approve(true)));
bind('approve-site-button', 'click', () => act(() => agent.approve(true, { site: true })));
bind('deny-button', 'click', () => act(() => agent.approve(false)));
bind('reply-form', 'submit', async (event) => {
  event.preventDefault();
  const answer = $('reply-input').value.trim();
  if (!answer) return;
  await act(async () => { await agent.reply(answer, await currentSettings()); $('reply-input').value = ''; });
});
bind('new-task-button', 'click', () => act(async () => {
  await agent.reset();
  $('task-input').value = '';
  $('reply-input').value = '';
  $('notification').hidden = true;
  $('task-input').focus();
}));
bind('export-button', 'click', exportRun);
bind('save-shortcut-button', 'click', saveCurrentAsShortcut);

async function init() {
  render(state);
  if (!globalThis.chrome?.runtime?.id) {
    $('status-label').textContent = 'Preview';
    notify('Preview mode. Load the extension folder in Chrome to connect a model and run browser tasks.', 'info');
    fillSettings(settings);
    updateModelLabel();
    return;
  }
  try {
    settings = await loadSettings();
    updateModelLabel();
    shortcuts = await loadShortcuts();
    renderShortcuts();
    agent = new Agent({ onChange: render });
    await agent.init();
    ready = true;
    render(agent.state);
  } catch (error) {
    $('status-label').textContent = 'Needs attention';
    notify(`Orbit could not start: ${message(error)}`);
  }
}

void init().catch((error) => notify(message(error)));
