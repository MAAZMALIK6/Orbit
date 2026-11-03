// Optional real-browser integration check: node tests/browser-smoke.mjs
// Requires Node 22+ and Chromium/Chrome for Testing; no npm dependencies.
// Override executable with ORBIT_CHROMIUM. Uses a private temporary profile,
// an ephemeral loopback fixture server, and the actual extension worker RPC.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchExtension, sleep} from './lib/extension-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'tests', 'artifacts');
await mkdir(artifacts, {recursive: true});

const fixture = `<!doctype html><meta charset="utf-8"><title>Orbit browser fixture</title>
<style>body{font:18px system-ui;padding:24px}input,button,select{font:inherit;margin:8px;padding:8px}iframe{width:480px;height:90px;border:1px solid #ccc}#spacer{height:1100px}</style>
<h1>Browser fixture</h1><label>Project name <input id="name" placeholder="Project name"></label>
<label>Password <input type="password" value="fixture-password-must-not-leak" placeholder="Password"></label>
<label>Priority <select id="priority"><option value="normal">Normal</option><option value="high">High</option></select></label>
<button id="save">Save project</button><p id="result">Nothing saved</p><div id="shadow"></div>
<iframe title="Same origin frame" src="/frame"></iframe>
<div id="spacer"></div><p id="bottom">Bottom marker</p><button id="delete">Delete project</button><p id="deleted">Not deleted</p>
<script>
document.querySelector('#delete').onclick=()=>{document.querySelector('#deleted').textContent=confirm('Delete this project?')?'Project deleted':'Delete cancelled';};
document.querySelector('#save').onclick=()=>{document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value+' at '+document.querySelector('#priority').value;};
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow action</button><span> Shadow ready</span>';
shadow.querySelector('button').onclick=()=>{shadow.querySelector('span').textContent=' Shadow clicked';};
</script>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/frame') response.end('<!doctype html><button onclick="this.textContent=\'Frame clicked\'">Frame action</button>');
  else if (request.url === '/next') response.end('<!doctype html><title>Next page</title><h1>Navigation successful</h1>');
  else response.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let session, cdp, panelSession;
const report = {checks: [], startedAt: new Date().toISOString()};
const check = description => { report.checks.push(description); console.log(`PASS ${description}`); };

try {
  session = await launchExtension({root, artifacts});
  ({cdp, panelSession} = session);
  report.browser = session.browserPath;
  report.version = session.version;
  check('Extension service worker and panel load');

  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 850, deviceScaleFactor: 1, mobile: false}, panelSession);
  await sleep(250);
  const panelShot = await cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}, panelSession);
  await writeFile(path.join(artifacts, 'panel-smoke.png'), Buffer.from(panelShot.data, 'base64'));
  report.panelScreenshot = 'tests/artifacts/panel-smoke.png';

  const owner = 'orbit-real-browser-smoke';
  const rpc = async message => {
    const response = await cdp.evaluate(panelSession, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
    if (!response?.ok) throw new Error(response?.error || 'No response from extension worker');
    return response.data;
  };
  const tool = (name, args = {}) => rpc({type: 'browser', owner, name, args});
  await rpc({type: 'lease', mode: 'acquire', owner});
  const opened = await tool('open_tab', {url});
  const tabId = opened.tabId;
  assert.ok(tabId);
  let page = await tool('read_page', {tabId});
  assert.match(page.text, /Browser fixture/);
  assert.ok(!JSON.stringify(page).includes('fixture-password-must-not-leak'));
  const name = page.elements.find(element => element.label === 'Project name');
  const priority = page.elements.find(element => element.tag === 'select');
  const save = page.elements.find(element => element.label === 'Save project');
  assert.ok(name && priority && save, 'Expected form controls with stable IDs');
  check('Open/read page discovers controls and redacts password values');

  const again = await tool('read_page', {tabId});
  assert.equal(again.elements.find(element => element.label === 'Save project').elementId, save.elementId);
  await tool('type_text', {tabId, elementId: name.elementId, text: 'Orbit smoke', clear: true});
  await tool('select_option', {tabId, elementId: priority.elementId, value: 'high'});
  await tool('click', {tabId, elementId: save.elementId});
  page = await tool('read_page', {tabId});
  assert.match(page.text, /Saved Orbit smoke at high/);
  check('Stable IDs, trusted typing/clicking, native select and form verification');

  const shadow = page.elements.find(element => element.label === 'Shadow action');
  const frame = page.elements.find(element => element.label === 'Frame action');
  assert.ok(shadow && frame, 'Expected shadow and frame controls');
  await tool('click', {tabId, elementId: shadow.elementId});
  await tool('click', {tabId, elementId: frame.elementId});
  page = await tool('read_page', {tabId});
  assert.match(page.text, /Shadow clicked/);
  assert.match(page.text, /Frame clicked/);
  check('Open shadow roots and same-origin iframe interaction');

  const fullText = await tool('get_page_text', {tabId});
  assert.match(fullText.text, /Bottom marker/);
  assert.match(fullText.text, /Shadow clicked/);
  assert.match(fullText.text, /Frame clicked/);
  const found = await tool('find', {tabId, query: 'delete project'});
  const remove = found.matches.find(element => element.label === 'Delete project');
  assert.ok(remove && remove.inViewport === false, 'Expected an off-screen delete button');
  assert.equal(await rpc({type: 'actionHost', name: 'click', args: {tabId, elementId: remove.elementId}}), '127.0.0.1');
  const clicked = await tool('click', {tabId, elementId: remove.elementId});
  assert.equal(clicked.dialog?.type, 'confirm');
  assert.match(clicked.dialog.message, /Delete this project/);
  await assert.rejects(tool('read_page', {tabId}), /handle_dialog/);
  await tool('handle_dialog', {tabId, accept: true});
  page = await tool('read_page', {tabId});
  assert.match(page.text, /Project deleted/);
  check('Full-page text, off-screen find, and JavaScript confirm dialogs');

  const screenshot = await tool('screenshot', {tabId});
  assert.equal(screenshot.image.mimeType, 'image/jpeg');
  assert.ok(screenshot.image.data.length > 1000);
  await tool('scroll', {tabId, direction: 'down', amount: 1200});
  await tool('wait', {milliseconds: 300});
  page = await tool('read_page', {tabId});
  assert.match(page.text, /Bottom marker/);
  check('Real screenshot and trusted scrolling');

  await tool('navigate', {tabId, url: `${url}next`});
  page = await tool('read_page', {tabId});
  assert.match(page.text, /Navigation successful/);
  await assert.rejects(tool('click', {tabId, elementId: save.elementId}), /STALE_ELEMENT/);
  await tool('go_back', {tabId});
  page = await tool('read_page', {tabId});
  assert.equal(page.title, 'Orbit browser fixture');
  check('Navigation, back history, and stale IDs across documents');

  const listed = await tool('list_tabs');
  assert.ok(listed.tabs.some(tab => tab.tabId === tabId));
  await tool('switch_tab', {tabId});
  await tool('close_tab', {tabId});
  await rpc({type: 'lease', mode: 'release', owner});
  check('Tab list/switch/close and debugger release');

  const reloadPanel = async (stored, marker) => {
    await cdp.evaluate(panelSession, `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(stored)})).then(() => { setTimeout(() => location.reload(), 0); return true; })`);
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(100);
      if (await cdp.evaluate(panelSession, marker).catch(() => false)) return;
    }
    throw new Error(`Panel did not render after reload: ${marker}`);
  };
  const shortcut = {id: 'smoke-shortcut', title: 'Weekly pricing check', prompt: 'Compare the plans on this page and report the cheapest.', createdAt: new Date().toISOString()};
  await reloadPanel({shortcuts: [shortcut], session: {
    id: 'smoke-run', status: 'paused', task: shortcut.prompt, turn: 3, maxTurns: 40, messages: [], pendingCalls: [],
    events: [{id: 'e1', kind: 'user', text: shortcut.prompt, at: new Date().toISOString()}, {id: 'e2', kind: 'system', text: 'Page actions on 127.0.0.1 are allowed for the rest of this task.', at: new Date().toISOString()}],
    plan: [{step: 'Read the plans', status: 'done'}, {step: 'Compare prices', status: 'in_progress'}],
    usage: {inputTokens: 12000, outputTokens: 345}, allowedSites: ['127.0.0.1'],
  }}, `!document.getElementById('run').hidden && document.getElementById('shortcut-list').children.length === 1`);
  const runView = await cdp.evaluate(panelSession, `({tokens: document.getElementById('token-count').textContent, tokensHidden: document.getElementById('token-count').hidden, saveDisabled: document.getElementById('save-shortcut-button').disabled})`);
  assert.deepEqual(runView, {tokens: '12.3k tokens', tokensHidden: false, saveDisabled: false});
  await writeFile(path.join(artifacts, 'panel-run-smoke.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'}, panelSession)).data, 'base64'));
  await reloadPanel({shortcuts: [shortcut]}, `!document.getElementById('shortcuts').hidden && document.getElementById('welcome').hidden === false`);
  assert.match(await cdp.evaluate(panelSession, `document.getElementById('shortcut-list').textContent`), /Weekly pricing check/);
  await writeFile(path.join(artifacts, 'panel-shortcuts-smoke.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'}, panelSession)).data, 'base64'));
  check('Panel restores token usage and lists saved shortcuts');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || error.message;
  report.browserStderr = session?.stderr() || error.stderr;
  report.browserExitCode = session?.exitCode();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifacts, 'browser-smoke.json'), JSON.stringify(report, null, 2));
  await session?.close();
  await new Promise(resolve => server.close(resolve));
}
