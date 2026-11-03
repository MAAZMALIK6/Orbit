import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {pageOperation} from '../extension/browser/dom.js';
import {validateUrl, parseKey} from '../extension/browser/driver.js';

function fakeChrome({tabs: initialTabs, evaluate, onCommand} = {}) {
  const commands = [], attached = [], detached = [], mutations = [], eventListeners = [];
  const emit = (tabId, method, params) => eventListeners.forEach(fn => fn({tabId}, method, params));
  const tabs = new Map((initialTabs || [{id: 7, url: 'https://example.com/', title: 'Example', active: true, windowId: 1, status: 'complete'}]).map(tab => [tab.id, {...tab}]));
  const removedListeners = [];
  globalThis.chrome = {
    tabs: {
      onRemoved: {addListener(fn) { removedListeners.push(fn); }},
      async get(id) { if (!tabs.has(id)) throw new Error('No such tab'); return {...tabs.get(id)}; },
      async query(query) { return [...tabs.values()].filter(tab => !query.active || tab.active).map(tab => ({...tab})); },
      async create(args) { const tab = {id: 100, status: 'complete', title: '', windowId: 1, ...args}; tabs.set(tab.id, tab); mutations.push(['create', args]); return tab; },
      async update(id, changes) { mutations.push(['update', id, changes]); Object.assign(tabs.get(id), changes); return {...tabs.get(id)}; },
      async remove(id) { mutations.push(['remove', id]); tabs.delete(id); removedListeners.forEach(fn => fn(id)); },
    },
    debugger: {
      onDetach: {addListener() {}},
      onEvent: {addListener(fn) { eventListeners.push(fn); }},
      async attach(target) { attached.push(target); },
      async detach(target) { detached.push(target); },
      async sendCommand(target, method, args) {
        commands.push({target, method, args});
        if (onCommand) { const handled = await onCommand(target, method, args, emit); if (handled !== undefined) return handled; }
        if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'main-frame'}}};
        if (method === 'Page.createIsolatedWorld') return {executionContextId: 42};
        if (method === 'Runtime.evaluate') {
          if (evaluate) return evaluate(args);
          return {result: {type: 'object', value: {width: 1200, height: 900, devicePixelRatio: 2, x: 80, y: 50, editable: true, text: 'Page text', elements: []}}};
        }
        if (method === 'Page.captureScreenshot') return {data: 'encoded-image'};
        if (method === 'Page.getNavigationHistory') return {currentIndex: 1, entries: [{id: 4, url: 'chrome://newtab/'}, {id: 5, url: 'https://example.com/'}]};
        return {};
      },
    },
  };
  return {commands, attached, detached, mutations, tabs, emit};
}

let moduleId = 0;
async function freshDriver() { return import(`../extension/browser/driver.js?test=${moduleId++}`); }

test('URLs reject executable schemes and credentials without leaking them in errors', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', 'chrome-extension://abc/page', 'https://user:secret@example.com/']) {
    assert.throws(() => validateUrl(url), error => !error.message.includes('secret'));
  }
  assert.equal(validateUrl('http://localhost:8080'), 'http://localhost:8080/');
});

test('key chords retain modifiers and use valid virtual key codes', () => {
  assert.deepEqual(parseKey('Ctrl+A'), {key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2});
  assert.equal(parseKey('Enter').text, '\r');
  assert.equal(parseKey('Shift+Tab').modifiers, 8);
  assert.throws(() => parseKey('Hyper+Delete'), /Unsupported key modifier/);
  assert.throws(() => parseKey('ExecuteScript'), /Unsupported key/);
});

test('page reads execute fixed code in an isolated world', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  const result = await driver.executeTool('read_page', {tabId: 7});
  assert.equal(result.tabId, 7);
  assert.equal(result.text, 'Page text');
  assert.equal(mock.attached.length, 1);
  const world = mock.commands.find(item => item.method === 'Page.createIsolatedWorld');
  assert.equal(world.args.worldName, 'orbit-browser-agent-v1');
  const evaluation = mock.commands.find(item => item.method === 'Runtime.evaluate');
  assert.equal(evaluation.args.contextId, 42);
  assert.match(evaluation.args.expression, /pageOperation/);
  assert.equal(evaluation.args.returnByValue, true);
  await assert.rejects(driver.executeTool('evaluate', {script: 'alert(1)'}), /Unknown browser tool/);
});

