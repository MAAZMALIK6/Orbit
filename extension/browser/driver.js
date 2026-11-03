import {pageOperation} from './dom.js';

const attached = new Set();
const dialogs = new Map();
const dialogWaiters = new Map();
let selectedTabId;
let queue = Promise.resolve();
let listenersInstalled = false;
const WORLD_NAME = 'orbit-browser-agent-v1';
const COMMAND_TIMEOUT = 15000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('A valid HTTP(S) URL is required.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Use a complete URL beginning with http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) web pages can be controlled. Chrome pages, extensions, files, and script URLs are restricted.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed. Open a normal sign-in page.');
  return url.href;
}

function describeTab(tab) {
  let url = tab.url || tab.pendingUrl || '';
  let controllable = true;
  try { validateUrl(url); } catch { controllable = false; }
  try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; url = parsed.href; } catch { url = ''; }
  return {tabId: tab.id, title: tab.title || '', url, active: !!tab.active, windowId: tab.windowId, controllable};
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function coordinate(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) throw new Error(`${name} must be a nonnegative finite viewport coordinate.`);
  return value;
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  chrome.debugger.onDetach.addListener(source => { attached.delete(source.tabId); dialogs.delete(source.tabId); });
  chrome.debugger.onEvent?.addListener((source, method, params = {}) => {
    if (method === 'Page.javascriptDialogOpening') {
      const dialog = {type: String(params.type || 'alert'), message: String(params.message || '').slice(0, 1000), url: String(params.url || '').slice(0, 2000)};
      if (params.type === 'prompt') dialog.defaultPrompt = String(params.defaultPrompt || '').slice(0, 500);
      dialogs.set(source.tabId, dialog);
      for (const resolve of dialogWaiters.get(source.tabId) || []) resolve(dialog);
      dialogWaiters.delete(source.tabId);
    }
    if (method === 'Page.javascriptDialogClosed') dialogs.delete(source.tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    attached.delete(tabId);
    dialogs.delete(tabId);
    if (selectedTabId === tabId) selectedTabId = undefined;
  });
}

function dialogError(dialog) {
  return new Error(`A JavaScript ${dialog.type} dialog is open on this tab: "${dialog.message}". Use handle_dialog to accept or dismiss it before other actions.`);
}

function nextDialog(tabId) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
  dialogWaiters.get(tabId).add(resolve);
  return {promise, cancel: () => dialogWaiters.get(tabId)?.delete(resolve)};
}

async function tabFor(tabId, {allowRestricted = false} = {}) {
  installListeners();
  let tab;
  if (tabId !== undefined) {
    integer(tabId, 'tabId', 1, Number.MAX_SAFE_INTEGER);
    tab = await chrome.tabs.get(tabId);
  } else if (selectedTabId !== undefined) {
    try { tab = await chrome.tabs.get(selectedTabId); } catch { selectedTabId = undefined; }
  }
  if (!tab) [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!tab?.id) throw new Error('No browser tab is available. Open a web page first.');
  if (!allowRestricted) {
    validateUrl(tab.url || tab.pendingUrl || '');
    if (tab.pendingUrl) validateUrl(tab.pendingUrl);
  }
  selectedTabId = tab.id;
  return tab;
}

