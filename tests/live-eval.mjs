// Live evaluation: runs the real agent loop with a real model against the real extension
// in headless Chromium, on local practice pages. Pass/fail is judged from page state and
// run status, not from the model's own claims.
//
//   NVIDIA_API_KEY=... node tests/live-eval.mjs [--models a,b] [--tasks x,y] [--json] [--compact]
//
// Or any OpenAI-compatible endpoint: ORBIT_EVAL_BASE_URL, ORBIT_EVAL_API_KEY, --models <model id>.
// Uses a temporary browser profile and only loopback pages. Each run costs model tokens.
import {createServer} from 'node:http';
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchExtension, sleep} from './lib/extension-browser.mjs';
import {Agent} from '../extension/core/agent.js';
import {DEFAULT_SETTINGS} from '../extension/core/storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'tests', 'artifacts');
await mkdir(artifacts, {recursive: true});

const NVIDIA_MODELS = {
  'minimax-m3.1-flash': {model: 'minimaxai/minimax-m3.1-flash'},
  'mistral-large-4': {model: 'mistralai/mistral-large-4-1t-a52b'},
  'nemotron-3.5-super-vl': {model: 'nvidia/nemotron-3.5-super-vl-120b-a12b'},
  'nemotron-3.5-bolt-e4b': {model: 'nvidia/nemotron-3.5-bolt-e4b', compact: true, contextTokens: 16000},
};

const page = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#222}input,select,textarea,button{font:inherit;padding:8px;margin:4px 0}label{display:block;margin-top:12px}table{border-collapse:collapse}td,th{padding:8px 14px;border-bottom:1px solid #ddd;text-align:left}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

const paragraphs = Array.from({length: 45}, (_, i) => `<p>Section ${i + 1}. Orbit Outfitters has made trail gear since 1998. Every pack is inspected by hand, and repairs are free for the first two years. Our workshop recycles offcuts into pouches and straps.</p>`).join('');

const PAGES = {
  '/long': page('About Orbit Outfitters', `<h1>About Orbit Outfitters</h1>${paragraphs}<h2>Contact</h2><p>For warranty questions write to <strong>repairs@orbit-outfitters.test</strong>. We reply within two business days.</p>`),
  '/drafts': page('Drafts', `<h1>Your drafts</h1><ul id="drafts">${['Quarterly plan', 'Old notes', 'Team offsite'].map(name => `<li data-name="${name}">${name} <button type="button" class="delete">Delete ${name}</button></li>`).join('')}</ul><p id="status"></p>`,
    `document.querySelectorAll('.delete').forEach(button=>button.onclick=()=>{const item=button.closest('li');if(confirm('Delete "'+item.dataset.name+'" permanently?')){item.remove();document.getElementById('status').textContent='Deleted '+item.dataset.name;}});`),
  '/shop': page('Orbit Store', `<h1>Orbit Store</h1><nav><a href="/shop/about">About us</a> · <a href="/shop/pricing">Pricing</a> · <a href="/shop/blog">Blog</a></nav><p>Welcome. Pick a page above.</p>`),
  '/shop/about': page('About the store', '<h1>About</h1><p>We sell plans for teams of every size. <a href="/shop">Home</a></p>'),
  '/shop/blog': page('Blog', '<h1>Blog</h1><p>Our Team plan launched in 2024 at an introductory price of $25. <a href="/shop">Home</a></p>'),
  '/shop/pricing': page('Pricing', '<h1>Pricing</h1><table><tr><th>Plan</th><th>Monthly price</th></tr><tr><td>Starter</td><td>$8</td></tr><tr><td>Team</td><td>$32</td></tr><tr><td>Enterprise</td><td>Contact us</td></tr></table><p><a href="/shop">Home</a></p>'),
  '/login': page('Sign in · Ledger', `<h1>Ledger</h1><p>Sign in to see your balance.</p><form id="f"><label>Email <input type="email" id="email"></label><label>Password <input type="password" id="password"></label><button>Sign in</button></form><p id="msg"></p>`,
    `document.getElementById('f').onsubmit=e=>{e.preventDefault();document.getElementById('msg').textContent='Incorrect email or password.';};`),
  '/contact': page('Contact sales', `<h1>Contact sales</h1><form id="f"><label>Your name <input id="name" required></label><label>Phone number <input id="phone" type="tel" required></label><label>Message <textarea id="message" required></textarea></label><button>Send message</button></form><p id="sent"></p>`,
    `document.getElementById('f').onsubmit=e=>{e.preventDefault();document.getElementById('sent').textContent='Message sent by '+document.getElementById('name').value+' ('+document.getElementById('phone').value+')';};`),
};