test('click uses trusted CDP mouse events in order', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  await driver.executeTool('click', {tabId: 7, x: 100, y: 200});
  const events = mock.commands.filter(item => item.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(events.map(item => item.args.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(events[1].args.x, 100);
  assert.equal(events[1].args.button, 'left');
  await assert.rejects(driver.executeTool('click', {tabId: 7, x: 1200, y: 20}), /outside the viewport/);
  assert.equal(mock.commands.filter(item => item.method === 'Input.dispatchMouseEvent').length, 3);
});

test('stale element reports an error without dispatching input', async () => {
  const mock = fakeChrome({evaluate: () => ({exceptionDetails: {exception: {description: 'Error: STALE_ELEMENT: Read the page again.\n stack'}}})});
  const driver = await freshDriver();
  await assert.rejects(driver.executeTool('click', {tabId: 7, elementId: 'old-id'}), /STALE_ELEMENT/);
  assert.equal(mock.commands.filter(item => item.method.startsWith('Input.')).length, 0);
});

test('password field typing is rejected before sending text or clearing input', async () => {
  const mock = fakeChrome({evaluate: () => ({result: {type: 'object', value: {editable: true, password: true}}})});
  const driver = await freshDriver();
  await assert.rejects(driver.executeTool('type_text', {tabId: 7, elementId: 'password', text: 'secret', clear: true}), /completed by the user/);
  assert.equal(mock.commands.filter(item => item.method.startsWith('Input.')).length, 0);
});

test('typing focuses first and uses trusted insertion; clear with empty string deletes selection', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  const text = 'text "); globalThis.pwned=true; //';
  const result = await driver.executeTool('type_text', {tabId: 7, elementId: 'e1', text, clear: true});
  const input = mock.commands.filter(item => item.method.startsWith('Input.'));
  assert.deepEqual(input.map(item => item.method), ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
  assert.deepEqual(input[0].args.commands, ['selectAll']);
  assert.equal(input[2].args.text, text);
  assert.equal(result.characters, text.length);
  assert.ok(!mock.commands.find(item => item.method === 'Runtime.evaluate').args.expression.includes(text));
  await driver.executeTool('type_text', {tabId: 7, elementId: 'e1', text: '', clear: true});
  assert.ok(mock.commands.some(item => item.method === 'Input.dispatchKeyEvent' && item.args.key === 'Backspace'));
});

test('restricted tabs are not inspected, URL creation is validated, and back will not enter Chrome pages', async () => {
  const mock = fakeChrome({tabs: [{id: 7, url: 'chrome://settings/', active: true, status: 'complete'}]});
  const driver = await freshDriver();
  await assert.rejects(driver.executeTool('read_page', {tabId: 7}), /Only HTTP/);
  await assert.rejects(driver.executeTool('open_tab', {url: 'https://user:secret@example.com'}), /credentials/);
  assert.equal(mock.attached.length, 0);
  assert.equal(mock.mutations.length, 0);
  await driver.executeTool('navigate', {tabId: 7, url: 'https://example.com'});
  await assert.rejects(driver.executeTool('go_back', {tabId: 7}), /Only HTTP/);
  assert.ok(!mock.commands.some(item => item.method === 'Page.navigateToHistoryEntry'));
});

test('explicit tab remains selected even when another tab becomes active', async () => {
  const mock = fakeChrome({tabs: [{id: 7, url: 'https://example.com', active: true}, {id: 8, url: 'https://other.example', active: false}]});
  const driver = await freshDriver();
  await driver.executeTool('read_page', {tabId: 8});
  await driver.executeTool('press_key', {key: 'Enter'});
  const input = mock.commands.find(item => item.method === 'Input.dispatchKeyEvent');
  assert.equal(input.target.tabId, 8);
  await assert.rejects(driver.executeTool('close_tab', {}), /explicit tabId/);
  await driver.detachAll();
  assert.deepEqual(mock.detached, [{tabId: 8}]);
});

test('tab listing removes embedded URL credentials and marks protected pages', async () => {
  fakeChrome({tabs: [{id: 7, url: 'https://user:secret@example.com/', active: true}, {id: 8, url: 'chrome://settings/'}]});
  const driver = await freshDriver();
  const result = await driver.executeTool('list_tabs', {});
  assert.equal(result.tabs[0].url, 'https://example.com/');
  assert.equal(result.tabs[0].controllable, false);
  assert.equal(result.tabs[1].controllable, false);
});

test('screenshot reports CSS coordinate conversion and bounded wait/scroll arguments', async () => {
  fakeChrome();
  const driver = await freshDriver();
  const shot = await driver.executeTool('screenshot', {tabId: 7});
  assert.equal(shot.image.mimeType, 'image/jpeg');
  assert.equal(shot.viewport.devicePixelRatio, 2);
  await assert.rejects(driver.executeTool('wait', {milliseconds: 10001}), /between 0 and 10000/);
  await assert.rejects(driver.executeTool('scroll', {amount: -100, direction: 'down'}), /between 1 and 5000/);
});

test('DOM IDs stay stable until an element is removed and password values are redacted', () => {
  const doc = {title: 'Fixture', getElementById() { return null; }, defaultView: {getComputedStyle() { return {display: 'block', visibility: 'visible', opacity: '1'}; }, innerWidth: 1000, innerHeight: 800}};
  function element(tagName, props = {}) {
    return {nodeType: 1, tagName, childNodes: [], ownerDocument: doc, isConnected: true, labels: [],
      getAttribute(name) { return name === 'placeholder' ? this.placeholder : null; },
      getRootNode() { return doc; },
      getBoundingClientRect() { return {x: 10, y: 10, left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30}; },
      matches() { return tagName === 'INPUT' || tagName === 'BUTTON'; },
      scrollIntoView() {}, contains(other) { return this === other; }, ...props};
  }
  const password = element('INPUT', {type: 'password', value: 'never-expose-this', placeholder: 'Password'});
  const button = element('BUTTON', {innerText: 'Continue'});
  doc.body = element('BODY', {childNodes: [password, button]});
  doc.elementFromPoint = () => button;
  const context = vm.createContext({document: doc, crypto: {randomUUID: () => '12345678-abcd-efgh'}, location: {href: 'https://example.com/'}, URL, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0});
  const invoke = (operation, args = {}) => vm.runInContext(`(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`, context);
  const first = invoke('snapshot');
  assert.equal(first.elements[0].value, '[redacted]');
  assert.ok(!JSON.stringify(first).includes('never-expose-this'));
  const second = invoke('snapshot');
  assert.equal(first.elements[1].elementId, second.elements[1].elementId);
  const id = first.elements[1].elementId;
  assert.equal(invoke('point', {elementId: id}).x, 55);
  button.isConnected = false;
  assert.throws(() => invoke('point', {elementId: id}), /STALE_ELEMENT/);
});

test('a click that opens a JavaScript dialog returns promptly and blocks other actions until handled', async () => {
  const mock = fakeChrome({onCommand: (target, method, args, emit) => {
    // Chrome does not answer the input command while the dialog is open.
    if (method === 'Input.dispatchMouseEvent' && args.type === 'mouseReleased') {
      emit(target.tabId, 'Page.javascriptDialogOpening', {type: 'confirm', message: 'Delete this draft?', url: 'https://example.com/'});
      return new Promise(() => {});
    }
  }});
  const driver = await freshDriver();
  const clicked = await driver.executeTool('click', {tabId: 7, x: 10, y: 10});
  assert.equal(clicked.dialog.type, 'confirm');
  assert.match(clicked.note, /handle_dialog/);
  const evaluations = mock.commands.filter(item => item.method === 'Runtime.evaluate').length;
  await assert.rejects(driver.executeTool('read_page', {tabId: 7}), /confirm dialog is open.*Delete this draft/);
  await assert.rejects(driver.executeTool('press_key', {tabId: 7, key: 'Enter'}), /handle_dialog/);
  assert.equal(mock.commands.filter(item => item.method === 'Runtime.evaluate').length, evaluations);
  const handled = await driver.executeTool('handle_dialog', {tabId: 7, accept: false});
  assert.equal(handled.accepted, false);
  assert.deepEqual(mock.commands.find(item => item.method === 'Page.handleJavaScriptDialog').args, {accept: false});
  await assert.rejects(driver.executeTool('handle_dialog', {tabId: 7, accept: true}), /No JavaScript dialog/);
  assert.equal((await driver.executeTool('read_page', {tabId: 7})).text, 'Page text');
});

test('dialogs closed by the page itself stop blocking actions', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  await driver.executeTool('read_page', {tabId: 7});
  mock.emit(7, 'Page.javascriptDialogOpening', {type: 'alert', message: 'Hi'});
  await assert.rejects(driver.executeTool('read_page', {tabId: 7}), /alert dialog/);
  mock.emit(7, 'Page.javascriptDialogClosed', {result: true});
  assert.equal((await driver.executeTool('read_page', {tabId: 7})).tabId, 7);
});

test('full page text and find use fixed DOM operations with validated arguments', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  await driver.executeTool('get_page_text', {tabId: 7, offset: 25000});
  await driver.executeTool('find', {tabId: 7, query: 'Save draft', limit: 5});
  const expressions = mock.commands.filter(item => item.method === 'Runtime.evaluate').map(item => item.args.expression);
  assert.ok(expressions[0].endsWith('("text",{"offset":25000})'));
  assert.ok(expressions[1].endsWith('("find",{"query":"Save draft","limit":5})'));
  await assert.rejects(driver.executeTool('find', {tabId: 7, query: '  '}), /non-empty/);
  await assert.rejects(driver.executeTool('get_page_text', {tabId: 7, offset: -1}), /offset/);
});

