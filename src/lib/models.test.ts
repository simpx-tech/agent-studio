import { describe, expect, it } from 'vitest';
import { reasoningName, reasoningScale } from './models';

describe('reasoning scale', () => {
  it('starts with Default and orders levels from the least to the most', () => {
    expect(reasoningScale(['low', 'medium', 'high', 'xhigh', 'max'], '')).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // A catalog may list its levels in any order.
    expect(reasoningScale(['high', 'minimal', 'xhigh', 'low', 'medium'], 'medium')).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('keeps a chat level the model no longer lists in its place', () => {
    expect(reasoningScale(['low', 'high'], 'medium')).toEqual(['', 'low', 'medium', 'high']);
    expect(reasoningScale([], 'ultra')).toEqual(['', 'ultra']);
  });

  it('leaves out levels it has no name for', () => {
    expect(reasoningScale(['low', 'turbo', 'high'], '')).toEqual(['', 'low', 'high']);
    for (const level of reasoningScale(
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      '',
    ))
      expect(reasoningName(level)).toBeTruthy();
  });

  it('is only Default for a model without levels', () => {
    expect(reasoningScale([], '')).toEqual(['']);
  });
});
