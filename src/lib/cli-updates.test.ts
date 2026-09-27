import { describe, expect, it } from 'vitest';
import { cliUpdateSummary, cliUpdatesSchema, newlyUpdated, type CliUpdates } from './cli-updates';

const at = new Date(2026, 8, 27, 12, 40).getTime();
const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

describe('Claude Code updates', () => {
  it('describes each installation’s last check', () => {
    expect(
      cliUpdateSummary({
        environmentId: 'windows',
        phase: 'updated',
        version: '2.1.283',
        previous: '2.1.278',
        checkedAt: at,
      }),
    ).toBe(`Updated from 2.1.278 to 2.1.283 at ${clock}.`);
    expect(cliUpdateSummary({ environmentId: 'windows', phase: 'current', checkedAt: at })).toBe(
      `Up to date. Checked ${clock}.`,
    );
    expect(
      cliUpdateSummary({
        environmentId: 'windows',
        phase: 'current',
        message: 'The stable channel is at 2.1.270. Staying on 2.1.278.',
      }),
    ).toBe('The stable channel is at 2.1.270. Staying on 2.1.278.');
    expect(cliUpdateSummary({ environmentId: 'windows', phase: 'checking' })).toContain('Checking');
    expect(cliUpdateSummary({ environmentId: 'windows', phase: 'failed', message: 'EPERM' })).toBe(
      'The last update did not finish: EPERM',
    );
    expect(
      cliUpdateSummary({
        environmentId: 'windows',
        phase: 'managed',
        message: 'Claude is managed by winget.',
      }),
    ).toBe('Claude is managed by winget.');
  });
  it('reports each finished update once', () => {
    const reading = (checkedAt: number, phase: 'updated' | 'current' = 'updated'): CliUpdates => ({
      automatic: true,
      statuses: [{ environmentId: 'windows', phase, version: '2.1.283', checkedAt }],
    });
    expect(newlyUpdated(undefined, reading(1))).toEqual(['windows']);
    expect(newlyUpdated(reading(1), reading(1))).toEqual([]);
    expect(newlyUpdated(reading(1), reading(2))).toEqual(['windows']);
    expect(newlyUpdated(undefined, reading(1, 'current'))).toEqual([]);
  });
  it('accepts only bounded native readings', () => {
    expect(cliUpdatesSchema.safeParse({ automatic: true, statuses: [] }).success).toBe(true);
    expect(
      cliUpdatesSchema.safeParse({
        automatic: true,
        statuses: [{ environmentId: 'windows', phase: 'unknown' }],
      }).success,
    ).toBe(false);
    expect(
      cliUpdatesSchema.safeParse({
        automatic: true,
        statuses: [{ environmentId: 'windows', phase: 'failed', message: 'x'.repeat(301) }],
      }).success,
    ).toBe(false);
  });
});