async function command(tabId, method, params = {}) {
  // Input that opens alert/confirm/prompt does not complete until the dialog is handled,
  // so input commands also settle when a dialog opens. Later input is skipped.
  const input = method.startsWith('Input.');
  if (input && dialogs.has(tabId)) return {skipped: 'dialog'};
  const dialog = input ? nextDialog(tabId) : null;
  const sent = chrome.debugger.sendCommand({tabId}, method, params);
  sent.catch?.(() => {});
  let timer;
  try {
    return await Promise.race([
      sent,
      ...(dialog ? [dialog.promise.then(opened => ({dialogOpened: opened}))] : []),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser command ${method} timed out. Its result is unknown; inspect the page before retrying.`)), COMMAND_TIMEOUT); }),
    ]);
  } finally { clearTimeout(timer); dialog?.cancel(); }
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try { await chrome.debugger.attach({tabId}, '1.3'); }
  catch (error) { throw new Error(`Cannot control this tab: ${error.message}. Close its DevTools or other debugger, and check Chrome's extension permissions.`); }
  attached.add(tabId);
  try {
    await command(tabId, 'Page.enable');
    await command(tabId, 'Runtime.enable');
  } catch (error) {
    attached.delete(tabId);
    await chrome.debugger.detach({tabId}).catch(() => {});
    throw error;
  }
}

async function page(tabId, operation, args = {}) {
  if (dialogs.has(tabId)) throw dialogError(dialogs.get(tabId));
  const {frameTree} = await command(tabId, 'Page.getFrameTree');
  const {executionContextId} = await command(tabId, 'Page.createIsolatedWorld', {frameId: frameTree.frame.id, worldName: WORLD_NAME});
  const response = await command(tabId, 'Runtime.evaluate', {
    expression: `(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`,
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise: false,
    timeout: 5000,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'DOM operation failed.';
    throw new Error(detail.split('\n')[0].replace(/^Error:\s*/, ''));
  }
  if (!response.result || response.result.type === 'undefined') throw new Error('Page inspection returned no result. The page may have navigated; read it again.');
  return response.result.value;
}

async function waitForLoad(tabId, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'loading') return {loaded: true, ...describeTab(tab)};
    await sleep(150);
  }
  return {loaded: false, ...describeTab(await chrome.tabs.get(tabId)), note: 'Page is still loading. Use wait then read_page.'};
}

async function targetPoint(tabId, args) {
  if (args.elementId !== undefined) {
    if (typeof args.elementId !== 'string' || args.elementId.length > 100) throw new Error('elementId must be an ID from read_page.');
    return page(tabId, 'point', {elementId: args.elementId});
  }
  const x = coordinate(args.x, 'x'), y = coordinate(args.y, 'y');
  const viewport = await page(tabId, 'viewport');
  if (x >= viewport.width || y >= viewport.height) throw new Error('Coordinates are outside the viewport. Use screenshot coordinates in CSS pixels.');
  return {x, y};
}

async function mouse(tabId, type, point, extra = {}) {
  await command(tabId, 'Input.dispatchMouseEvent', {type, x: point.x, y: point.y, ...extra});
}

const KEY_MAP = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32, ' '],
};

