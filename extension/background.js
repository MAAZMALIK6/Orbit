import { executeTool, detachAll, actionHost } from './browser/driver.js';
import { restrictStorage } from './core/storage.js';
import { validateToolCall } from './core/tools.js';

const PANEL = chrome.runtime.getURL('panel/panel.html');
let lockQueue = Promise.resolve();
let operation = Promise.resolve();
const trusted = sender => sender.id === chrome.runtime.id && sender.url?.split('?')[0] === PANEL;
const lock = fn => {
  const next = lockQueue.catch(() => {}).then(fn);
  lockQueue = next;
  return next;
};

async function lease(owner, mode) {
  return lock(async () => {
    const { runner } = await chrome.storage.session.get('runner');
    const occupied = runner && runner.expires > Date.now() && runner.owner !== owner;
    if (mode === 'acquire' && occupied) throw new Error('Orbit is running in another panel. Stop that run first.');
    if (mode === 'check' && (!runner || runner.owner !== owner || runner.expires <= Date.now())) throw new Error('Runner connection expired. Resume the task to reconnect.');
    if (mode === 'release') {
      if (runner?.owner === owner) {
        await chrome.storage.session.remove('runner');
        await detachAll();
      }
      return true;
    }
    await chrome.storage.session.set({ runner: { owner, expires: Date.now() + 45000 } });
    return true;
  });
}

async function handle(message) {
  if (!message || typeof message !== 'object') throw new Error('Invalid request.');
  if (message.type === 'lease') return lease(message.owner, message.mode);
  if (message.type === 'currentTab') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ? { tabId: tab.id, title: tab.title, url: tab.url } : null;
  }
  if (message.type === 'actionHost') {
    validateToolCall({ name: message.name, args: message.args });
    return actionHost(message.name, message.args).catch(() => '');
  }
  if (message.type === 'browser') {
    await lease(message.owner, 'check');
    validateToolCall({ name: message.name, args: message.args });
    if (message.siteGuard !== undefined && (typeof message.siteGuard !== 'string' || !message.siteGuard)) throw new Error('Invalid site approval.');
    const next = operation.catch(() => {}).then(async () => {
      await lease(message.owner, 'check');
      return executeTool(message.name, message.args, { siteGuard: message.siteGuard });
    });
    operation = next;
    return next;
  }
  throw new Error('Unknown request.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender)) return false;
  handle(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onConnect.addListener(port => {
  if (!trusted(port.sender) || !port.name.startsWith('orbit:')) { port.disconnect(); return; }
  const owner = port.name.slice(6);
  port.onDisconnect.addListener(() => { lease(owner, 'release').catch(() => {}); });
});
chrome.debugger.onDetach.addListener((_source, reason) => {
  if (reason !== 'canceled_by_user') return;
  lock(async () => {
    await chrome.storage.session.remove('runner');
    await chrome.runtime.sendMessage({ type: 'debuggerCancelled' }).catch(() => {});
    await detachAll();
  }).catch(() => {});
});
chrome.commands?.onCommand.addListener((command, tab) => {
  // Opening the side panel must happen synchronously inside the shortcut's user gesture.
  if (command === 'open-panel' && tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  restrictStorage().catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
restrictStorage().catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
