// Converts browser tool results into compact text for the model. Plain lines with
// [id] references cost far fewer tokens than JSON and are easier for small models to use.

const quote = value => JSON.stringify(String(value ?? ''));

function truncate(text, max) {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, cut: true };
}

export function formatElement(element, { vision = false } = {}) {
  let line = `[${element.elementId}] ${element.role}`;
  if (element.type && !['text', element.role].includes(element.type)) line += `(${element.type})`;
  line += ` ${quote(element.label)}`;
  if (element.value !== undefined && element.value !== '') line += ` value=${quote(element.value)}`;
  if (element.checked !== undefined) line += element.checked ? ' checked' : ' unchecked';
  if (element.disabled) line += ' disabled';
  if (element.readOnly) line += ' read-only';
  if (element.url) line += ` -> ${element.url}`;
  if (element.options) {
    line += ` options: ${element.options.map(option => `${quote(option.value)}${option.label && option.label !== option.value ? `=${quote(option.label)}` : ''}${option.selected ? ' (selected)' : ''}${option.disabled ? ' (disabled)' : ''}`).join(', ')}`;
  }
  if (vision && element.bounds) line += ` @(${Math.round(element.bounds.x + element.bounds.width / 2)},${Math.round(element.bounds.y + element.bounds.height / 2)})`;
  if (element.inViewport === false) line += ' (off-screen)';
  return line;
}

/** Hints that tell the model to hand control to the user instead of guessing. */
export function pageHints(snapshot) {
  const hints = [];
  const elements = snapshot.elements || [];
  const text = `${snapshot.text || ''} ${(snapshot.frames || []).map(frame => frame.url).join(' ')}`.toLowerCase();
  if (elements.some(element => element.type === 'password')) {
    hints.push('This page asks for a password. Orbit cannot type passwords. If the task needs sign-in, call ask_user so the user can sign in, then continue.');
  }
  if (/recaptcha|hcaptcha|turnstile|captcha|verify you are human|are you a robot|unusual traffic/.test(text)) {
    hints.push('This page shows a CAPTCHA or human check. Call ask_user so the user can complete it.');
  }
  if (/verification code|one-time code|two-factor|2-step verification|authenticator app/.test(text)) {
    hints.push('This page asks for a verification code. Call ask_user so the user can enter it.');
  }
  return hints;
}

export function formatSnapshot(snapshot, { vision = false, maxChars = 12000 } = {}) {
  const head = [`Tab ${snapshot.tabId ?? '?'} · ${snapshot.title || 'Untitled'} · ${snapshot.url || ''}`];
  const viewport = snapshot.viewport;
  if (viewport) head.push(`Viewport ${viewport.width}x${viewport.height}, scrolled to y=${Math.round(viewport.scrollY || 0)}.`);
  if (snapshot.note) head.push(`Note: ${snapshot.note}`);
  const inaccessible = (snapshot.frames || []).filter(frame => !frame.accessible);
  if (inaccessible.length) head.push(`Cross-origin frames (content not readable${vision ? '; use screenshot coordinates' : ''}): ${inaccessible.map(frame => frame.title || frame.url).join(', ')}`);
  for (const hint of pageHints(snapshot)) head.push(`HINT: ${hint}`);
  const elements = (snapshot.elements || []).map(element => formatElement(element, { vision }));
  // Controls are what the model acts on, so they get the larger share of the budget.
  const headText = head.join('\n');
  const room = Math.max(800, maxChars - headText.length - 200);
  let elementText = elements.join('\n');
  let elementsCut = false;
  if (elementText.length > room * 0.6) {
    const kept = [];
    let size = 0;
    for (const line of elements) {
      if (size + line.length + 1 > room * 0.6) break;
      kept.push(line);
      size += line.length + 1;
    }
    elementText = kept.join('\n');
    elementsCut = true;
  }
  const visible = truncate(snapshot.text || '', room - elementText.length);
  const parts = [headText, `VISIBLE TEXT:\n${visible.text || '(none)'}`, `CONTROLS (use the id inside [ ] as elementId):\n${elementText || '(none visible)'}`];
  if (elementsCut || visible.cut || snapshot.truncated) parts.push('More content exists than shown. Use find with words from the control you need, scroll, or get_page_text.');
  return parts.join('\n\n');
}

export function formatFind(result, { vision = false, maxChars = 12000 } = {}) {
  const lines = [`Tab ${result.tabId ?? '?'} · find ${quote(result.query)}: ${result.total} match${result.total === 1 ? '' : 'es'}.`];
  for (const element of result.matches || []) lines.push(formatElement(element, { vision }));
  if (!result.total) lines.push('No matching controls. Try other words, read_page, or get_page_text.');
  if (result.note) lines.push(result.note);
  return truncate(lines.join('\n'), maxChars).text;
}

export function formatText(result, { maxChars = 12000 } = {}) {
  const body = truncate(result.text || '', Math.max(500, maxChars - 300));
  const end = result.offset + body.text.length - (body.cut ? 1 : 0);
  const lines = [`Tab ${result.tabId ?? '?'} · ${result.title || 'Untitled'} · ${result.url || ''}`, `Characters ${result.offset}-${end} of ${result.totalLength}:`, body.text];
  if (end < result.totalLength) lines.push(`More text remains. Call get_page_text with offset ${end} to continue.`);
  return lines.join('\n');
}

/** Formats one tool result for the transcript. Returns {content, summary?} where summary replaces it once stale. */
export function formatToolResult(name, data, { vision = false, maxChars = 12000 } = {}) {
  if (data && !data.error) {
    if (name === 'read_page' && Array.isArray(data.elements)) {
      const content = formatSnapshot(data, { vision, maxChars });
      return { content, summary: `${content.split('\n')[0]}\n[Older observation removed to save space. Observe again if you need it.]` };
    }
    if (name === 'find' && Array.isArray(data.matches)) {
      const content = formatFind(data, { vision, maxChars });
      return { content, summary: `${content.split('\n')[0]} [Older results removed; IDs may be stale.]` };
    }
    if (name === 'get_page_text' && typeof data.text === 'string') {
      const content = formatText(data, { maxChars });
      return { content, summary: `${content.split('\n').slice(0, 2).join('\n')}\n[Older page text removed to save space. Use remember to keep facts you need.]` };
    }
  }
  const { observation, ...rest } = data && typeof data === 'object' ? data : { result: data };
  const base = truncate(JSON.stringify(rest), Math.min(4000, maxChars)).text;
  if (!observation) return { content: base };
  return {
    content: `${base}\n\nPAGE AFTER THIS ACTION:\n${observation}`,
    summary: `${base}\n[Page observation after this action removed to save space.]`,
  };
}

/** Replaces all but the newest `keep` observations with their summaries. Mutates and returns messages. */
export function pruneObservations(messages, keep = 2) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'tool' || !message.summary) continue;
    if (++seen > keep) {
      message.content = message.summary;
      delete message.summary;
      delete message.images;
    }
  }
  return messages;
}

export function hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
