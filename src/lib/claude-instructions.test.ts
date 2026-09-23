import { describe, expect, it } from 'vitest';
import {
  claudeInstructions,
  claudeInstructionsSchema,
  defaultClaudeInstructions,
  maxClaudeInstructions,
  storedClaudeInstructions,
} from './claude-instructions';
import { initialWorkspace, restoreWorkspace } from './domain';
import { emptyShared, mergeShared, sharedSchema, sharedWorkspace } from './sync';

describe('Claude chat instructions', () => {
  it('follow the default until edited, and an empty value turns them off', () => {
    const workspace = initialWorkspace();
    expect(claudeInstructions(workspace)).toBe(defaultClaudeInstructions);
    expect(defaultClaudeInstructions).toContain('run_in_background');
    workspace.claudeInstructions = '';
    expect(claudeInstructions(workspace)).toBe('');
    expect(storedClaudeInstructions(defaultClaudeInstructions)).toBeUndefined();
    expect(storedClaudeInstructions('Custom')).toBe('Custom');
    expect(storedClaudeInstructions('')).toBe('');
  });
  it('bound stored text and round-trip through storage, exports and relay schemas', () => {
    expect(claudeInstructionsSchema.safeParse('é'.repeat(maxClaudeInstructions)).success).toBe(
      true,
    );
    for (const invalid of ['x'.repeat(maxClaudeInstructions + 1), 'null\0'])
      expect(claudeInstructionsSchema.safeParse(invalid).success).toBe(false);
    const old = initialWorkspace();
    expect(restoreWorkspace(JSON.parse(JSON.stringify(old))).claudeInstructions).toBeUndefined();
    old.claudeInstructions = 'Line one\nLine "two"';
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(old)));
    expect(restored.claudeInstructions).toBe(old.claudeInstructions);
    expect(sharedSchema.parse(sharedWorkspace(restored)).claudeInstructions).toBe(
      old.claudeInstructions,
    );
  });
  it('merge the side that changed and keep an unedited default absent', () => {
    const base = emptyShared();
    const edited = { ...base, claudeInstructions: 'Local' };
    expect(mergeShared(base, edited, base).claudeInstructions).toBe('Local');
    expect(mergeShared(base, base, edited).claudeInstructions).toBe('Local');
    expect('claudeInstructions' in mergeShared(base, base, base)).toBe(false);
    // Resetting to the default on one device removes the custom text everywhere.
    expect('claudeInstructions' in mergeShared(edited, base, edited)).toBe(false);
    // Turning the instructions off is an explicit empty value, not the default.
    const off = { ...base, claudeInstructions: '' };
    expect(mergeShared(edited, edited, off).claudeInstructions).toBe('');
    // Concurrent edits keep this device's text, which its next save publishes.
    const remote = { ...base, claudeInstructions: 'Remote' };
    expect(mergeShared(base, edited, remote).claudeInstructions).toBe('Local');
    expect(sharedSchema.safeParse(mergeShared(base, edited, base)).success).toBe(true);
  });
});
