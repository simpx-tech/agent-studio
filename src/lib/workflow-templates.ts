import type { conditionOps } from './workflow-model.ts';

/**
 * The text of a workflow step's fields: `{{research.output}}`, `{{input.topic}}`, `{{item.name}}`.
 * Values are substituted once, never evaluated, and a missing one becomes empty text.
 */
const placeholder = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function templatePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(placeholder))
    if (match[1] && !paths.includes(match[1])) paths.push(match[1]);
  return paths;
}

/** A value as text: objects and lists as indented JSON. */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

export function renderTemplate(text: string, resolve: (path: string) => unknown): string {
  return text.replace(placeholder, (_, path: string) => valueText(resolve(path.trim())));
}

/** A part of a JSON value by its path, `items.0.name`. */
export function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index)
        ? current[index < 0 ? current.length + index : index]
        : undefined;
    } else if (typeof current === 'object')
      current = Object.hasOwn(current, part)
        ? (current as Record<string, unknown>)[part]
        : undefined;
    else return undefined;
  }
  return current;
}

/**
 * The JSON a reply holds: all of it, or its first fenced JSON block, or the outermost object or
 * list in it. Undefined when there is none.
 */
export function replyJson(text: string): unknown {
  const attempt = (source: string) => {
    try {
      return { value: JSON.parse(source) as unknown };
    } catch {
      return undefined;
    }
  };
  const whole = attempt(text.trim());
  if (whole) return whole.value;
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) {
    const fenced = attempt(fence[1]);
    if (fenced) return fenced.value;
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const inner = attempt(text.slice(start, end + 1));
      if (inner) return inner.value;
    }
  }
  return undefined;
}

/** A loop's items: a JSON list, a list inside JSON text, or the text's non-empty lines. */
export function loopItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const lists = Object.values(value).filter(Array.isArray);
    if (lists.length === 1) return lists[0];
    return [value];
  }
  const text = valueText(value);
  if (!text.trim()) return [];
  const json = replyJson(text);
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const lists = Object.values(json).filter(Array.isArray);
    if (lists.length === 1) return lists[0];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

const number = (text: string) => {
  const value = Number(text.trim().replace(/,/g, ''));
  return text.trim() && Number.isFinite(value) ? value : undefined;
};
const truthy = (text: string) =>
  !['', 'false', 'no', '0', 'null', 'undefined', 'off'].includes(text.trim().toLowerCase());

/** Whether a Condition step's comparison holds. */
export function conditionHolds(
  op: (typeof conditionOps)[number],
  leftValue: string,
  rightValue: string,
  ignoreCase: boolean,
): boolean {
  const fold = (text: string) => (ignoreCase ? text.toLocaleLowerCase() : text);
  const left = fold(leftValue);
  const right = fold(rightValue);
  switch (op) {
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'equals':
      return left.trim() === right.trim();
    case 'notEquals':
      return left.trim() !== right.trim();
    case 'matches':
      try {
        return new RegExp(rightValue, ignoreCase ? 'iu' : 'u').test(leftValue);
      } catch {
        return false;
      }
    case 'greater':
    case 'less': {
      const a = number(leftValue);
      const b = number(rightValue);
      if (a === undefined || b === undefined) return false;
      return op === 'greater' ? a > b : a < b;
    }
    case 'empty':
      return !leftValue.trim();
    case 'notEmpty':
      return !!leftValue.trim();
    case 'true':
      return truthy(leftValue);
  }
}
