# AGENTS.md — working on Orbit

Instructions for coding agents (Codex, Claude Code, others) and humans continuing this project. Read this first, then [`docs/DEVLOG.md`](docs/DEVLOG.md) for history and open work, and [`CONTRACT.md`](CONTRACT.md) for module interfaces.

## What this is

Orbit is a Chrome MV3 side-panel extension that lets any LLM operate the browser: OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints, including NVIDIA, OpenRouter, Ollama and LM Studio. The product goal: **finish what the model can do reliably, verify it on the page, and stop to ask the user instead of guessing.** That goal includes small models.

## Commands (no install step, no dependencies)

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | Node built-in test runner over `tests/*.test.js` (86 tests) | free, ~1s |
| `npm run check` | MV3 manifest, imports, syntax, no inline scripts | free |
| `node tests/browser-smoke.mjs` | Loads the real extension in headless Chromium and drives the worker RPC plus panel UI | free, ~20s, needs Chromium |
| `node tests/live-eval.mjs [--models a,b] [--tasks x,y] [--json] [--compact]` | Real agent with a real model on 6 practice tasks; writes `tests/artifacts/live-eval.json` | **spends API tokens**; needs `NVIDIA_API_KEY` or `ORBIT_EVAL_BASE_URL` + `ORBIT_EVAL_API_KEY` |
| `npm run package` | Zips `extension/` to `artifacts/orbit-extension.zip` | free |
| `npm run demo` | Serves the practice page at `http://127.0.0.1:4173/` | free |

On Windows use `npm.cmd` in PowerShell. Chromium is found via `ORBIT_CHROMIUM`, then Playwright's cache, then installed Chrome.

Before finishing any change, run `npm test` and `npm run check`. If you touched `extension/browser/` or the panel, also run the smoke test. If you changed prompts, observations, or the agent loop, run a live eval on at least one model, for example `--models mistral-large-4`.

## Layout

```
extension/
  manifest.json        MV3; permissions: sidePanel, storage, tabs, debugger; command open-panel (Alt+Shift+O)
  background.js        worker: trusted-panel RPC (lease, currentTab, actionHost, browser), runner lease, site guard
  core/agent.js        task loop: plan/observe/act/verify, approvals, recovery, help stops, context budget
  core/providers.js    wire formats per provider, retries/timeouts, lenient JSON tool parsing, usage normalisation
  core/tools.js        tool schemas, strict validation, coerceArgs (repairs sloppy args), toolsFor (compact set)
  core/observe.js      tool results -> compact text for the model; pruning; sign-in/CAPTCHA hints
  core/storage.js      settings, session checkpoint, shortcuts (chrome.storage)
  browser/driver.js    chrome.debugger/CDP actions, JS dialog tracking, actionHost
  browser/dom.js       fixed in-page code (isolated world): snapshot, find, full text, element refs
  panel/               side panel UI (html/css/js), no inline JS
tests/                 unit tests (*.test.js), smoke + live eval scripts, lib/extension-browser.mjs
fixtures/              practice pages
docs/DEVLOG.md         session-by-session development log  <- update it
CONTRACT.md            interface contract between modules  <- keep in sync
VALIDATION.md          what has been verified and what has not
```

## Conventions

- Plain ES modules, no build step, **no npm dependencies**. Match the surrounding style: terse, mostly comment-free, comments only for non-obvious reasons.
- The panel renders untrusted text with `textContent` and the small Markdown subset in `panel.js` only. Never use `innerHTML` with model or page text.
- The model can never supply JavaScript. `dom.js` is fixed code run in an isolated world, and model arguments are JSON data.
- Tests use `node:test` with fakes: a fake provider, fake RPC, fake `chrome` (see `tests/browser.test.js`), and `vm` for DOM code. Add a test for each behaviour change. Small-model behaviours live in `tests/small-model.test.js`.
- Patch scripts and heredocs on Windows Git Bash can eat backslashes. Check regexes after scripted edits.

## Invariants (do not break)

1. **Every tool call gets exactly one tool result, in order.** `state.pendingCalls` is a *copy* of the assistant's `toolCalls`. Skipped calls get `{skipped:true}`. A shared array once silently deleted calls from the transcript and broke native providers with HTTP 400. Covered by the "native transcripts … paired" test.
2. **Interrupted mutations are never replayed.** `inFlight` is written before dispatch. On resume the result is marked UNKNOWN.
3. **Approvals happen outside the model.** Ask mode pauses page-changing actions (`ACTION_TOOLS`). Site-scoped approval dispatches with `siteGuard`, and the driver re-checks the hostname right before executing.
4. **No claimed success without evidence.** `finish` is refused once while `needsCheck` is set. A text-only reply is nudged and never auto-completes after an unchecked change.
5. **Stop and ask instead of looping.** These set status `waiting` with `questionCall {id:null,name:'help'}`: 3 unusable model replies, 3 failed steps, or the same step (or a cycle of up to 4 steps) 3 times with unchanged results.
6. Passwords are never typed (the driver refuses) and their values are redacted in reads. API keys are redacted from errors and excluded from exports.

## Model notes

- NVIDIA endpoint `https://integrate.api.nvidia.com/v1` (OpenAI-compatible). Model IDs used in the eval: `mistralai/mistral-large-4-1t-a52b`, `nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/nemotron-3.5-bolt-e4b` (small), `minimaxai/minimax-m3.1-flash`. MiniMax did not respond at all on 2026-11-03.
- Small or local models: enable `compact`, set `contextTokens` to the real server context, and for Ollama set `OLLAMA_CONTEXT_LENGTH`.

## Keeping the log

After each working session, append an entry to `docs/DEVLOG.md`: date, tool or agent, goal, changes (files), behaviour changes, test and eval results with numbers, known issues, next steps. Update `CONTRACT.md` when an interface changes, and `VALIDATION.md` when verification changes. Never write API keys into any file.
