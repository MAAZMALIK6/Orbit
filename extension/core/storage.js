export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'compatible', baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '',
  toolMode: 'native', vision: false, permissionMode: 'ask', maxTurns: 40,
  maxTokens: 4096, rememberKey: false,
  compact: false, contextTokens: 32000, autoObserve: true,
});

export async function restrictStorage() {
  await Promise.all(['local', 'session'].map(area =>
    chrome.storage[area].setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })));
}

export async function loadSettings() {
  const [{ settings }, { apiKey }] = await Promise.all([
    chrome.storage.local.get('settings'), chrome.storage.session.get('apiKey'),
  ]);
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  if (!merged.rememberKey) merged.apiKey = apiKey || '';
  return merged;
}

export function validateSettings(settings) {
  const result = { ...DEFAULT_SETTINGS, ...settings };
  if (!['openai', 'compatible', 'anthropic', 'gemini'].includes(result.provider)) throw new Error('Choose a supported API protocol.');
  if (!String(result.model).trim()) throw new Error('Enter the model ID served by your provider.');
  result.model = result.model.trim();
  let url;
  try { url = new URL(result.baseUrl); } catch { throw new Error('Enter a valid API base URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('API endpoints must use HTTPS, or HTTP on localhost for local models.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL must not contain credentials, a query, or a fragment.');
  result.baseUrl = url.href.replace(/\/+$/, '');
  if (!['native', 'json'].includes(result.toolMode)) throw new Error('Choose native or JSON tools.');
  if (!['ask', 'auto'].includes(result.permissionMode)) throw new Error('Choose an action permission mode.');
  result.maxTurns = Math.min(200, Math.max(1, Math.round(Number(result.maxTurns) || 40)));
  result.maxTokens = Math.min(32768, Math.max(256, Math.round(Number(result.maxTokens) || 4096)));
  result.apiKey = String(result.apiKey || '').trim();
  result.rememberKey = !!result.rememberKey;
  result.vision = !!result.vision;
  result.compact = !!result.compact;
  result.autoObserve = result.autoObserve !== false;
  result.contextTokens = Math.min(2000000, Math.max(2048, Math.round(Number(result.contextTokens) || 32000)));
  return result;
}

export async function saveSettings(settings) {
  const value = validateSettings(settings);
  const stored = { ...value, apiKey: value.rememberKey ? value.apiKey : '' };
  await chrome.storage.local.set({ settings: stored });
  if (value.rememberKey) await chrome.storage.session.remove('apiKey');
  else await chrome.storage.session.set({ apiKey: value.apiKey });
  return value;
}

export const MAX_SHORTCUTS = 50;

/** Normalizes saved task shortcuts: [{id, title, prompt, createdAt}]. Invalid entries are dropped. */
export function validateShortcuts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(item => item && typeof item.prompt === 'string' && item.prompt.trim() && typeof item.id === 'string' && !seen.has(item.id) && seen.add(item.id))
    .slice(0, MAX_SHORTCUTS)
    .map(({ id, title, prompt, createdAt }) => ({
      id: id.slice(0, 64),
      title: String(title || prompt).replace(/\s+/g, ' ').trim().slice(0, 80),
      prompt: prompt.trim().slice(0, 20000),
      createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
    }));
}

export async function loadShortcuts() {
  return validateShortcuts((await chrome.storage.local.get('shortcuts')).shortcuts);
}

export async function saveShortcuts(list) {
  const value = validateShortcuts(list);
  await chrome.storage.local.set({ shortcuts: value });
  return value;
}

export async function loadSession() {
  return (await chrome.storage.local.get('session')).session || null;
}

let pendingSave = Promise.resolve();
export function saveSession(state) {
  // Snapshot before queuing to avoid persisting a later, partially mutated state.
  const snapshot = structuredClone(state);
  pendingSave = pendingSave.catch(() => {}).then(() => chrome.storage.local.set({ session: snapshot }));
  return pendingSave;
}

export async function clearSession() {
  await pendingSave.catch(() => {});
  await chrome.storage.local.remove('session');
}
