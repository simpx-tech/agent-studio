import { describe, expect, it } from 'vitest';
import {
  keepsRunning,
  trayPlace,
  windowBehaviorSchema,
  type WindowBehavior,
} from './window-behavior';

const windows: WindowBehavior = { closeToTray: true, area: 'tray', clickOpens: true };

describe('window behavior', () => {
  it('names where the icon lives on each platform', () => {
    const mac: WindowBehavior = { closeToTray: true, area: 'menuBar', clickOpens: false };
    expect(trayPlace(mac)).toBe('menu bar');
    expect(trayPlace(windows)).toBe('system tray');
  });

  it('quits on close when turned off or when the computer has no tray', () => {
    const off = { ...windows, closeToTray: false };
    expect(keepsRunning(windows)).toBe(true);
    expect(keepsRunning(off)).toBe(false);
    const missing = {
      ...windows,
      unavailable:
        'The system tray is unavailable on this computer, so closing the window quits Agent Studio.',
    };
    expect(keepsRunning(missing)).toBe(false);
  });

  it('accepts only the reported shape, with a reason of any length', () => {
    expect(windowBehaviorSchema.parse(windows)).toEqual(windows);
    expect(() => windowBehaviorSchema.parse({ ...windows, area: 'dock' })).toThrow();
    expect(() => windowBehaviorSchema.parse({ closeToTray: true, area: 'tray' })).toThrow();
    expect(() => windowBehaviorSchema.parse({ ...windows, unavailable: 1 })).toThrow();
    const long = { ...windows, unavailable: 'x'.repeat(5000) };
    expect(windowBehaviorSchema.parse(long)).toEqual(long);
  });
});