export function parseKey(value) {
  if (typeof value !== 'string' || value.length > 80 || !value.length) throw new Error('key must be a key name or chord, for example Enter or Control+A.');
  const aliases = {Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight'};
  const parts = value === '+' ? ['+'] : value.split('+').map(item => aliases[item] || item);
  const key = parts.pop();
  let modifiers = 0;
  for (const modifier of parts) {
    const mask = {Alt: 1, Control: 2, Meta: 4, Shift: 8}[modifier];
    if (!mask) throw new Error(`Unsupported key modifier: ${modifier}.`);
    modifiers |= mask;
  }
  let code, virtualKey, text;
  if (KEY_MAP[key]) [code, virtualKey, text] = KEY_MAP[key];
  else if (/^[a-z]$/i.test(key)) { code = `Key${key.toUpperCase()}`; virtualKey = key.toUpperCase().charCodeAt(0); text = modifiers & 8 ? key.toUpperCase() : key; }
  else if (/^[0-9]$/.test(key)) { code = `Digit${key}`; virtualKey = key.charCodeAt(0); text = key; }
  else if (/^F([1-9]|1[0-2])$/.test(key)) { code = key; virtualKey = 111 + Number(key.slice(1)); }
  else if (key?.length === 1) { code = ''; virtualKey = 0; text = key; }
  else throw new Error(`Unsupported key: ${key}. Use type_text for text.`);
  if (modifiers & 7) text = undefined;
  return {key: key === 'Space' ? ' ' : key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers, ...(text ? {text, unmodifiedText: text} : {})};
}

async function pressKey(tabId, key) {
  const params = parseKey(key);
  await command(tabId, 'Input.dispatchKeyEvent', {type: params.text ? 'keyDown' : 'rawKeyDown', ...params});
  const {text, unmodifiedText, ...up} = params;
  await command(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', ...up});
}

async function runTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  if (name === 'wait') {
    const milliseconds = integer(args.milliseconds ?? 1000, 'milliseconds', 0, 10000);
    await sleep(milliseconds);
    return {waited: milliseconds};
  }
  installListeners();
  if (name === 'list_tabs') return {tabs: (await chrome.tabs.query({})).map(describeTab), selectedTabId};
  if (name === 'open_tab') {
    const tab = await chrome.tabs.create({url: validateUrl(args.url), active: true});
    selectedTabId = tab.id;
    return waitForLoad(tab.id);
  }
  const known = ['switch_tab', 'close_tab', 'navigate', 'go_back', 'read_page', 'get_page_text', 'find', 'screenshot', 'click', 'type_text', 'press_key', 'scroll', 'select_option', 'hover', 'drag', 'handle_dialog'];
  if (!known.includes(name)) throw new Error(`Unknown browser tool: ${name}.`);
  if (['switch_tab', 'close_tab'].includes(name) && args.tabId === undefined) throw new Error(`${name} requires an explicit tabId.`);
  const tab = await tabFor(args.tabId, {allowRestricted: ['switch_tab', 'close_tab', 'navigate'].includes(name)});
  const tabId = tab.id;
  if (name === 'switch_tab') {
    const switched = await chrome.tabs.update(tabId, {active: true});
    if (chrome.windows?.update && Number.isInteger(switched.windowId)) await chrome.windows.update(switched.windowId, {focused: true});
    return describeTab(switched);
  }
  if (name === 'close_tab') {
    await chrome.tabs.remove(tabId);
    attached.delete(tabId);
    if (selectedTabId === tabId) selectedTabId = undefined;
    return {closedTabId: tabId};
  }
  if (name === 'navigate') {
    await chrome.tabs.update(tabId, {url: validateUrl(args.url)});
    return waitForLoad(tabId);
  }
  await attach(tabId);
  if (name === 'handle_dialog') {
    const dialog = dialogs.get(tabId);
    if (!dialog) throw new Error('No JavaScript dialog is open on this tab.');
    if (typeof args.accept !== 'boolean') throw new Error('accept must be true or false.');
    if (args.promptText !== undefined && (typeof args.promptText !== 'string' || args.promptText.length > 2000)) throw new Error('promptText must be a string up to 2,000 characters.');
    await command(tabId, 'Page.handleJavaScriptDialog', {accept: args.accept, ...(args.promptText !== undefined && dialog.type === 'prompt' ? {promptText: args.promptText} : {})});
    dialogs.delete(tabId);
    return {tabId, action: name, dialogType: dialog.type, accepted: args.accept, note: 'Read the page to verify the result.'};
  }
  if (dialogs.has(tabId) && name !== 'screenshot') throw dialogError(dialogs.get(tabId));
  const result = await runAttached(tabId, name, args);
  const dialog = dialogs.get(tabId);
  return dialog ? {...result, dialog, note: `This action opened a JavaScript ${dialog.type} dialog. Decide with handle_dialog before continuing.`} : result;
}

async function runAttached(tabId, name, args) {
  if (name === 'go_back') {
    const history = await command(tabId, 'Page.getNavigationHistory');
    if (history.currentIndex <= 0) throw new Error('This tab has no previous page.');
    const entry = history.entries[history.currentIndex - 1];
    validateUrl(entry.url);
    await command(tabId, 'Page.navigateToHistoryEntry', {entryId: entry.id});
    return waitForLoad(tabId);
  }
  if (['read_page', 'get_page_text', 'find'].includes(name) && (await chrome.tabs.get(tabId)).status === 'loading') await waitForLoad(tabId, 8000);
  if (name === 'read_page') return {tabId, ...await page(tabId, 'snapshot')};
  if (name === 'get_page_text') {
    const offset = integer(args.offset ?? 0, 'offset', 0, 10000000);
    return {tabId, ...await page(tabId, 'text', {offset})};
  }
  if (name === 'find') {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw new Error('query must be a non-empty string up to 200 characters.');
    const limit = integer(args.limit ?? 20, 'limit', 1, 50);
    return {tabId, ...await page(tabId, 'find', {query: args.query, limit})};
  }
  if (name === 'screenshot') {
    const viewport = dialogs.has(tabId) ? undefined : await page(tabId, 'viewport');
    const result = await command(tabId, 'Page.captureScreenshot', {format: 'jpeg', quality: 75, captureBeyondViewport: false, fromSurface: true});
    return {tabId, image: {data: result.data, mimeType: 'image/jpeg'}, viewport, coordinateUnits: 'CSS pixels; divide image pixel coordinates by devicePixelRatio.'};
  }
  if (name === 'click' || name === 'hover') {
    const button = args.button ?? 'left';
    if (name === 'click' && !['left', 'middle', 'right'].includes(button)) throw new Error('button must be left, middle, or right.');
    const point = await targetPoint(tabId, args);
    await mouse(tabId, 'mouseMoved', point);
    if (name === 'click') {
      await mouse(tabId, 'mousePressed', point, {button, clickCount: 1});
      await mouse(tabId, 'mouseReleased', point, {button, clickCount: 1});
    }
    return {tabId, action: name, x: point.x, y: point.y, note: 'Read the page after this action to verify the result.'};
  }
  if (name === 'type_text') {
    if (typeof args.text !== 'string' || args.text.length > 20000) throw new Error('text must be a string up to 20,000 characters.');
    if (args.clear !== undefined && typeof args.clear !== 'boolean') throw new Error('clear must be true or false.');
    const focus = await page(tabId, 'focus', {elementId: args.elementId});
    if (focus.password) throw new Error('Password fields must be completed by the user. Ask the user to handle sign-in manually.');
    if (args.clear) {
      // CDP editing commands scope selection to the focused editor on all OSes.
      await command(tabId, 'Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll']});
      await command(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
      if (!args.text) await pressKey(tabId, 'Backspace');
    }
    if (args.text) await command(tabId, 'Input.insertText', {text: args.text});
    return {tabId, action: name, characters: args.text.length, cleared: !!args.clear};
  }
  if (name === 'press_key') {
    await pressKey(tabId, args.key);
    return {tabId, action: name, key: args.key};
  }
  if (name === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(args.direction)) throw new Error('direction must be up, down, left, or right.');
    const amount = integer(args.amount ?? 650, 'amount', 1, 5000);
    const viewport = await page(tabId, 'viewport');
    const horizontal = ['left', 'right'].includes(args.direction);
    const delta = ['up', 'left'].includes(args.direction) ? -amount : amount;
    await mouse(tabId, 'mouseWheel', {x: viewport.width / 2, y: viewport.height / 2}, {deltaX: horizontal ? delta : 0, deltaY: horizontal ? 0 : delta});
    return {tabId, action: name, direction: args.direction, amount};
  }
  if (name === 'select_option') {
    if (typeof args.elementId !== 'string' || typeof args.value !== 'string' || args.value.length > 2000) throw new Error('select_option requires elementId and string value.');
    return {tabId, action: name, ...await page(tabId, 'select', {elementId: args.elementId, value: args.value})};
  }
  if (name === 'drag') {
    const start = await targetPoint(tabId, {x: args.fromX, y: args.fromY});
    const end = await targetPoint(tabId, {x: args.toX, y: args.toY});
    await mouse(tabId, 'mouseMoved', start);
    await mouse(tabId, 'mousePressed', start, {button: 'left', clickCount: 1});
    try {
      for (let step = 1; step <= 12; step++) {
        await mouse(tabId, 'mouseMoved', {x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12}, {button: 'left', buttons: 1});
        await sleep(16);
      }
    } finally { await mouse(tabId, 'mouseReleased', end, {button: 'left', clickCount: 1}); }
    return {tabId, action: name, note: 'Read the page to verify the drag; native HTML drag-and-drop support varies by site.'};
  }
}

/** Hostname an action will affect, used for site-scoped approvals. Empty when unknown. */
export async function actionHost(name, args = {}) {
  if (['open_tab', 'navigate'].includes(name)) return new URL(validateUrl(args.url)).hostname;
  const tab = await tabFor(args.tabId, {allowRestricted: true});
  try { return new URL(validateUrl(tab.url || tab.pendingUrl || '')).hostname; } catch { return ''; }
}

// Serialize actions so a second panel message cannot move focus mid-keystroke.
export function executeTool(name, args = {}, {siteGuard} = {}) {
  const result = queue.then(async () => {
    // A site-scoped approval only holds while the target is still on that site.
    if (siteGuard !== undefined && await actionHost(name, args) !== siteGuard) {
      throw new Error(`The target is no longer on ${siteGuard}, so this action needs a fresh approval. Observe the page again.`);
    }
    return runTool(name, args);
  });
  queue = result.catch(() => {});
  return result;
}

export async function detachAll() {
  const tabs = [...attached];
  attached.clear();
  const results = await Promise.allSettled(tabs.map(tabId => chrome.debugger.detach({tabId})));
  return {detached: tabs.length, failures: results.filter(result => result.status === 'rejected').length};
}
