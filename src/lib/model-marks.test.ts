import { describe, expect, it } from 'vitest';
import { modelMark } from './model-marks';
import { providers } from './domain';

describe('model marks', () => {
  it('show the version of a Claude model on its family tint', () => {
    expect(modelMark('claude', 'Opus 5.5')).toEqual({
      text: '5.5',
      color: 'var(--model-opus)',
      version: true,
    });
    expect(modelMark('claude', 'Opus 5')).toEqual({
      text: '5',
      color: 'var(--model-opus)',
      version: true,
    });
    // Opus 5 and Opus 5.5 differ; two families of the same version differ by tint.
    expect(modelMark('claude', 'Sonnet 5').color).toBe('var(--model-sonnet)');
    expect(modelMark('claude', 'Fable 5.1')).toMatchObject({
      text: '5.1',
      color: 'var(--model-fable)',
    });
    expect(modelMark('claude', 'Haiku 4.5').color).toBe('var(--model-haiku)');
    expect(modelMark('claude', 'Mythos 5').color).toBe('var(--model-mythos)');
  });
  it('fall back to the provider mark without a version', () => {
    const glyph = providers.claude.mark;
    // An alias the CLI did not resolve keeps its family tint.
    expect(modelMark('claude', 'Opus')).toEqual({
      text: glyph,
      color: 'var(--model-opus)',
      version: false,
    });
    for (const name of ['CLI default', 'claude-3-5-sonnet-20241022', 'Claude-3-5-Sonnet'])
      expect(modelMark('claude', name)).toEqual({
        text: glyph,
        color: providers.claude.color,
        version: false,
      });
    // A family this app does not know yet still shows its version, on the provider tint.
    expect(modelMark('claude', 'Poet 5')).toEqual({
      text: '5',
      color: providers.claude.color,
      version: true,
    });
  });
  it('show other providers’ versions on their own tint', () => {
    expect(modelMark('codex', 'GPT-5.6 Sol')).toEqual({
      text: '5.6',
      color: providers.codex.color,
      version: true,
    });
    expect(modelMark('codex', 'GPT-6-Astra').text).toBe('6');
    expect(modelMark('gemini', 'Gemini 3.8 Flash').text).toBe('3.8');
    expect(modelMark('codex', 'CLI default')).toEqual({
      text: providers.codex.mark,
      color: providers.codex.color,
      version: false,
    });
    expect(modelMark('codex', 'build-20260927').version).toBe(false);
  });
});
