// Opens a dedicated Chromium window with Orbit loaded, in a persistent profile outside the repo.
// On first run (or with --configure) it saves NVIDIA settings through the panel's own saveSettings,
// in a short headless pass with remote debugging. The visible browser starts without remote debugging.
//
//   NVIDIA_API_KEY=... node scripts/orbit-browser.mjs [--configure] [--model <id>] [--auto]
import {spawn} from 'node:child_process';
import {access, readFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CDP, executable, sleep} from '../tests/lib/extension-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const profile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Orbit', 'browser-profile');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const exists = file => access(file).then(() => true, () => false);

const settings = {
  provider: 'compatible', baseUrl: 'https://integrate.api.nvidia.com/v1',
  model: option('model') || 'mistralai/mistral-large-4-1t-a52b',
  apiKey: process.env.NVIDIA_API_KEY || '', rememberKey: true,
  toolMode: 'native', vision: false, compact: false, contextTokens: 64000,
  permissionMode: args.includes('--auto') ? 'auto' : 'ask',
};

async function configure(browserPath) {
  if (!settings.apiKey) throw new Error('NVIDIA_API_KEY is not set.');
  const browser = spawn(browserPath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--load-extension=${extension}`, 'about:blank',
  ], {windowsHide: true, stdio: 'ignore'});
  let cdp;
  try {
    let devTools;
    for (let attempt = 0; attempt < 100 && !devTools; attempt++) {
      if (browser.exitCode !== null) throw new Error('Chromium exited early. Close any Orbit browser window that is still open and try again.');
      devTools = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => sleep(100));
    }
    if (!devTools) throw new Error('Chromium debugging did not start.');
    const [port, endpoint] = devTools.trim().split(/\r?\n/);
    cdp = await CDP.connect(`ws://127.0.0.1:${port}${endpoint}`);
    let worker;
    for (let attempt = 0; attempt < 50 && !worker; attempt++) {
      const {targetInfos} = await cdp.send('Target.getTargets');
      worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/background.js'));
      if (!worker) await sleep(100);
    }
    if (!worker) throw new Error('Orbit did not load. Branded Chrome ignores --load-extension; install Playwright Chromium or set ORBIT_CHROMIUM.');
    const {targetId} = await cdp.send('Target.createTarget', {url: worker.url.replace(/background\.js$/, 'panel/panel.html')});
    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await cdp.evaluate(sessionId, 'document.readyState').catch(() => '') === 'complete') break;
      await sleep(100);
    }
    const saved = await cdp.evaluate(sessionId, `(async () => {
      const {saveSettings} = await import('/core/storage.js');
      const value = await saveSettings(${JSON.stringify(settings)});
      return {model: value.model, permissionMode: value.permissionMode, hasKey: !!value.apiKey};
    })()`);
    await cdp.send('Browser.close').catch(() => {});
    return saved;
  } finally {
    cdp?.socket.close();
    for (let attempt = 0; attempt < 50 && browser.exitCode === null; attempt++) await sleep(100);
    if (browser.exitCode === null) browser.kill();
  }
}

const browserPath = await executable();
const firstRun = !await exists(profile);
await mkdir(profile, {recursive: true});
if (firstRun || args.includes('--configure')) {
  const saved = await configure(browserPath);
  console.log(`Configured Orbit: NVIDIA, ${saved.model}, ${saved.permissionMode} mode, key ${saved.hasKey ? 'saved' : 'missing'}.`);
}
spawn(browserPath, [
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--load-extension=${extension}`,
], {detached: true, stdio: 'ignore'}).unref();
console.log(`Orbit browser opened. Profile: ${profile}`);
