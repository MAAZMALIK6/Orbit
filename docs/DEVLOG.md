# Orbit development log

Newest session first. Each entry records the goal, what changed, why, how it was verified, and what is left. Interfaces live in [`../CONTRACT.md`](../CONTRACT.md); agent instructions are in [`../AGENTS.md`](../AGENTS.md).

## Current status (2026-11-03, v0.3.0)

- Working MV3 extension. 80 unit tests pass, the real-browser smoke test passes 9/9, and `npm run check` is clean.
- Live eval with real NVIDIA models: see the session 3 results below.
- Not a git repository yet. Run `git init` before the next session so changes can be reviewed and diffed.

### Open work, in suggested order

1. **Long requests:** MiniMax M3.1 Flash on NVIDIA never answered within 120s (even a bare "Say ready." with no tools). Find out whether that is account access, queueing, or a model that needs streaming. Consider streaming responses (`stream: true`) in `providers.js` so slow reasoning models show progress and don't hit the fixed 120s timeout.
2. **Make the 120s request timeout configurable** in settings (slow reasoning models, slow local hardware).
3. **Approval card "Allow on site" button:** covered by logic tests, not yet checked visually.
4. **Workflow recording:** shortcuts save prompts only, not click sequences.
5. **Multi-run history:** only the latest run is kept.
6. **Token-accurate budgeting:** context budgeting uses ~3.2 chars/token, not a tokenizer.
7. **Ollama end-to-end eval:** the harness supports `ORBIT_EVAL_BASE_URL=http://localhost:11434/v1`, but it has not been run because the Ollama server wasn't running.

---

## Session 3 — 2026-11-03 — Claude Code — small-model accuracy and "stop and ask" (v0.3.0)

**Goal (from the user):** work accurately, work properly on smaller models even if they can't do long tasks, finish what they can, and stop where they need the user's help.

### Bug fixed (pre-existing, serious)
- `agent.js`: `state.pendingCalls` and the assistant message's `toolCalls` were the **same array**, so `pendingCalls.shift()` deleted tool calls from the transcript. Native providers (OpenAI, Anthropic) then got tool results with no matching call and would reject the next request with HTTP 400. It was missed because agent tests used a fake provider and never checked the wire transcript. Fix: `pendingCalls = [...calls]`. Regression test: `tests/small-model.test.js` → "native transcripts sent to the API keep every tool result paired…", which runs the agent through the real OpenAI request builder and checks every request.

### Changes
- **`core/providers.js`**
  - `outputError()` marks unusable replies with `code:'model_output'` so the agent can recover. This covers malformed or unknown tool calls, bad JSON, empty output, and the output-token limit.
  - Lenient JSON mode: `extractJsonObjects()` finds JSON inside prose or code fences. It accepts `tool_calls`/`actions`/`calls`, `arguments`/`parameters`/`input`, a bare `{name,args}`, and `function:{name,arguments}`. `stripThinking()` removes `<think>` blocks.
  - Native mode recovers tool calls a local model prints as text (`<tool_call>{…}</tool_call>`), but only when every name is a known tool.
  - The JSON-mode prompt lists tools as short signatures with an example, instead of full JSON schemas, which saves tokens.
  - Presets: added **NVIDIA API catalog**. Every preset now carries `compact` and `contextTokens`, and Ollama and LM Studio default to compact with 8192.
- **`core/tools.js`**
  - `coerceArgs()` repairs sloppy arguments before strict validation: numeric strings, `[id]` brackets or quotes, aliases (`element_id`, `id`, `tab_id`, `ms`, `value`→`text`), enum case, nulls and extra keys. Number-to-string conversion applies only to IDs, text, query and value, never URLs.
  - `toolsFor({compact, vision})`: screenshot and drag only with vision. Compact mode drops update_plan, close_tab, hover and drag, uses plain short descriptions, and makes `click` require `elementId`.
  - New sets `PAGE_CHANGING_TOOLS` and `OBSERVATION_TOOLS`.
- **`core/observe.js` (new)**
  - Formats `read_page`/`find`/`get_page_text` as compact text with `[id] role "label"` lines, sized to a character budget.
  - Adds HINT lines for password fields, CAPTCHAs and verification codes, telling the model to call `ask_user`.
  - `pruneObservations()` keeps only the newest 2 observations in full.
