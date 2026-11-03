// This function runs only in our named isolated world. Its source is fixed by
// the extension; model arguments are JSON data, never executable JavaScript.
export function pageOperation(operation, args = {}) {
  const KEY = '__orbitBrowserDOMv1';
  let state = globalThis[KEY];
  if (!state || state.document !== document) {
    state = globalThis[KEY] = {
      document,
      // Short IDs are easier for small models to copy; the random prefix still marks stale documents.
      prefix: crypto.randomUUID().slice(0, 5),
      next: 0,
      ids: new WeakMap(),
      refs: new Map(),
    };
  }
  const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const safeUrl = value => {
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      url.username = ''; url.password = '';
      return url.href.slice(0, 2000);
    } catch { return ''; }
  };
  const chainValid = frames => frames.every(({frame, childDocument}) => {
    try { return frame.isConnected && frame.contentDocument === childDocument; } catch { return false; }
  });
  function getRef(id) {
    const ref = state.refs.get(id);
    if (!ref || !ref.node.isConnected || !chainValid(ref.frames)) {
      if (ref) state.refs.delete(id);
      throw new Error('STALE_ELEMENT: Read the page again and use an element ID from the current document.');
    }
    return ref;
  }
  function idFor(node, frames) {
    let id = state.ids.get(node);
    if (!id) { id = `${state.prefix}-${++state.next}`; state.ids.set(node, id); }
    state.refs.set(id, {node, frames});
    return id;
  }
  function bounds(node, frames) {
    const rect = node.getBoundingClientRect();
    let x = rect.x, y = rect.y;
    for (const {frame} of frames) {
      const outer = frame.getBoundingClientRect();
      x += outer.x + frame.clientLeft;
      y += outer.y + frame.clientTop;
    }
    return {x: Math.round(x), y: Math.round(y), width: Math.round(rect.width), height: Math.round(rect.height)};
  }
  function displayed(node) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
  }
  function inViewport(node, frames) {
    const r = node.getBoundingClientRect();
    const win = node.ownerDocument.defaultView;
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) return false;
    const b = bounds(node, frames);
    return b.x + b.width > 0 && b.y + b.height > 0 && b.x < innerWidth && b.y < innerHeight;
  }
  function label(node) {
    const labelled = node.getAttribute('aria-labelledby');
    const root = node.getRootNode();
    const referenced = labelled ? labelled.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' ') : '';
    return clean(node.getAttribute('aria-label') || referenced ||
      (node.labels ? [...node.labels].map(item => item.textContent).join(' ') : '') ||
      node.getAttribute('placeholder') || node.getAttribute('alt') || node.getAttribute('title') ||
      ((node.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(node.type)) ? node.value : node.innerText) ||
      node.getAttribute('name'), 250);
  }
  function role(node) {
    if (node.getAttribute('role')) return node.getAttribute('role');
    const tag = node.tagName.toLowerCase();
    return ({a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button', iframe: 'frame'})[tag] ||
      (tag === 'input' ? ({checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button'})[node.type] || 'textbox' : node.isContentEditable ? 'textbox' : 'element');
  }
  function editable(node) {
    return !!node && (node.isContentEditable || node.tagName === 'TEXTAREA' ||
      (node.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'image'].includes(node.type)));
  }
  function point(ref, scroll = true) {
    const {node, frames} = ref;
    if (scroll) {
      for (const {frame} of frames) frame.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      node.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    }
    if (!displayed(node) || !inViewport(node, frames)) throw new Error('Element is not visible. Read the page again.');
    const b = bounds(node, frames);
    const x = (Math.max(0, b.x) + Math.min(innerWidth, b.x + b.width)) / 2;
    const y = (Math.max(0, b.y) + Math.min(innerHeight, b.y + b.height)) / 2;
    // Refuse a covered element instead of clicking an unrelated overlay.
    let localX = x, localY = y;
    for (const {frame} of frames) {
      const r = frame.getBoundingClientRect();
      const hit = frame.ownerDocument.elementFromPoint(localX, localY);
      if (hit && hit !== frame && !hit.contains(frame)) throw new Error('Element is covered by another element. Read the page or use a screenshot.');
      localX -= r.x + frame.clientLeft; localY -= r.y + frame.clientTop;
    }
    let hit = node.ownerDocument.elementFromPoint(localX, localY);
    while (hit?.shadowRoot?.elementFromPoint) {
      const next = hit.shadowRoot.elementFromPoint(localX, localY);
      if (!next || next === hit) break;
      hit = next;
    }
    if (hit && hit !== node && !node.contains(hit) && !hit.contains(node)) {
      throw new Error('Element is covered by another element. Read the page or use a screenshot.');
    }
    return {x, y, role: role(node)};
  }
  if (operation === 'point') {
    const ref = getRef(args.elementId);
    if (ref.node.disabled || ref.node.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled.');
    return point(ref);
  }
  if (operation === 'focus') {
    let node;
    if (args.elementId) {
      const ref = getRef(args.elementId);
      node = ref.node;
      if (!editable(node)) throw new Error('This element is not editable. Use click or select_option.');
      point(ref);
      node.focus({preventScroll: true});
      if (node.getRootNode().activeElement !== node && !node.contains(node.getRootNode().activeElement)) throw new Error('Unable to focus the requested field.');
    } else {
      node = document.activeElement;
      for (let depth = 0; depth < 20; depth++) {
        if (node?.shadowRoot?.activeElement) { node = node.shadowRoot.activeElement; continue; }
        if (node?.tagName === 'IFRAME') {
          let child;
          try { child = node.contentDocument; } catch { /* Cross-origin focus is still usable with trusted input. */ }
          if (!child) return {editable: true, crossOriginFocus: true};
          node = child.activeElement;
          continue;
        }
        break;
      }
      if (!editable(node)) throw new Error('No editable field has focus. Click a field or supply its elementId.');
    }
    if (node.disabled || node.readOnly) throw new Error('The field is disabled or read-only.');
    return {editable: true, password: node.type === 'password'};
  }
  if (operation === 'select') {
    const ref = getRef(args.elementId);
    const node = ref.node;
    if (node.tagName !== 'SELECT') throw new Error('select_option requires a native select element. Use click for custom dropdowns.');
    if (node.disabled) throw new Error('The select is disabled.');
    const option = [...node.options].find(item => item.value === args.value);
    if (!option) throw new Error('No option has that value. Read the page for available options.');
    if (option.disabled || option.parentElement?.disabled) throw new Error('The requested option is disabled.');
    point(ref);
    node.focus({preventScroll: true});
    // Calling the native setter preserves compatibility with controlled inputs.
    const win = node.ownerDocument.defaultView;
    Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set.call(node, args.value);
    node.dispatchEvent(new win.Event('input', {bubbles: true}));
    node.dispatchEvent(new win.Event('change', {bubbles: true}));
    return {value: node.value, label: clean(option.textContent)};
  }
  const interactive = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[contenteditable="true"],[tabindex]';
  function describe(node, frameChain) {
    const item = {elementId: idFor(node, frameChain), tag: node.tagName.toLowerCase(), role: role(node), label: label(node), bounds: bounds(node, frameChain)};
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (node.readOnly) item.readOnly = true;
    if (node.tagName === 'INPUT') item.type = node.type;
    if ('value' in node && node.tagName !== 'BUTTON') item.value = node.type === 'password' ? '[redacted]' : clean(node.value, 400);
    if (['checkbox', 'radio'].includes(node.type)) item.checked = node.checked;
    if (node.tagName === 'A') item.url = safeUrl(node.href);
    if (node.tagName === 'SELECT') item.options = [...node.options].slice(0, 60).map(o => ({value: o.value, label: clean(o.textContent, 150), selected: o.selected, disabled: o.disabled}));
    return item;
  }
  // Whole-document traversal for operations that are not limited to the viewport.
  function eachElement(root, frameChain, visit, budget = {nodes: 30000}, depth = 0) {
    if (depth > 30 || !root?.querySelectorAll) return;
    for (const node of root.querySelectorAll('*')) {
      if (--budget.nodes < 0) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName)) continue;
      visit(node, frameChain);
      if (node.shadowRoot) eachElement(node.shadowRoot, frameChain, visit, budget, depth + 1);
      if ((node.tagName === 'IFRAME' || node.tagName === 'FRAME') && frameChain.length < 8) {
        let child;
        try { child = node.contentDocument; } catch { /* Cross-origin frames are not readable. */ }
        if (child?.body) eachElement(child, [...frameChain, {frame: node, childDocument: child}], visit, budget, depth + 1);
      }
    }
  }
  function rendered(node) {
    if (node.checkVisibility) return node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
    const r = node.getBoundingClientRect();
    return displayed(node) && r.width > 0 && r.height > 0;
  }
  if (operation === 'find') {
    const terms = clean(args.query, 200).toLowerCase().split(' ').filter(Boolean);
    if (!terms.length) throw new Error('find requires a non-empty query.');
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    // Landmark and container roles contain other controls; matching their text is noise.
    const containers = new Set(['main', 'navigation', 'region', 'banner', 'contentinfo', 'complementary', 'presentation', 'none', 'document', 'article',
      'application', 'list', 'listitem', 'group', 'generic', 'form', 'search', 'feed', 'log', 'status', 'toolbar', 'tablist', 'menubar', 'tree',
      'grid', 'table', 'rowgroup', 'dialog', 'alertdialog', 'tabpanel', 'img', 'heading', 'section', 'paragraph']);
    const found = [];
    eachElement(document, [], (node, frameChain) => {
      if (!node.matches(interactive) || containers.has(role(node)) || node.getAttribute('aria-hidden') === 'true' || !rendered(node)) return;
      const name = label(node).toLowerCase();
      const haystack = [name, node.getAttribute('name'), node.getAttribute('id'), node.getAttribute('placeholder'), node.getAttribute('title'), role(node),
        node.tagName === 'A' ? node.getAttribute('href') : '', node.innerText].map(value => clean(value, 300)).join(' ').toLowerCase();
      if (terms.every(term => haystack.includes(term))) found.push({node, frameChain, score: terms.every(term => name.includes(term)) ? 1 : 0});
    });
    found.sort((a, b) => b.score - a.score);
    const matches = found.slice(0, limit).map(({node, frameChain}) => ({...describe(node, frameChain), inViewport: inViewport(node, frameChain)}));
    return {query: args.query, matches, total: found.length, ...(found.length > matches.length ? {note: `Showing ${matches.length} of ${found.length} matches. Use a more specific query.`} : {})};
  }
  if (operation === 'text') {
    const parts = [document.body?.innerText || ''];
    // innerText does not cross shadow roots or frames, so append those separately.
    eachElement(document, [], (node, frameChain) => {
      if (node.shadowRoot && rendered(node)) {
        const shadowText = [...node.shadowRoot.children].map(child => child.innerText || '').join('\n').trim();
        if (shadowText) parts.push(shadowText);
      }
      if ((node.tagName === 'IFRAME' || node.tagName === 'FRAME') && rendered(node)) {
        let child;
        try { child = node.contentDocument; } catch { /* Cross-origin frames are not readable. */ }
        const frameText = child?.body?.innerText?.trim();
        if (frameText) parts.push(`[Frame: ${clean(node.title || safeUrl(node.src), 200)}]\n${frameText}`);
      }
    });
    const full = parts.join('\n\n').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const chunk = 25000;
    const text = full.slice(offset, offset + chunk);
    const next = offset + text.length;
    return {title: document.title, url: safeUrl(location.href), text, offset, totalLength: full.length,
      ...(next < full.length ? {nextOffset: next, note: `Text continues. Call get_page_text with offset ${next} for more.`} : {})};
  }
  if (operation === 'viewport') return {width: innerWidth, height: innerHeight, devicePixelRatio};
  if (operation !== 'snapshot') throw new Error('Unsupported internal page operation.');

  const elements = [], frames = [], text = [];
  let visited = 0, textLength = 0;
  const limits = {nodes: 16000, elements: 300, text: 24000};
  const seenText = new Set();
  function walk(node, frameChain, depth = 0) {
    if (++visited > limits.nodes || depth > 100) return;
    if (node.nodeType === 3) {
      if (textLength >= limits.text || !node.parentElement) return;
      const parent = node.parentElement;
      if (!displayed(parent) || !inViewport(parent, frameChain) || parent.closest('script,style,noscript,template,textarea,select,[aria-hidden="true"]')) return;
      // A text Range prevents large off-screen parent elements from contributing hidden text.
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      const win = node.ownerDocument.defaultView;
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth) return;
      const value = clean(node.textContent, limits.text - textLength);
      if (value && !seenText.has(node)) { text.push(value); textLength += value.length + 1; seenText.add(node); }
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName) || node.getAttribute('aria-hidden') === 'true' || !displayed(node)) return;
      const visible = inViewport(node, frameChain);
      if (visible && node.matches(interactive) && elements.length < limits.elements) elements.push(describe(node, frameChain));
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
        if (!visible) return;
        let child;
        try { child = node.contentDocument; } catch { /* The browser protects cross-origin DOM. */ }
        frames.push({title: clean(node.title, 200), url: safeUrl(node.src), accessible: !!child, bounds: bounds(node, frameChain)});
        if (child?.body && frameChain.length < 8) walk(child.body, [...frameChain, {frame: node, childDocument: child}], depth + 1);
        return;
      }
      if (node.shadowRoot) { walk(node.shadowRoot, frameChain, depth + 1); return; }
      if (node.tagName === 'SLOT' && node.assignedNodes) {
        const assigned = node.assignedNodes({flatten: true});
        if (assigned.length) { for (const child of assigned) walk(child, frameChain, depth + 1); return; }
      }
    }
    for (const child of node.childNodes) {
      if (visited >= limits.nodes) break;
      walk(child, frameChain, depth + 1);
    }
  }
  walk(document.body || document.documentElement, []);
  // Bound retained references while keeping IDs stable for elements still on the page.
  for (const [id, ref] of state.refs) if (!ref.node.isConnected || !chainValid(ref.frames)) state.refs.delete(id);
  if (state.refs.size > 4000) {
    const live = new Set(elements.map(item => item.elementId));
    for (const id of state.refs.keys()) { if (!live.has(id)) state.refs.delete(id); if (state.refs.size <= 2000) break; }
  }
  return {
    title: document.title, url: safeUrl(location.href), text: text.join('\n'), elements, frames,
    viewport: {width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY},
    truncated: visited >= limits.nodes || elements.length >= limits.elements || textLength >= limits.text,
    ...(frames.some(frame => !frame.accessible) ? {note: 'Cross-origin frames require screenshot coordinates. Their DOM is not included.'} : {}),
  };
}
