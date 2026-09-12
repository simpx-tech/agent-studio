export const windowsInstallerName = 'agent-studio-windows-x64-setup.exe';
export const windowsInstallerUrl = `/downloads/${windowsInstallerName}`;

// Screen width does not distinguish a phone from a resized desktop browser.
// iPadOS can report a Mac user agent, including in installed web apps.
export function browserDevice(userAgent: string, platform: string, maxTouchPoints: number) {
  if (
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    (/Mac/i.test(platform) && maxTouchPoints > 1)
  )
    return 'mobile';
  return /Windows/i.test(userAgent) ? 'windows' : 'desktop';
}