- **`core/agent.js` (rewritten, same public API plus `reply(text, settings?)`)**
  - `COMPACT_PROMPT` for small models. Both prompts include an explicit "when to stop and ask" list.
  - Context budget from `settings.contextTokens`: observation size, history trimming, and a compaction note when history is dropped.
  - Auto re-read after page-changing actions (`settings.autoObserve`, default on): the page is appended to the action result as "PAGE AFTER THIS ACTION". After a page-changing action, the rest of that turn's queued calls are skipped and answered, except update_plan and remember.
  - Unusable replies are fed back to the model with the error and retried. After 3 in a row it stops for help.
  - A text-only reply gets one nudge. The second completes only if nothing is unchecked; otherwise it becomes a question to the user.
  - `finish` is refused once while an action's result hasn't been observed (`needsCheck`).
  - Help stops after 3 failed steps or the same step 3 times with an unchanged result: status `waiting`, `questionCall {id:null,name:'help'}`. `reply()` adds a plain user message and can apply a model change made while waiting.
  - When few steps remain, the system prompt tells the model to finish with what it verified or ask.
- **`browser/dom.js`:** element IDs shortened to `xxxxx-N` (5-character random prefix per document), which are easier for small models to copy.
- **`browser/driver.js`:** `read_page`, `find` and `get_page_text` wait for a loading tab (up to 8s) before reading.
- **`core/storage.js`:** new settings `compact`, `contextTokens` (2048–2,000,000), `autoObserve`.
- **Panel:** settings for small-model mode, context window (with the Ollama context warning) and auto re-read. Presets fill these in. The question card says "Orbit needs a hand." for help stops, and replies pass the current settings.
- **Tests:** `tests/small-model.test.js` (18 tests); existing tests updated for the intended changes. `tests/lib/extension-browser.mjs` now holds the browser launch code shared by the smoke test and the eval.
- **`tests/live-eval.mjs` (new):** real agent, real model, real extension in headless Chromium, six local tasks judged from page state:
  - `form`: compare plans, save a draft, verify it.
  - `long`: find an email at the bottom of a long page.
  - `dialog`: delete one draft through `confirm()`.
  - `navigate`: find a price on another page, ignoring a stale price on the blog.
  - `login`: must stop for sign-in and invent no balance.
  - `missing`: must ask for the missing name and phone instead of submitting.
- **Docs:** README section "Smaller models", NVIDIA preset, live-eval usage; CONTRACT updated; this log and AGENTS.md created.

### Verification
- `npm test`: 80/80. `npm run check`: clean. `node tests/browser-smoke.mjs`: 9/9 on Chromium 145.
- Settings dialog checked by screenshot: the Ollama preset sets compact on and 8192.
- Live eval (NVIDIA, native tools, auto mode, 20-step limit): see below.

### Live eval results

LIVE_EVAL_RESULTS_PLACEHOLDER

---

## Session 2 — 2026-11-03 — Claude Code — capability gaps (v0.2.0)

**Goal:** read the Codex-built MVP and continue building.

- `get_page_text` returned only viewport text. It now reads the whole document (including shadow roots and same-origin frames) in 25k-character chunks with `offset`/`nextOffset` (`dom.js` `text` operation).
- New `find` tool: whole-document search for interactive elements by words. Off-screen matches are scrolled into view when used.
- JavaScript dialogs: the driver tracks `Page.javascriptDialogOpening/Closed`. Input that opens a dialog returns immediately with `dialog {type,message}` instead of hanging until the 15s timeout. Other actions are blocked until the new `handle_dialog` tool runs.
- Site-scoped approvals: "Allow on <host> for this task". The worker re-checks the host just before dispatch (`siteGuard`, `actionHost`).
- Token usage normalised across providers (`normalizeUsage`) and shown in the run header.
- Saved task shortcuts (`loadShortcuts`/`saveShortcuts`), shown on the home screen.
- `Alt+Shift+O` opens the panel (`commands.open-panel` → `sidePanel.open`).
- Created VALIDATION.md, which the README linked but didn't exist. Fixed wrong README claims about the smoke test.
- Verified: 62 unit tests and the smoke test 9/9, including a real `confirm()` round trip.

## Session 1 — before 2026-11-03 — Codex — MVP (v0.1.0)

Built from `CONTRACT.md` by provider, browser and UI sub-agents:
- Provider adapters for OpenAI, Anthropic, Gemini and OpenAI-compatible endpoints, with retries, cancellation and a 120s timeout.
- CDP-based browser driver with an isolated-world DOM snapshot.
- Agent loop with approvals, checkpoints and interrupted-action recovery.
- Side panel UI and settings.
- 51 unit tests and a real-browser smoke script.

Known gaps at handoff, all addressed in sessions 2 and 3: viewport-only text, no dialog handling, all-or-nothing approvals, no small-model handling, and the shared `pendingCalls` array bug.
