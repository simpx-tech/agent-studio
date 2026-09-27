import { describe, expect, it } from 'vitest';
import { modelMark } from './model-marks';
import { providers } from './domain';

describe('model marks', () => {
  it('draw each Claude line with its own icon and tint, beside its version', () => {
    const glyph = providers.claude.mark;
    expect(modelMark('claude', 'Opus 5.5')).toEqual({
      line: 'opus',
      version: '5.5',
      glyph,
      color: 'var(--model-opus)',
    });
    // Opus 5 and Opus 5.5 share their line and differ by version.
    expect(modelMark('claude', 'Opus 5')).toMatchObject({ line: 'opus', version: '5' });
    for (const [name, line, version] of [
      ['Sonnet 5', 'sonnet', '5'],
      ['Fable 5.1', 'fable', '5.1'],
      ['Haiku 4.5', 'haiku', '4.5'],
      ['Mythos 5', 'mythos', '5'],
    ])
      expect(modelMark('claude', name)).toEqual({
        line,
        version,
        glyph,
        color: `var(--model-${line})`,
      });
  });
  it('keep the line without a version and the provider glyph without a line', () => {
    const glyph = providers.claude.mark;
    // An alias the CLI did not resolve keeps its line's icon, with no version to show.
    expect(modelMark('claude', 'Opus')).toEqual({
      line: 'opus',
      glyph,
      color: 'var(--model-opus)',
    });
    for (const name of ['CLI default', 'claude-3-5-sonnet-20241022', 'Claude-3-5-Sonnet'])
      expect(modelMark('claude', name)).toEqual({ glyph, color: providers.claude.color });
    // A line this app does not know yet still shows its version, on the provider tint.
    expect(modelMark('claude', 'Poet 5')).toEqual({
      version: '5',
      glyph,
      color: providers.claude.color,
    });
  });
  it('draw named GPT and Gemini lines on their own tints and the rest on the provider’s', () => {
    const codex = { glyph: providers.codex.mark };
    expect(modelMark('codex', 'GPT-5.6 Sol')).toEqual({
      ...codex,
      line: 'sol',
      version: '5.6',
      color: 'var(--model-sol)',
    });
    expect(modelMark('codex', 'GPT-6-Astra')).toMatchObject({ line: 'astra', version: '6' });
    expect(modelMark('codex', 'gpt-6-luna-mini')).toMatchObject({ line: 'luna', version: '6' });
    expect(modelMark('codex', 'GPT-6 Terra')).toMatchObject({ line: 'terra' });
    // A GPT model of no named line, and words that merely contain a line's name.
    expect(modelMark('codex', 'GPT-5.5')).toEqual({
      ...codex,
      line: 'gpt',
      version: '5.5',
      color: providers.codex.color,
    });
    expect(modelMark('codex', 'gpt-5.5-console').line).toBe('gpt');
    expect(modelMark('codex', 'CLI default')).toEqual({ ...codex, color: providers.codex.color });
    expect(modelMark('codex', 'build-20260927')).toEqual({
      ...codex,
      color: providers.codex.color,
    });

    expect(modelMark('gemini', 'Gemini 3.8 Flash')).toEqual({
      line: 'flash',
      version: '3.8',
      glyph: providers.gemini.mark,
      color: 'var(--model-flash)',
    });
    expect(modelMark('gemini', 'gemini-3-pro-preview')).toMatchObject({
      line: 'pro',
      version: '3',
    });
    expect(modelMark('gemini', 'Gemini Experimental')).toEqual({
      line: 'gemini',
      glyph: providers.gemini.mark,
      color: providers.gemini.color,
    });
  });
});
