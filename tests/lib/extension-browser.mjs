// Launches Chromium with the unpacked extension in a throwaway profile and exposes the
// panel's worker RPC. Shared by the smoke test and the live model evaluation.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, access, rm} from 'node:fs/promises';
import path from 'node:path';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function executable() {
  const candidates = [process.env.ORBIT_CHROMIUM];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    for (const name of (await readdir(cache).catch(() => [])).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(path.join(cache, name, 'chrome-win64', 'chrome.exe'), path.join(cache, name, 'chrome-win', 'chrome.exe'));
    }
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('Chromium not found. Set ORBIT_CHROMIUM to a Chrome for Testing or Chromium executable.');
}

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser CDP connection closed.')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    if (typeof WebSocket === 'undefined') throw new Error('Node 22+ is required for real-browser checks.');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true}); });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP socket is closed: ${method}`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async evaluate(session, expression, timeout) {
    const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, session, timeout);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
}

/** Starts headless Chromium with the extension and opens its panel page in a tab. */
export async function launchExtension({root, artifacts}) {
  const profile = await mkdtemp(path.join(artifacts, '.chromium-profile-'));
  let browser, cdp, browserError = '';
  const close = async () => {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.socket.close(); }
    if (browser && browser.exitCode === null) {
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(3000)]);
      if (browser.exitCode === null) browser.kill();
    }
    // Only remove the unique profile created here inside the artifact dir.
    const absoluteProfile = path.resolve(profile);
    if (path.dirname(absoluteProfile) !== path.resolve(artifacts) || !path.basename(absoluteProfile).startsWith('.chromium-profile-')) throw new Error('Refusing cleanup outside the profile directory.');
    await rm(absoluteProfile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(error => console.warn(`Temporary profile cleanup: ${error.message}`));
  };
  const session = {close, stderr: () => browserError, exitCode: () => browser?.exitCode};
  try {
    session.browserPath = await executable();
    browser = spawn(session.browserPath, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      // Sandboxed CI shells cannot create Chromium's Windows child sandbox.
      // This browser only opens loopback fixtures and our packaged extension.
      '--no-sandbox', '--disable-software-rasterizer',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,1000',
      `--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`,
      'about:blank',
    ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    browser.stderr.on('data', chunk => { browserError = (browserError + chunk.toString()).slice(-4000); });
    let devTools;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (browser.exitCode !== null) throw new Error(`Chromium exited early: ${browserError}`);
      try { devTools = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); break; } catch { await sleep(100); }
    }
    if (!devTools) throw new Error(`Chromium debugging did not start: ${browserError}`);
    const [port, endpoint] = devTools.trim().split(/\r?\n/);
    cdp = session.cdp = await CDP.connect(`ws://127.0.0.1:${port}${endpoint}`);
    session.version = await cdp.send('Browser.getVersion');
    let worker;
    for (let attempt = 0; attempt < 50; attempt++) {
      const {targetInfos} = await cdp.send('Target.getTargets');
      worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/background.js'));
      if (worker) break;
      await sleep(100);
    }
    if (!worker) throw new Error('Extension worker did not load. Use Chrome for Testing/Chromium; branded Chrome may restrict --load-extension.');
    const panelUrl = worker.url.replace(/background\.js$/, 'panel/panel.html');
    const {targetId} = await cdp.send('Target.createTarget', {url: panelUrl});
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
    session.panelSession = sessionId;
    await cdp.send('Runtime.enable', {}, sessionId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const ready = await cdp.evaluate(sessionId, 'document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
    await sleep(350);
    // The same message channel the panel's agent uses to reach the worker.
    session.rpc = async (message, timeout = 60000) => {
      const response = await cdp.evaluate(sessionId, `chrome.runtime.sendMessage(${JSON.stringify(message)})`, timeout);
      if (!response?.ok) throw new Error(response?.error || 'No response from extension worker');
      return response.data;
    };
    return session;
  } catch (error) {
    error.stderr = browserError;
    await close().catch(() => {});
    throw error;
  }
}
