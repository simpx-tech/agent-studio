import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);

// Keep streaming renders bounded; unsupported or large blocks use Marked's escaped fallback.
const maxHighlightedCodeLength = 64 * 1024;
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang?.trim().split(/\s+/, 1)[0].toLowerCase();
      if (
        !language ||
        !/^[a-z0-9_+#.-]+$/.test(language) ||
        !hljs.getLanguage(language) ||
        text.length > maxHighlightedCodeLength
      )
        return false;
      try {
        const highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        return `<pre><code class="hljs language-${language}">${highlighted}\n</code></pre>\n`;
      } catch {
        return false;
      }
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