test('site-scoped approvals only dispatch while the target is still on the approved host', async () => {
  const mock = fakeChrome();
  const driver = await freshDriver();
  assert.equal(await driver.actionHost('click', {tabId: 7}), 'example.com');
  assert.equal(await driver.actionHost('navigate', {tabId: 7, url: 'https://other.example/path'}), 'other.example');
  await assert.rejects(driver.executeTool('click', {tabId: 7, x: 5, y: 5}, {siteGuard: 'other.example'}), /fresh approval/);
  assert.equal(mock.commands.filter(item => item.method.startsWith('Input.')).length, 0);
  await driver.executeTool('click', {tabId: 7, x: 5, y: 5}, {siteGuard: 'example.com'});
  assert.equal(mock.commands.filter(item => item.method.startsWith('Input.')).length, 3);
  await assert.rejects(driver.executeTool('navigate', {tabId: 7, url: 'https://evil.example/'}, {siteGuard: 'example.com'}), /fresh approval/);
  assert.ok(!mock.mutations.some(item => item[0] === 'update'));
});

function fakeDocument() {
  const doc = {title: 'Search fixture', getElementById() { return null; }, defaultView: {getComputedStyle() { return {display: 'block', visibility: 'visible', opacity: '1'}; }, innerWidth: 1000, innerHeight: 800}};
  const selectorTags = ['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'];
  function element(tagName, props = {}, children = []) {
    return {nodeType: 1, tagName, childNodes: children, children, ownerDocument: doc, isConnected: true, labels: [], attributes: {},
      getAttribute(name) { return this.attributes[name] ?? null; },
      getRootNode() { return doc; },
      getBoundingClientRect() { return this.rect || {x: 10, y: 10, left: 10, top: 10, right: 100, bottom: 40, width: 90, height: 30}; },
      matches() { return selectorTags.includes(tagName) || 'role' in this.attributes; },
      querySelectorAll() { return children.flatMap(child => [child, ...child.querySelectorAll()]); },
      checkVisibility() { return this.visible !== false; },
      scrollIntoView() {}, contains(other) { return this === other; }, ...props};
  }
  return {doc, element};
}

