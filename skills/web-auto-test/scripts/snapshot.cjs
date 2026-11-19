'use strict';

/**
 * Evaluates in browser context to collect visible interactive elements,
 * assign ephemeral `data-webtest-ref="eN"` markers for exact targeting,
 * and return a compact page state summary for AI agents.
 */
async function capturePageSnapshot(page, options = {}) {
  const maxElements = Number(options.maxElements || 120);
  const maxTextChars = Number(options.maxTextChars || 2500);

  return page.evaluate(({ maxElements: limit, maxTextChars: textLimit }) => {
    // Clear previous refs
    document.querySelectorAll('[data-webtest-ref]').forEach((el) => {
      el.removeAttribute('data-webtest-ref');
    });

    const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'OPTION']);
    const INTERACTIVE_ROLES = new Set([
      'button',
      'link',
      'tab',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'checkbox',
      'radio',
      'switch',
      'combobox',
      'textbox',
      'searchbox',
      'listbox',
      'option',
      'slider',
      'spinbutton'
    ]);

    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      // Keep elements near or within viewport (allow slightly scrolled content for discovery)
      if (rect.bottom < -200 || rect.top > window.innerHeight + 1200) return false;
      return true;
    }

    function normalizeText(str, maxLen = 80) {
      const cleaned = String(str || '').replace(/\s+/g, ' ').trim();
      if (cleaned.length <= maxLen) return cleaned;
      return cleaned.slice(0, maxLen - 1) + '…';
    }

    function getAccessibleName(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return normalizeText(ariaLabel);

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => {
            const target = document.getElementById(id);
            return target ? target.innerText || target.textContent : '';
          })
          .filter(Boolean);
        if (parts.length) return normalizeText(parts.join(' '));
      }

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) {
            const labelText = normalizeText(label.innerText || label.textContent);
            if (labelText) return labelText;
          }
        }
        const parentLabel = el.closest('label');
        if (parentLabel) {
          const labelText = normalizeText(parentLabel.innerText || parentLabel.textContent);
          if (labelText) return labelText;
        }
        if (el.getAttribute('placeholder')) return normalizeText(el.getAttribute('placeholder'));
        if (el.getAttribute('name')) return normalizeText(el.getAttribute('name'));
        if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) {
          return normalizeText(el.value);
        }
      }

      const title = el.getAttribute('title');
      const alt = el.getAttribute('alt');
      const text = normalizeText(el.innerText || el.textContent);
      return text || normalizeText(title) || normalizeText(alt) || '';
    }

    function isInteractive(el) {
      const tag = el.tagName;
      if (INTERACTIVE_TAGS.has(tag)) {
        if (tag === 'INPUT' && el.type === 'hidden') return false;
        return true;
      }
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (INTERACTIVE_ROLES.has(role)) return true;
      if (el.isContentEditable) return true;
      const tabIndex = el.getAttribute('tabindex');
      if (tabIndex !== null && Number(tabIndex) >= 0) return true;
      if (typeof el.onclick === 'function' || el.hasAttribute('onclick')) return true;

      // Heuristic for JS frameworks / Kuikly Web where clickable divs use cursor:pointer
      const style = window.getComputedStyle(el);
      if (style && style.cursor === 'pointer') {
        // Avoid tagging giant layout wrappers; prefer leaf-like clickable elements
        const rect = el.getBoundingClientRect();
        const text = normalizeText(el.innerText || el.textContent, 100);
        if (rect.width < window.innerWidth * 0.95 && rect.height < 160 && (text.length > 0 || el.querySelector('img,svg'))) {
          // Skip if an immediate descendant is already a native interactive control covering the same intent
          if (!el.querySelector('button, a, input, select, textarea')) {
            return true;
          }
        }
      }
      return false;
    }

    const elements = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);

    let node = walker.currentNode;
    let counter = 0;
    while (node && elements.length < limit) {
      if (isInteractive(node) && isVisible(node)) {
        // Skip redundant cursor:pointer parent if already represented by an interactive ancestor with identical text
        const rect = node.getBoundingClientRect();
        const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)},${node.tagName}`;
        if (!seen.has(key)) {
          seen.add(key);
          counter += 1;
          const ref = `e${counter}`;
          node.setAttribute('data-webtest-ref', ref);

          const tag = node.tagName.toLowerCase();
          const role = (node.getAttribute('role') || '').toLowerCase() || (tag === 'a' ? 'link' : tag);
          const inputType = tag === 'input' ? (node.type || 'text').toLowerCase() : undefined;
          const name = getAccessibleName(node);

          const entry = {
            ref: `@${ref}`,
            tag,
            role,
            name,
            rect: {
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            },
            inViewport: rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
          };

          if (inputType) entry.type = inputType;
          if (node.getAttribute('placeholder')) entry.placeholder = normalizeText(node.getAttribute('placeholder'), 60);
          if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            if (inputType === 'checkbox' || inputType === 'radio') {
              entry.checked = Boolean(node.checked);
            } else if (tag === 'select') {
              const selected = node.options[node.selectedIndex];
              entry.value = selected ? normalizeText(selected.text, 60) : '';
            } else {
              entry.hasValue = Boolean(node.value);
            }
          }
          if (tag === 'a' && node.getAttribute('href')) {
            entry.href = normalizeText(node.getAttribute('href'), 100);
          }
          if (node.disabled || node.getAttribute('aria-disabled') === 'true') {
            entry.disabled = true;
          }

          elements.push(entry);
        }
      }
      node = walker.nextNode();
    }

    // Collect headings and compact visible text digest
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter((h) => isVisible(h))
      .slice(0, 12)
      .map((h) => `${h.tagName.toLowerCase()}: ${normalizeText(h.innerText || h.textContent, 100)}`);

    const rawBodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    const lines = rawBodyText
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    let textDigest = '';
    for (const line of lines) {
      if (textDigest.length + line.length + 1 > textLimit) {
        textDigest += '\n...(truncated)';
        break;
      }
      textDigest += (textDigest ? '\n' : '') + line;
    }

    return {
      url: window.location.href,
      title: document.title || '',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0
      },
      headings,
      interactiveCount: elements.length,
      elements,
      textDigest
    };
  }, { maxElements, maxTextChars });
}

function formatSnapshotText(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`Title: ${snap.title || '(empty)'}`);
  lines.push(
    `Viewport: ${snap.viewport.width}x${snap.viewport.height} (scrollY=${snap.viewport.scrollY}/${snap.viewport.scrollHeight})`
  );

  if (snap.headings && snap.headings.length) {
    lines.push('\nHeadings:');
    for (const h of snap.headings) {
      lines.push(`  - ${h}`);
    }
  }

  lines.push(`\nInteractive Elements (${snap.interactiveCount}):`);
  for (const el of snap.elements) {
    const kind = el.type ? `${el.tag}:${el.type}` : el.role;
    const parts = [`${el.ref} [${kind}]`];
    if (el.name) parts.push(`"${el.name}"`);
    if (el.hasValue) parts.push('已填写');
    if (el.placeholder && el.placeholder !== el.name) parts.push(`placeholder="${el.placeholder}"`);
    if (el.value !== undefined && el.value !== '') parts.push(`value="${el.value}"`);
    if (el.checked !== undefined) parts.push(`checked=${el.checked}`);
    if (el.href) parts.push(`href=${el.href}`);
    if (el.disabled) parts.push('(disabled)');
    if (!el.inViewport) parts.push('(offscreen)');
    lines.push(`  ${parts.join(' ')}`);
  }

  if (snap.textDigest) {
    lines.push('\nVisible Text Digest:');
    lines.push(snap.textDigest);
  }

  return lines.join('\n');
}

module.exports = {
  capturePageSnapshot,
  formatSnapshotText
};
