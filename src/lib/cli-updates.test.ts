import { describe, expect, it } from 'vitest';
import {
  cliName,
  cliUpdateSummary,
  cliUpdatesSchema,
  newlyUpdated,
  type CliUpdates,
} from './cli-updates';

const at = new Date(2026, 8, 27, 12, 40).getTime();
const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const automatic = { claude: true, codex: true };

describe('CLI updates', () => {
  it('describes each installation’s last check', () => {
    expect(
      cliUpdateSummary({
        provider: 'claude',
        environmentId: 'windows',
        phase: 'updated',
        version: '2.1.283',
        previous: '2.1.278',
        checkedAt: at,
      }),
    ).toBe(`Updated from 2.1.278 to 2.1.283 at ${clock}.`);
    expect(
      cliUpdateSummary({
        provider: 'codex',
        environmentId: 'windows',
        phase: 'current',
        checkedAt: at,
      }),
    ).toBe(`Up to date. Checked ${clock}.`);
    expect(
      cliUpdateSummary({
        provider: 'claude',
        environmentId: 'windows',
        phase: 'current',
        message: 'The stable channel is at 2.1.270. Staying on 2.1.278.',
      }),
    ).toBe('The stable channel is at 2.1.270. Staying on 2.1.278.');
    expect(
      cliUpdateSummary({ provider: 'codex', environmentId: 'windows', phase: 'checking' }),
    ).toBe('Checking for a newer Codex…');
    expect(
      cliUpdateSummary({
        provider: 'claude',
        environmentId: 'windows',
        phase: 'failed',
        message: 'EPERM',
      }),
    ).toBe('The last update did not finish: EPERM');
    expect(cliUpdateSummary({ provider: 'codex', environmentId: 'windows', phase: 'failed' })).toBe(
      'The last update did not finish: Codex could not update.',
    );
    for (const phase of ['waiting', 'managed'] as const)
      expect(
        cliUpdateSummary({
          provider: 'codex',
          environmentId: 'windows',
          phase,
          message: 'Codex 0.157.1 is available.',
        }),
      ).toBe('Codex 0.157.1 is available.');
    expect(cliName('claude')).toBe('Claude Code');
  });
  it('reports each finished update once, by CLI', () => {
    const reading = (
      checkedAt: number,
      phase: 'updated' | 'current' = 'updated',
      provider: 'claude' | 'codex' = 'claude',
    ): CliUpdates => ({
      automatic,
      statuses: [{ provider, environmentId: 'windows', phase, version: '2.1.283', checkedAt }],
    });
    const windows = (provider: 'claude' | 'codex') => [{ provider, environmentId: 'windows' }];
    expect(newlyUpdated(undefined, reading(1))).toEqual(windows('claude'));
    expect(newlyUpdated(reading(1), reading(1))).toEqual([]);
    expect(newlyUpdated(reading(1), reading(2))).toEqual(windows('claude'));
    expect(newlyUpdated(undefined, reading(1, 'current'))).toEqual([]);
    // Claude Code's earlier update does not hide Codex's in the same environment.
    expect(newlyUpdated(reading(1), reading(1, 'updated', 'codex'))).toEqual(windows('codex'));
  });
  it('accepts only well-formed native readings, of any number and length', () => {
    expect(cliUpdatesSchema.safeParse({ automatic, statuses: [] }).success).toBe(true);
    const failed = { provider: 'codex', environmentId: 'windows', phase: 'failed' } as const;
    const long = {
      automatic,
      notice: 'n'.repeat(5000),
      statuses: Array.from({ length: 100 }, (_, i) => ({
        ...failed,
        environmentId: `wsl-${i}`,
        message: 'x'.repeat(5000),
      })),
    };
    expect(cliUpdatesSchema.parse(long)).toEqual(long);
    for (const statuses of [
      [{ provider: 'claude', environmentId: 'windows', phase: 'unknown' }],
      [{ provider: 'gemini', environmentId: 'windows', phase: 'current' }],
      [{ ...failed, checkedAt: -1 }],
    ])
      expect(cliUpdatesSchema.safeParse({ automatic, statuses }).success).toBe(false);
    expect(cliUpdatesSchema.safeParse({ automatic: true, statuses: [] }).success).toBe(false);
  });
});
