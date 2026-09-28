import { describe, expect, it } from 'vitest';
import {
  closeSummary,
  keepsRunning,
  trayPlace,
  windowBehaviorSchema,
  type WindowBehavior,
} from './window-behavior';

const windows: WindowBehavior = { closeToTray: true, area: 'tray', clickOpens: true };

describe('window behavior', () => {
  it('explains how to come back to the window and quit on each platform', () => {
    expect(closeSummary(windows)).toBe(
      'Closing the window keeps Agent Studio in the system tray. Click its icon to open the window again, or right-click it and choose Quit Agent Studio.',
    );
    // Linux reports no clicks on its indicator, so its menu does both.
    expect(closeSummary({ ...windows, clickOpens: false })).toBe(
      'Closing the window keeps Agent Studio in the system tray. Open the window again or quit from its icon’s menu.',
    );
    const mac: WindowBehavior = { closeToTray: true, area: 'menuBar', clickOpens: false };
    expect(trayPlace(mac)).toBe('menu bar');
    expect(closeSummary(mac)).toContain('Open the window from the Dock or the menu bar icon');
    expect(trayPlace(windows)).toBe('system tray');
  });

  it('quits on close when turned off or when the computer has no tray', () => {
    const off = { ...windows, closeToTray: false };
    expect(keepsRunning(windows)).toBe(true);
    expect(keepsRunning(off)).toBe(false);
    expect(closeSummary(off)).toBe('Closing the window quits Agent Studio and stops its replies.');
    const missing = {
      ...windows,
      unavailable:
        'The system tray is unavailable on this computer, so closing the window quits Agent Studio.',
    };
    expect(keepsRunning(missing)).toBe(false);
    expect(closeSummary(missing)).toBe(missing.unavailable);
  });

  it('accepts only the reported shape', () => {
    expect(windowBehaviorSchema.parse(windows)).toEqual(windows);
    expect(() => windowBehaviorSchema.parse({ ...windows, area: 'dock' })).toThrow();
    expect(() => windowBehaviorSchema.parse({ closeToTray: true, area: 'tray' })).toThrow();
    expect(() =>
      windowBehaviorSchema.parse({ ...windows, unavailable: 'x'.repeat(301) }),
    ).toThrow();
  });
});
