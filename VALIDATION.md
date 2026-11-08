# Validation

What has been checked in Orbit 0.3.0, how, and what those checks do not cover. Last run: 2026-11-03 on Windows 11, Node 24.14.0.

## Automated checks

| Command | Result | Covers |
| --- | --- | --- |
| `npm test` | 86/86 pass | Agent loop, approvals (including site-scoped), recovery, compaction, token usage, small-model recovery and help stops; provider wire formats, retries, cancellation, and failure modes for OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints; driver commands against a fake `chrome` API; DOM operations in a `vm` sandbox; shortcut validation |
| `npm run check` | pass | MV3 manifest, referenced files exist, module imports resolve, no inline scripts, syntax of every extension file |
| `node tests/browser-smoke.mjs` | 9/9 pass on Chromium 145 (Playwright build) | The real extension loaded in headless Chromium with a temporary profile. See below |
| `npm run package` | pass | Writes `artifacts/orbit-extension.zip` |
| `node tests/live-eval.mjs` | Mistral Large 4: 6/6; Nemotron 3.5 Bolt: 6/6 (NVIDIA) | The real agent loop with a real model driving the real extension in headless Chromium. See below |

### Live eval

`tests/live-eval.mjs` runs six tasks on loopback practice pages and judges each one from page state and run status, not from the model's answer: `form` (compare plans, save a draft), `long` (an email at the bottom of a long page), `dialog` (delete through `confirm()`), `navigate` (a price on another page, ignoring a stale one), `login` (must stop for sign-in), and `missing` (must ask for missing details). Results go to `tests/artifacts/live-eval.json`.

Run on 2026-11-03: Mistral Large 4 passed all six (113,897 tokens). Nemotron 3.5 Bolt in compact mode first passed four (86,515 tokens): it looped on `form` until the step limit, and on `missing` it submitted placeholder text. After the multi-step loop check and the placeholder refusal were added, Bolt passed all six (97,999 tokens). Mistral has not been re-run since those changes. Details are in `docs/DEVLOG.md` sessions 4 and 5.

### Real-browser smoke checks

`tests/browser-smoke.mjs` drives the extension worker through the same RPC the panel uses, against a loopback fixture page:

1. Worker and panel load.
2. `read_page` finds controls and does not leak the password field's value.
3. Element IDs are stable; trusted typing, clicking, and native `select` changes work; the result is verified on the page.
4. Clicks inside an open shadow root and a same-origin iframe work.
5. `get_page_text` returns off-screen, shadow-root, and iframe text. `find` locates an off-screen button. `actionHost` resolves the hostname. A click that opens `confirm()` returns with the dialog, `read_page` is blocked until `handle_dialog`, and accepting it changes the page.
6. Real screenshot capture and wheel scrolling.
7. Navigation, back history, and stale IDs after a document change.
8. Tab list, switch, and close; debugger release.
9. The panel restores a saved run with token usage and lists a saved shortcut. Screenshots: `tests/artifacts/panel-run-smoke.png`, `tests/artifacts/panel-shortcuts-smoke.png`.

The report is written to `tests/artifacts/browser-smoke.json`.

## Not covered

- **Few real models.** Only two NVIDIA models have run the live eval, both with native tool calls. JSON-mode tool calls, vision, the OpenAI, Anthropic and Gemini endpoints, and local servers (Ollama, LM Studio) have not been run against a real model.
- **Live eval tasks are small.** Six short tasks on simple local pages, each run once. Results can vary between runs.
- **The approval card's "Allow on site" button** is covered by agent tests but has not been checked visually. A saved run in the approval state is restored as paused, so the smoke test cannot render it.
- **Keyboard shortcut** (`Alt+Shift+O`) has not been exercised. Headless Chromium does not deliver extension commands.
- **Branded Chrome:** the smoke test ran on Playwright's Chromium build. Branded Chrome may block `--load-extension`; load the unpacked extension manually to check it.
- **Real websites:** only local fixtures have been tested. Heavy single-page apps, sites with anti-automation measures, and cross-origin frames need manual testing.
- **`beforeunload` dialogs** and dialogs on tabs Orbit has not yet attached to are not detected.