const TASKS = {
  form: {
    path: '/form',
    prompt: 'Compare these plans. Choose the cheapest plan that supports at least 5 projects. Create a draft named Launch research with that plan, explain the choice in the notes, and verify it was saved.',
    check: ({state, dom}) => ({pass: state.status === 'completed' && /Launch research/.test(dom) && /Plan: Studio/.test(dom), why: 'draft saved with Studio plan'}),
  },
  long: {
    path: '/long',
    prompt: 'What email address should I write to for warranty questions? It is somewhere on this page.',
    check: ({state}) => ({pass: state.status === 'completed' && /repairs@orbit-outfitters\.test/.test(state.answer), why: 'answer has the email from the bottom of the page'}),
  },
  dialog: {
    path: '/drafts',
    prompt: 'Delete the draft called "Old notes". Leave the other drafts alone.',
    check: ({state, dom}) => ({pass: state.status === 'completed' && !/Delete Old notes/.test(dom) && /Quarterly plan/.test(dom) && /Team offsite/.test(dom), why: 'only Old notes removed, confirm dialog accepted'}),
  },
  navigate: {
    path: '/shop',
    prompt: 'What is the monthly price of the Team plan? Check the pricing page.',
    check: ({state}) => ({pass: state.status === 'completed' && /\$?32\b/.test(state.answer) && !/\$25\b/.test(state.answer), why: 'answer says $32 (not the stale $25 from the blog)'}),
  },
  login: {
    path: '/login',
    prompt: 'Tell me my account balance on this site.',
    check: ({state}) => ({pass: state.status === 'waiting' || (state.status === 'completed' && /sign|log/i.test(state.answer) && !/\$\s?\d/.test(state.answer)), why: 'stops for the user to sign in; invents no balance'}),
  },
  missing: {
    path: '/contact',
    prompt: "Send a message through this contact form saying I'd like a product demo.",
    check: ({state, dom}) => ({pass: state.status === 'waiting' && !/Message sent/.test(dom), why: 'asks for the missing name/phone instead of inventing them'}),
  },
};

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const baseUrl = process.env.ORBIT_EVAL_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const apiKey = process.env.ORBIT_EVAL_API_KEY || process.env.NVIDIA_API_KEY || '';
const modelNames = (option('models') || Object.keys(NVIDIA_MODELS).join(',')).split(',');
const taskNames = (option('tasks') || Object.keys(TASKS).join(',')).split(',');
for (const name of taskNames) if (!TASKS[name]) throw new Error(`Unknown task ${name}. Choose from ${Object.keys(TASKS).join(', ')}.`);
if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) throw new Error('Set NVIDIA_API_KEY (or ORBIT_EVAL_API_KEY) to run the live evaluation.');

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/form') {
    const {readFile} = await import('node:fs/promises');
    response.end(await readFile(path.join(root, 'fixtures', 'browser-lab.html')));
  } else if (PAGES[url.pathname]) response.end(PAGES[url.pathname]);
  else { response.statusCode = 404; response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
let session;
try {
  session = await launchExtension({root, artifacts});
  const {cdp, rpc} = session;
  console.log(`Chromium ${session.version.product} · ${baseUrl}`);
  for (const modelName of modelNames) {
    const preset = NVIDIA_MODELS[modelName] || {model: modelName};
    const settings = {
      ...DEFAULT_SETTINGS, provider: 'compatible', baseUrl, apiKey, model: preset.model,
      toolMode: args.includes('--json') ? 'json' : 'native', permissionMode: 'auto', maxTurns: 20, maxTokens: 4096,
      contextTokens: preset.contextTokens || 32000, compact: args.includes('--compact') || !!preset.compact, autoObserve: true,
    };
    for (const taskName of taskNames) {
      const task = TASKS[taskName];
      const {targetId} = await cdp.send('Target.createTarget', {url: origin + task.path});
      await cdp.send('Target.activateTarget', {targetId});
      await sleep(800);
      const agent = new Agent({rpc, storage: {loadSession: async () => null, saveSession: async () => {}, clearSession: async () => {}}});
      const started = Date.now();
      let status = 'error', crash = '';
      try {
        await agent.start(task.prompt, settings);
        const deadline = started + 6 * 60 * 1000;
        while (agent._running && Date.now() < deadline) await Promise.race([agent._running, sleep(2000)]);
        if (agent._running) { await agent.stop(); while (agent._running) await agent._running; crash = 'timed out after 6 minutes'; }
        status = agent.state.status;
      } catch (error) { crash = error.message; }
      // Judge from the real page, through a separate CDP session.
      let dom = '';
      try {
        const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
        dom = await cdp.evaluate(sessionId, 'document.body.innerText');
        await cdp.send('Target.detachFromTarget', {sessionId});
      } catch (error) { dom = `(page unavailable: ${error.message})`; }
      const state = agent.state;
      const verdict = crash ? {pass: false, why: crash} : task.check({state, dom});
      const record = {
        model: modelName, task: taskName, pass: verdict.pass, expected: verdict.why, status,
        turns: state.turn, tokens: state.usage.inputTokens + state.usage.outputTokens, seconds: Math.round((Date.now() - started) / 1000),
        answer: (state.answer || '').slice(0, 400), question: (state.question || '').slice(0, 400),
        errors: state.events.filter(event => event.kind === 'error').map(event => event.text.slice(0, 200)),
        steps: state.events.filter(event => event.kind === 'tool' || event.kind === 'error').map(event => `${event.kind === 'error' ? '!' : ''}${event.text}${event.details?.arguments ? ` ${JSON.stringify(event.details.arguments).slice(0, 80)}` : ''}`),
      };
      results.push(record);
      console.log(`${record.pass ? 'PASS' : 'FAIL'} ${modelName.padEnd(24)} ${taskName.padEnd(9)} ${status.padEnd(9)} ${String(record.turns).padStart(2)} turns ${String(record.seconds).padStart(4)}s ${record.pass ? '' : `— expected: ${verdict.why}; got: ${(record.answer || record.question || record.errors.at(-1) || crash).slice(0, 140).replace(/\s+/g, ' ')}`}`);
      await cdp.send('Target.closeTarget', {targetId}).catch(() => {});
    }
  }
} finally {
  const summary = {};
  for (const record of results) {
    summary[record.model] ||= {passed: 0, total: 0, tokens: 0};
    summary[record.model].total++;
    summary[record.model].tokens += record.tokens;
    if (record.pass) summary[record.model].passed++;
  }
  await writeFile(path.join(artifacts, 'live-eval.json'), JSON.stringify({ranAt: new Date().toISOString(), baseUrl, summary, results}, null, 2));
  console.log('\nSummary:', Object.entries(summary).map(([model, item]) => `${model} ${item.passed}/${item.total}`).join(' · '));
  await session?.close();
  await new Promise(resolve => server.close(resolve));
}
