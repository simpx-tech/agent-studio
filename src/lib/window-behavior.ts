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

/** What closing the window does now, and how to come back or quit. */
export function closeSummary(behavior: WindowBehavior): string {
  if (behavior.unavailable) return behavior.unavailable;
  if (!behavior.closeToTray) return 'Closing the window quits Agent Studio and stops its replies.';
  if (behavior.area === 'menuBar')
    return 'Closing the window keeps Agent Studio in the menu bar. Open the window from the Dock or the menu bar icon, and quit from that icon.';
  return behavior.clickOpens
    ? 'Closing the window keeps Agent Studio in the system tray. Click its icon to open the window again, or right-click it and choose Quit Agent Studio.'
    : 'Closing the window keeps Agent Studio in the system tray. Open the window again or quit from its icon’s menu.';
}