function runInPage(doc, operation, args = {}) {
  const context = vm.createContext({document: doc, crypto: {randomUUID: () => '12345678-abcd-efgh'}, location: {href: 'https://example.com/'}, URL, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0});
  return vm.runInContext(`(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`, context);
}

test('find searches off-screen controls, skips hidden and container elements, and ranks label matches first', () => {
  const {doc, element} = fakeDocument();
  const offscreen = {x: 10, y: 3000, left: 10, top: 3000, right: 100, bottom: 3030, width: 90, height: 30};
  const guide = element('A', {innerText: 'Read more', href: 'https://example.com/connect-guide', attributes: {href: '/connect-guide'}});
  const connect = element('BUTTON', {innerText: 'Connect with Ada', rect: offscreen});
  const hidden = element('BUTTON', {innerText: 'Connect hidden', visible: false});
  const region = element('DIV', {innerText: 'Connect with everyone', attributes: {role: 'main'}}, [guide, connect, hidden]);
  doc.body = element('BODY', {}, [region]);
  doc.querySelectorAll = () => doc.body.querySelectorAll();
  const result = runInPage(doc, 'find', {query: 'connect', limit: 10});
  assert.equal(result.total, 2);
  assert.equal(result.matches[0].label, 'Connect with Ada');
  assert.equal(result.matches[0].inViewport, false);
  assert.equal(result.matches[1].url, 'https://example.com/connect-guide');
  assert.throws(() => runInPage(doc, 'find', {query: ' '}), /non-empty query/);
});

test('page text covers the whole document in bounded chunks', () => {
  const {doc, element} = fakeDocument();
  doc.body = element('BODY', {innerText: `Intro   paragraph\n\n\n\n${'x'.repeat(30000)}`});
  doc.querySelectorAll = () => [];
  const first = runInPage(doc, 'text');
  assert.ok(first.text.startsWith('Intro paragraph\n\nx'));
  assert.equal(first.text.length, 25000);
  assert.equal(first.nextOffset, 25000);
  const second = runInPage(doc, 'text', {offset: first.nextOffset});
  assert.equal(second.offset + second.text.length, second.totalLength);
  assert.equal(second.nextOffset, undefined);
});
