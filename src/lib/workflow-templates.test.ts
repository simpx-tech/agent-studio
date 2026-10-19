import { describe, expect, it } from 'vitest';
import {
  conditionHolds,
  loopItems,
  renderTemplate,
  replyJson,
  templateParts,
  templatePaths,
  valueAt,
  valueText,
} from './workflow-templates';

describe('workflow templates', () => {
  it('substitutes paths once and leaves missing values empty', () => {
    const values: Record<string, unknown> = {
      'input.topic': 'swords',
      'list.json': { items: [{ name: 'Sword' }] },
      nested: '{{input.topic}}',
    };
    const resolve = (path: string) => values[path];
    expect(renderTemplate('Make {{ input.topic }} now{{missing}}.', resolve)).toBe(
      'Make swords now.',
    );
    // A value that looks like a template stays as written.
    expect(renderTemplate('{{nested}}', resolve)).toBe('{{input.topic}}');
    expect(renderTemplate('{{list.json}}', resolve)).toBe(
      JSON.stringify({ items: [{ name: 'Sword' }] }, null, 2),
    );
    expect(templatePaths('{{a.b}} {{ a.b }} {{c}}')).toEqual(['a.b', 'c']);
  });

  it('splits text into plain parts and the values it names, for their colours', () => {
    const known = (key: string) => key === 'research';
    expect(
      templateParts(
        'From {{input.topic}}, {{ trigger.text }} and {{previous.output}}: {{research.json.title}}',
        known,
      ),
    ).toEqual([
      { text: 'From ' },
      { text: '{{input.topic}}', kind: 'input' },
      { text: ', ' },
      { text: '{{ trigger.text }}', kind: 'trigger' },
      { text: ' and ' },
      { text: '{{previous.output}}', kind: 'previous' },
      { text: ': ' },
      { text: '{{research.json.title}}', kind: 'step' },
    ]);
    // Loop items and the run's own values, and a step no key names.
    expect(
      templateParts('{{item.name}}{{index}} {{run.title}} {{now}} {{gone.output}}{{}}', known).map(
        (part) => part.kind,
      ),
    ).toEqual([
      'loop',
      'loop',
      undefined,
      'run',
      undefined,
      'run',
      undefined,
      'unknown',
      'unknown',
    ]);
    // Text without values is one plain part, and an empty text none.
    expect(templateParts('Plain {text}', known)).toEqual([{ text: 'Plain {text}' }]);
    expect(templateParts('', known)).toEqual([]);
    // Without a way to tell, every step key counts as known.
    expect(templateParts('{{anything.output}}')[0].kind).toBe('step');
  });

  it('reads parts of JSON values', () => {
    const value = { items: [{ name: 'Sword' }, { name: 'Shield' }] };
    expect(valueAt(value, ['items', '1', 'name'])).toBe('Shield');
    expect(valueAt(value, ['items', '-1', 'name'])).toBe('Shield');
    expect(valueAt(value, ['items', 'x'])).toBeUndefined();
    expect(valueAt(value, ['constructor'])).toBeUndefined();
    expect(valueText(3)).toBe('3');
  });

  it('finds the JSON in a reply', () => {
    expect(replyJson('{"a":1}')).toEqual({ a: 1 });
    expect(replyJson('Here it is:\n```json\n[1,2]\n```\nDone.')).toEqual([1, 2]);
    expect(replyJson('The result is {"ok": true} as asked.')).toEqual({ ok: true });
    expect(replyJson('no json')).toBeUndefined();
  });

  it('reads loop items from lists, JSON text and lines', () => {
    expect(loopItems(['a', 'b'])).toEqual(['a', 'b']);
    expect(loopItems('["x","y"]')).toEqual(['x', 'y']);
    expect(loopItems('{"assets":[1,2,3]}')).toEqual([1, 2, 3]);
    expect(loopItems('- Sword\n- Shield\n\n3. Bow')).toEqual(['Sword', 'Shield', 'Bow']);
    expect(loopItems('')).toEqual([]);
  });

  it('compares values', () => {
    expect(conditionHolds('contains', 'Approved: YES', 'yes', true)).toBe(true);
    expect(conditionHolds('contains', 'Approved: YES', 'yes', false)).toBe(false);
    expect(conditionHolds('equals', ' done ', 'DONE', true)).toBe(true);
    expect(conditionHolds('greater', '1,200', '1000', true)).toBe(true);
    expect(conditionHolds('less', 'x', '1', true)).toBe(false);
    expect(conditionHolds('matches', 'score: 9/10', '\\d+/10', true)).toBe(true);
    expect(conditionHolds('matches', 'x', '(', true)).toBe(false);
    expect(conditionHolds('empty', '  ', '', true)).toBe(true);
    expect(conditionHolds('true', 'false', '', true)).toBe(false);
    expect(conditionHolds('true', 'ok', '', true)).toBe(true);
  });
});
