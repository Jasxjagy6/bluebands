/* The select stays in place. Only its popup is replaced. */
(() => {
  'use strict';
  if (typeof window.HTMLDialogElement?.prototype.showModal !== 'function') return;

  const phone = matchMedia('(max-width: 740px)');
  const dialog = document.createElement('dialog');
  dialog.className = 'eb-option-picker';
  dialog.setAttribute('aria-labelledby', 'eb-option-title');
  dialog.innerHTML = `<div class="eb-option-head"><h2 id="eb-option-title"><span></span></h2><button class="eb-option-close" type="button" aria-label="Close options"></button></div>
    <div id="eb-option-list" role="listbox" aria-labelledby="eb-option-title" tabindex="0" autofocus></div>`;
  const title = dialog.querySelector('h2 span');
  const closeButton = dialog.querySelector('button');
  const list = dialog.querySelector('[role=listbox]');
  const optionFor = new WeakMap();
  let current = null;
  let frame = 0;

  const single = el => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1;
  const available = el => el && !el.matches(':disabled, [aria-disabled="true"]');
  const visibleOption = opt => !opt.hidden && !opt.parentElement?.matches('optgroup[hidden]');
  const focus = el => el?.focus({preventScroll: true});
  const selected = select => select.options[select.selectedIndex] || null;

  function enhance(select) {
    select.classList.toggle('eb-option-trigger', single(select));
    if (!single(select)) return;
    // The game verifier uses a visual field label above a select (sometimes above a row).
    const label = select.closest('.pff')?.querySelector(':scope > label:not([for])');
    if (label && !label.control && select.id && !select.labels.length) label.htmlFor = select.id;
  }

  function scan(root) {
    if (root instanceof HTMLSelectElement) enhance(root);
    else if (root.childElementCount && root !== dialog && !dialog.contains(root)) {
      root.querySelectorAll('select').forEach(enhance);
    }
  }
  scan(document.documentElement);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLSelectElement) enhance(record.target);
      } else if (!(record.target instanceof HTMLSelectElement) && !dialog.contains(record.target)) {
        for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
      }
    }
    if (current && !current.select.isConnected) close(false);
  }).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['multiple', 'size']});

  function labelText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (!(node instanceof Element) || node === dialog || node.matches('select, input, textarea, button, script, style, [aria-hidden="true"]')) return '';
    return node.getAttribute('aria-label') || node.getAttribute('alt') || Array.from(node.childNodes, labelText).join('');
  }

  function labels(select) {
    const refs = (select.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    return refs.map(id => document.getElementById(id)).filter(Boolean);
  }

  function fieldName(select) {
    const text = els => Array.from(els, labelText).join(' ').replace(/\s+/g, ' ').trim();
    return text(labels(select)) || select.getAttribute('aria-label') || text(select.labels) || select.title || select.name || 'Select an option';
  }

  function reveal(row) {
    if (!row || !dialog.open) return;
    // scrollIntoView() can also scroll the account pane or its fixed-header shell.
    const box = list.getBoundingClientRect(), item = row.getBoundingClientRect();
    if (item.top < box.top) list.scrollTop += item.top - box.top;
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
  }

  function highlight(opt) {
    const {rows, active} = current;
    rows.get(active)?.removeAttribute('data-active');
    current.active = opt;
    const row = rows.get(opt);
    if (!row) { list.removeAttribute('aria-activedescendant'); return; }
    row.setAttribute('data-active', '');
    list.setAttribute('aria-activedescendant', row.id);
    reveal(row);
    if (dialog.open) scrollCue();
  }

  function render() {
    const {select, active, lastSelected} = current;
    const choice = selected(select), rows = new Map(), choices = [], fragment = document.createDocumentFragment();
    let group = null, parent = fragment;
    for (const opt of select.options) {
      if (!visibleOption(opt)) continue;
      const nextGroup = opt.parentElement instanceof HTMLOptGroupElement ? opt.parentElement : null;
      if (group !== nextGroup) {
        group = nextGroup;
        parent = fragment;
        if (group) {
          parent = document.createElement('div');
          parent.setAttribute('role', 'group');
          parent.setAttribute('aria-label', group.label);
          const heading = document.createElement('div');
          heading.className = 'eb-option-group';
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = group.label;
          parent.append(heading);
          fragment.append(parent);
        }
      }
      const row = document.createElement('div');
      row.id = list.id + '-item-' + rows.size;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(opt === choice));
      if (available(opt)) choices.push(opt);
      else row.setAttribute('aria-disabled', 'true');
      row.textContent = opt.label;
      parent.append(row);
      rows.set(opt, row);
      optionFor.set(row, opt);
    }
    if (!rows.size) {
      const empty = document.createElement('div');
      empty.className = 'eb-option-empty';
      empty.textContent = 'No options available';
      fragment.append(empty);
    }
    title.textContent = fieldName(select);
    list.replaceChildren(fragment);
    Object.assign(current, {rows, choices, lastSelected: choice});
    highlight(lastSelected === choice && choices.includes(active) ? active : choices.includes(choice) ? choice : choices[0]);
  }

  function scrollPane(anchor) {
    // Account, operator and game dialogs have their own scrollports. Never scroll the document.
    for (let el = anchor.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (/^(auto|scroll|overlay)$/.test(style.overflowY) && el.clientHeight &&
          (el.scrollHeight > el.clientHeight || el.matches('#pageScroll, #workspaceScroll, .main, .account-main, .pfbody, dialog'))) return el;
      if (style.position === 'fixed') break;
    }
    return null;
  }

  function makeRoom(amount) {
    const {pane} = current;
    if (!pane || amount < 1) return;
    current.originalScroll ??= pane.scrollTop;
    if (amount > pane.scrollHeight - pane.clientHeight - pane.scrollTop) {
      // A last-field trigger at the scroll limit needs temporary trailing space, not an upward menu.
      if (!current.spacer) {
        current.spacer = document.createElement('div');
        current.spacer.className = 'eb-option-space';
        current.spacer.setAttribute('aria-hidden', 'true');
        pane.append(current.spacer);
      }
      const gap = pane.getBoundingClientRect().top + pane.clientTop + pane.clientHeight - current.spacer.getBoundingClientRect().top;
      current.spacer.style.height = Math.ceil(Math.max(current.spacer.offsetHeight, amount + gap + 1)) + 'px';
    }
    pane.scrollTo({top: pane.scrollTop + amount, behavior: 'instant'});
  }

  function scrollCue() {
    dialog.toggleAttribute('data-above', list.scrollTop > 2);
    dialog.toggleAttribute('data-more', list.scrollHeight - list.clientHeight - list.scrollTop > 2);
  }

  function position() {
    if (!current || !dialog.open) return;
    const {select, anchor, pane} = current, view = window.visualViewport, gap = 4, edge = 8;
    const x = view?.offsetLeft || 0, y = view?.offsetTop || 0;
    const width = view?.width || document.documentElement.clientWidth, height = view?.height || innerHeight;
    let r = anchor.getBoundingClientRect();
    const maxWidth = Math.max(1, width - 2 * edge);
    dialog.style.minWidth = Math.min(maxWidth, Math.max(r.width, 164)) + 'px';
    dialog.style.maxWidth = Math.min(maxWidth, Math.max(r.width, 340)) + 'px';
    const paneTop = pane?.getBoundingClientRect().top ?? y;
    const head = pane ? 0 : document.querySelector('.top, .masthead')?.getBoundingClientRect().bottom || 0;
    let safeTop = Math.max(y + edge, head + 2, paneTop + (parseFloat(getComputedStyle(select).scrollMarginTop) || 2));
    const floor = y + height - edge;
    const shell = select.closest('#pageScroll, #workspaceScroll, .main');
    let bottom = Math.min(floor, shell ? shell.getBoundingClientRect().bottom - 4 : floor);
    // Use the last strip over the inert bottom navigation when the keyboard leaves only one row.
    if (bottom - safeTop - r.height - gap < 100) bottom = floor;
    const clearTop = Math.max(y + edge, head + 2, paneTop + 2);
    if (bottom - safeTop - r.height - gap < 80 && clearTop < safeTop) {
      // Let the field stand in front of a sticky subnav in keyboard-sized viewports,
      // but keep it inside its pane and below the fixed masthead.
      safeTop = clearTop;
      anchor.classList.add('eb-option-raised');
    }
    const required = Math.min(dialog.firstElementChild.offsetHeight + list.scrollHeight + 2, 212,
      Math.max(0, bottom - safeTop - r.height - gap));
    makeRoom(Math.min(r.top - safeTop, required - (bottom - r.bottom - gap)));
    r = anchor.getBoundingClientRect();
    if (bottom - r.bottom - gap < Math.min(required, 104)) {
      // A fixed/sticky field without usable scroll travel can move; the masthead never does.
      const lift = Math.min(r.top - safeTop, required - (bottom - r.bottom - gap));
      if (lift >= 1) {
        current.lift += lift;
        anchor.style.setProperty('--eb-option-lift', -current.lift + 'px');
        anchor.classList.add('eb-option-lifted');
        r = anchor.getBoundingClientRect();
      }
    }
    const top = r.bottom + gap, room = Math.max(0, bottom - top);
    dialog.toggleAttribute('data-compact', room < 152);
    dialog.toggleAttribute('data-tight', room < 84);
    const w = dialog.offsetWidth, left = r.left + w <= x + width - edge && getComputedStyle(anchor).direction !== 'rtl' ? r.left : r.right - w;
    dialog.style.left = Math.max(x + edge, Math.min(left, x + width - edge - w)) + 'px';
    dialog.style.top = top + 'px';
    dialog.style.maxHeight = Math.min(340, room) + 'px';
    reveal(current.rows.get(current.active));
    scrollCue();
  }

  function sync() {
    if (!current) return;
    const {select, rows, choices, lastSelected} = current;
    if (!select.isConnected || !single(select) || !available(select) || select.closest('[hidden], [inert], dialog:not([open])')) {
      close(false);
      return;
    }
    // IDL writes (select.value, selectedIndex, option.selected) do not emit a DOM event.
    // Only the open picker needs a check; closed controls are the real selects.
    const choice = selected(select);
    if (choice !== lastSelected) {
      rows.get(lastSelected)?.setAttribute('aria-selected', 'false');
      rows.get(choice)?.setAttribute('aria-selected', 'true');
      current.lastSelected = choice;
      highlight(choices.includes(choice) ? choice : choices[0]);
    }
    frame = requestAnimationFrame(sync);
  }

  function open(select, keyboard = false) {
    if (!single(select) || !select.isConnected || !available(select)) return false;
    if (current?.select === select) return true;
    if (current) close(false);
    if (!select.classList.contains('eb-option-trigger')) enhance(select);
    const host = select.closest('dialog[open], [role="dialog"]') || document.body;
    host.append(dialog);
    dialog.removeAttribute('style');
    dialog.removeAttribute('data-compact');
    dialog.removeAttribute('data-tight');
    dialog.toggleAttribute('data-keyboard', keyboard);
    const anchor = select.closest('.wallet-select') || select;
    current = {select, anchor, pane: scrollPane(anchor), lift: 0, controls: select.getAttribute('aria-controls'), expanded: select.getAttribute('aria-expanded'), buffer: '', typed: 0};
    render();
    focus(select);
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', [current.controls, list.id].filter(Boolean).join(' '));
    dialog.showModal();
    position();
    focus(list);
    highlight(current.active);
    const observer = new MutationObserver(records => {
      if (current?.select !== select || records.every(r => dialog.contains(r.target))) return;
      render(); position();
    });
    const watched = {subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'selected', 'hidden', 'value', 'label', 'aria-label', 'aria-labelledby', 'title']};
    observer.observe(select, watched);
    for (const label of [...select.labels, ...labels(select)]) observer.observe(label, watched);
    current.observer = observer;
    frame = requestAnimationFrame(sync);
    return true;
  }

  function close(restore = true) {
    if (!current) return;
    const {select, anchor, observer, controls, expanded, pane, originalScroll, spacer, lift} = current;
    current = null;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    if (dialog.open) dialog.close();
    anchor.classList.remove('eb-option-raised');
    if (lift) { anchor.classList.remove('eb-option-lifted'); anchor.style.removeProperty('--eb-option-lift'); }
    spacer?.remove();
    if (restore && select.isConnected && originalScroll != null) pane.scrollTo({top: originalScroll, behavior: 'instant'});
    if (controls === null) select.removeAttribute('aria-controls'); else select.setAttribute('aria-controls', controls);
    if (expanded === null) select.removeAttribute('aria-expanded'); else select.setAttribute('aria-expanded', expanded);
    dialog.remove();
    list.replaceChildren();
    if (restore && select.isConnected && available(select)) focus(select);
  }

  function commit(opt) {
    const {select} = current;
    if (!select.isConnected || !single(select) || !available(select)) { close(false); return; }
    if (!opt || opt.closest('select') !== select || !available(opt) || !visibleOption(opt)) return;
    const changed = selected(select) !== opt;
    select.selectedIndex = opt.index;
    close();
    if (!changed) return;
    select.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    select.dispatchEvent(new Event('change', {bubbles: true}));
    // A change handler can replace the entire field, notably the deposit network.
    if (!select.isConnected && select.id && document.activeElement === document.body) {
      const replacement = document.getElementById(select.id);
      if (single(replacement) && available(replacement)) focus(replacement);
    }
  }

  function typeahead(key) {
    const now = performance.now(), {choices, active} = current;
    const old = now - current.typed < 700 ? current.buffer : '';
    const buffer = old + key.toLocaleLowerCase();
    const cycle = Array.from(buffer).every(ch => ch === buffer[0]);
    const prefix = cycle ? buffer[0] : buffer, start = Math.max(0, choices.indexOf(active) + (cycle ? 1 : 0));
    current.buffer = prefix; current.typed = now;
    for (let offset = 0; offset < choices.length; offset++) {
      const opt = choices[(start + offset) % choices.length];
      if (opt.label.trimStart().toLocaleLowerCase().startsWith(prefix)) { highlight(opt); break; }
    }
  }

  const printable = e => !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && e.key.length === 1;
  const openKeys = ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'F4'];
  // Browser/platform combinations activate selects on different mouse events. Cancel
  // the early default, but wait for a completed click so a touch scroll never opens it.
  for (const type of ['pointerdown', 'mousedown']) document.addEventListener(type, e => {
    if (e.button === 0 && single(e.target)) e.preventDefault();
  }, true);
  document.addEventListener('click', e => {
    if (e.button !== 0 || !single(e.target) || e.defaultPrevented) return;
    e.preventDefault(); open(e.target, !e.pointerType && e.detail === 0);
  });
  document.addEventListener('keydown', e => {
    if (!single(e.target) || e.defaultPrevented || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (!openKeys.includes(e.key) && !printable(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (!open(e.target, true)) return;
    if (e.key === 'Home') highlight(current.choices[0]);
    else if (e.key === 'End') highlight(current.choices.at(-1));
    else if (printable(e) && e.key !== ' ') typeahead(e.key);
  });
  document.addEventListener('keyup', e => {
    if (single(e.target) && openKeys.includes(e.key)) e.preventDefault();
  });

  dialog.addEventListener('keydown', e => {
    if (!current || e.isComposing) return;
    dialog.setAttribute('data-keyboard', '');
    const {choices, active} = current;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      e.stopPropagation();
      if (phone.matches) { e.preventDefault(); focus(document.activeElement === list ? closeButton : list); }
      else if (document.activeElement === list && active) commit(active);
      else close(); // Native Tab navigation continues from the restored select.
      return;
    }
    if (e.target !== list || e.ctrlKey || e.metaKey) return;
    const index = choices.indexOf(active);
    if (e.key === 'ArrowDown' && !e.altKey) highlight(choices[Math.min(index + 1, choices.length - 1)]);
    else if (e.key === 'ArrowUp' && !e.altKey) highlight(choices[Math.max(0, index - 1)]);
    else if (e.key === 'Home') highlight(choices[0]);
    else if (e.key === 'End') highlight(choices.at(-1));
    else if (e.key === ' ' && current.buffer && performance.now() - current.typed < 700) typeahead(e.key);
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'F4' || (e.altKey && e.key === 'ArrowUp')) {
      if (active) commit(active); else close();
    } else if (printable(e)) typeahead(e.key);
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  let outsideDown = false;
  function onBackdrop(e) {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom;
  }
  dialog.addEventListener('pointerdown', e => { dialog.removeAttribute('data-keyboard'); outsideDown = onBackdrop(e); });
  dialog.addEventListener('click', e => {
    e.stopPropagation();
    if (!current) return;
    if (e.target === closeButton || (outsideDown && onBackdrop(e))) { close(); return; }
    const row = e.target.closest('[role=option]');
    if (row) commit(optionFor.get(row));
  });
  for (const type of ['touchmove', 'wheel']) dialog.addEventListener(type, e => {
    if (!list.contains(e.target) && e.cancelable) e.preventDefault();
  }, {passive: false});
  list.addEventListener('scroll', scrollCue, {passive: true});
  window.addEventListener('resize', position);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  window.addEventListener('scroll', e => { if (current && e.target !== list) position(); }, true);
})();
