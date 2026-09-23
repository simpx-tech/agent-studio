import { describe, expect, it } from 'vitest';
import {
  appUpdateStatusSchema,
  restartBlocked,
  updateProgress,
  updateSummary,
  type AppUpdateStatus,
} from './app-updates';

const status = (value: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  currentVersion: '0.2.0',
  phase: 'idle',
  repliesRunning: false,
  ...value,
});

describe('app updates', () => {
  it('accepts native status and rejects unknown or oversized values', () => {
    const native = {
      currentVersion: '0.2.0',
      phase: 'downloading',
      version: '0.3.0',
      downloaded: 10,
      checkedAt: Date.now(),
      repliesRunning: false,
    };
    expect(appUpdateStatusSchema.parse(native)).toEqual(native);
    expect(appUpdateStatusSchema.safeParse({ ...native, phase: 'paused' }).success).toBe(false);
    expect(appUpdateStatusSchema.safeParse({ ...native, notes: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(appUpdateStatusSchema.safeParse({ ...native, downloaded: -1 }).success).toBe(false);
    expect(appUpdateStatusSchema.safeParse({ ...native, repliesRunning: undefined }).success).toBe(
      false,
    );
  });

  it('reports download progress only when the size is known', () => {
    expect(updateProgress(status({ phase: 'downloading', downloaded: 5 }))).toBeUndefined();
    expect(updateProgress(status({ phase: 'downloading', downloaded: 0, total: 0 }))).toBe(
      undefined,
    );
    expect(updateProgress(status({ phase: 'downloading', downloaded: 999, total: 1000 }))).toBe(99);
    expect(updateProgress(status({ phase: 'downloading', downloaded: 20, total: 10 }))).toBe(100);
    expect(
      updateSummary(status({ phase: 'downloading', version: '0.3.0', downloaded: 1, total: 4 })),
    ).toBe('Downloading version 0.3.0 (25%)');
    expect(updateSummary(status({ phase: 'downloading', version: '0.3.0' }))).toBe(
      'Downloading version 0.3.0…',
    );
  });

  it('summarizes every phase without inventing versions', () => {
    expect(updateSummary(status({ phase: 'ready', version: '0.3.0' }))).toBe(
      'Version 0.3.0 is ready. Restart Agent Studio to finish updating.',
    );
    expect(updateSummary(status({ phase: 'ready' }))).toBe(
      'An update is ready. Restart Agent Studio to finish updating.',
    );
    expect(updateSummary(status({ phase: 'current' }))).toBe('Agent Studio is up to date.');
    expect(updateSummary(status({ phase: 'unavailable', message: 'Development build.' }))).toBe(
      'Development build.',
    );
    for (const phase of appUpdateStatusSchema.shape.phase.options)
      expect(updateSummary(status({ phase }))).toBeTruthy();
  });

  it('allows restarting only for a ready update with no local reply running', () => {
    expect(restartBlocked(status({ phase: 'ready', version: '0.3.0' }))).toBeUndefined();
    expect(restartBlocked(status({ phase: 'ready', repliesRunning: true }))).toMatch(/replies/);
    expect(restartBlocked(status({ phase: 'installing' }))).toMatch(/Installing/);
    expect(restartBlocked(status({ phase: 'downloading' }))).toMatch(/No update/);
    expect(restartBlocked(undefined)).toMatch(/No update/);
  });
});
