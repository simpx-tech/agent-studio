import { z } from 'zod';

/** Whether closing the desktop window keeps Agent Studio running. See docs/BACKGROUND.md. */
export const windowBehaviorSchema = z.object({
  closeToTray: z.boolean(),
  /** The system tray, or the menu bar on macOS. */
  area: z.enum(['tray', 'menuBar']),
  /** A click on the icon opens the window (Windows); elsewhere the icon opens its menu. */
  clickOpens: z.boolean(),
  /** Why this computer shows no icon, so closing the window quits. */
  unavailable: z.string().max(300).optional(),
});
export type WindowBehavior = z.infer<typeof windowBehaviorSchema>;

/** Where the icon lives, as Settings names it. */
export const trayPlace = (behavior: WindowBehavior) =>
  behavior.area === 'menuBar' ? 'menu bar' : 'system tray';

/** Whether closing the window keeps the app running now. */
export const keepsRunning = (behavior: WindowBehavior) =>
  behavior.closeToTray && !behavior.unavailable;
