import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Global stylesheets and component <style> blocks.
function styleSources() {
  return readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.css') || file.endsWith('.svelte'))
    .map((file) => {
      const text = readFileSync(join('src', file), 'utf8');
      const css = file.endsWith('.css')
        ? text
        : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
            .map((match) => match[1])
            .join('\n');
      return { file, css: css.replace(/\/\*[\s\S]*?\*\//g, '') };
    });
}

// Each selector of every rule prelude, split on commas outside parentheses.
function selectors(css: string) {
  const found: string[] = [];
  for (const [, prelude] of css.matchAll(/([^{};]+)\{/g)) {
    if (prelude.trim().startsWith('@')) continue;
    let depth = 0;
    let start = 0;
    for (let i = 0; i < prelude.length; i++) {
      if (prelude[i] === '(') depth++;
      else if (prelude[i] === ')') depth--;
      else if (prelude[i] === ',' && depth === 0) {
        found.push(prelude.slice(start, i).trim());
        start = i + 1;
      }
    }
    found.push(prelude.slice(start).trim());
  }
  return found;
}

function withoutHasArguments(selector: string) {
  let result = '';
  for (let i = 0; i < selector.length; i++) {
    if (!selector.startsWith(':has(', i)) {
      result += selector[i];
      continue;
    }
    let depth = 0;
    for (i += 4; i < selector.length; i++) {
      if (selector[i] === '(') depth++;
      else if (selector[i] === ')' && --depth === 0) break;
    }
  }
  return result;
}

describe('style selectors', () => {
  it('never pair :has() with a selector that matches every element', () => {
    // Chromium caches :has() only within one style recalculation, so `.app-shell:has(…) *`
    // searched the whole app for each hover, transition frame and disclosure toggle.
    const broad = styleSources().flatMap(({ file, css }) =>
      selectors(css)
        .filter((selector) => selector.includes(':has('))
        .filter((selector) => /(^|[\s>+~(])\*/.test(withoutHasArguments(selector)))
        .map((selector) => `${file}: ${selector}`),
    );
    expect(broad).toEqual([]);
  });
});
