// Model output → safe DOM (career-mode.md §4.4). A small markdown subset is turned into HTML with every character
// escaped first, then DOMPurify sanitises it against a tight allow-list and returns a DocumentFragment (DOMPurify brings
// its own Trusted Types policy, so no raw innerHTML happens here). Links open in a new tab with rel="noopener noreferrer nofollow".
import type { DOMPurify } from 'dompurify';

let purify: DOMPurify | null = null;

export async function loadPurifier() {
  if (purify) return;
  const { default: create } = await import('dompurify');
  purify = create(window);
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(line: string) {
  return escapeHtml(line)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** The markdown subset the coach uses: paragraphs, "- " lists, "1." lists, ## headings, **bold**, [links](https://…). */
export function markdownToHtml(text: string) {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const bullet = raw.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    close();
    const heading = raw.match(/^#{1,4}\s+(.*)$/);
    if (heading) out.push(`<p class="cc-msg__heading">${inline(heading[1])}</p>`);
    else if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  close();
  return out.join('');
}

const ALLOWED = { ALLOWED_TAGS: ['p', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br'], ALLOWED_ATTR: ['href', 'class'], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i };

/** Sanitised fragment for model text; plain text until the purifier has loaded (it loads before any restore). */
export function renderModelText(target: HTMLElement, text: string) {
  if (!purify) {
    target.textContent = text;
    return;
  }
  target.replaceChildren(purify.sanitize(markdownToHtml(text), { ...ALLOWED, RETURN_DOM_FRAGMENT: true }));
}
