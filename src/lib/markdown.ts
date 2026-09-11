import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);

// Keep streaming renders bounded; unsupported or large blocks use Marked's escaped fallback.
const maxHighlightedCodeLength = 64 * 1024;

// Only presentation spans leave this boundary. Callers can safely display the result
// as HTML, while falling back to their normal escaped text when highlighting is unavailable.
export function highlightCode(
  text: string,
  info?: string,
): { language: string; html: string } | null {
  const language = info?.trim().split(/\s+/, 1)[0].toLowerCase();
  if (
    !language ||
    !/^[a-z0-9_+#.-]+$/.test(language) ||
    !hljs.getLanguage(language) ||
    text.length > maxHighlightedCodeLength
  )
    return null;
  try {
    const html = DOMPurify.sanitize(
      hljs.highlight(text, { language, ignoreIllegals: true }).value,
      {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class'],
        ALLOW_DATA_ATTR: false,
      },
    );
    return { language, html };
  } catch {
    return null;
  }
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const highlighted = highlightCode(text, lang);
      if (!highlighted) return false;
      return `<pre><code class="hljs language-${highlighted.language}">${highlighted.html}\n</code></pre>\n`;
    },
  },
});

export function renderMarkdown(text: string): string {
  // Sanitize after highlighting so source code remains inert in the privileged document.
  return DOMPurify.sanitize(markdown.parse(text, { async: false }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'span',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
      'hr',
      'input',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'type', 'checked', 'disabled', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
  });
}
