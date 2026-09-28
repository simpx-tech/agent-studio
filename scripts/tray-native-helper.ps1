# Operates only the isolated tray QA app (scripts/native-tray.tauri.json) for
# scripts/tray-native-smoke.mjs. Clicks arrive as the notification icon's callback message,
# as Explorer sends them, so the pointer never moves. Menu items are chosen in the real context
# menu with its own keyboard handling; UI Automation does not see a menu whose app is not in
# the foreground.
param(
  [Parameter(Mandatory)][ValidateSet('State', 'Click', 'Open', 'Quit')][string]$Action,
  [Parameter(Mandatory)][int]$QAProcessId
)
$ErrorActionPreference = 'Stop'
$app = Get-Process -Id $QAProcessId -ErrorAction SilentlyContinue
if ($Action -eq 'State' -and !$app) {
  @{ running = $false } | ConvertTo-Json -Compress
  exit 0
}
if (!$app -or $app.ProcessName -ne 'agent-studio') { throw 'Only operate the isolated tray QA app.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TrayQA {
  public delegate bool EnumProc(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint item, System.Text.StringBuilder text, int max, uint flags);
  public static IntPtr Find(uint processId, string className, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, data) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != processId) return true;
      var name = new System.Text.StringBuilder(256);
      GetClassName(h, name, name.Capacity);
      var text = new System.Text.StringBuilder(256);
      GetWindowText(h, text, text.Capacity);
      // PowerShell passes $null strings as empty ones.
      if ((string.IsNullOrEmpty(className) || name.ToString() == className) && (string.IsNullOrEmpty(title) || text.ToString() == title) && (className != "#32768" || IsWindowVisible(h))) {
        found = h;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$pid32 = [uint32]$QAProcessId
$main = [TrayQA]::Find($pid32, $null, 'Agent Studio Tray QA')
$tray = [TrayQA]::Find($pid32, 'tray_icon_app', $null)
# tray-icon's notification callback message (WM_USER_TRAYICON) and the mouse events it reads.
$callback = 6002
function Choose([string]$name) {
  if ($tray -eq [IntPtr]::Zero) { throw 'The QA app has no tray icon.' }
  # The menu runs its own modal loop, so post the right click instead of waiting on it.
  foreach ($message in 0x204, 0x205) { [void][TrayQA]::PostMessage($tray, $callback, [IntPtr]::Zero, [IntPtr]$message) }
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 200
    $menu = [TrayQA]::Find($pid32, '#32768', $null)
  } while ($menu -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
  if ($menu -eq [IntPtr]::Zero) { throw 'The tray icon did not open its menu.' }
  $handle = [TrayQA]::SendMessage($menu, 0x01E1, [IntPtr]::Zero, [IntPtr]::Zero) # MN_GETHMENU
  $items = @(for ($i = 0; $i -lt [TrayQA]::GetMenuItemCount($handle); $i++) {
      $text = New-Object System.Text.StringBuilder 256
      [void][TrayQA]::GetMenuString($handle, [uint32]$i, $text, 256, 0x400) # MF_BYPOSITION
      $text.ToString()
    })
  # Separators have no text and the keyboard skips them.
  $choices = @($items | Where-Object { $_ })
  $index = [array]::IndexOf($choices, $name)
  if ($index -lt 0) { throw "The tray menu has no $name item." }
  for ($i = 0; $i -le $index; $i++) { [void][TrayQA]::PostMessage($menu, 0x0100, [IntPtr]0x28, [IntPtr]::Zero) } # VK_DOWN
  [void][TrayQA]::PostMessage($menu, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero) # VK_RETURN
  @{ menu = $items } | ConvertTo-Json -Compress
}
switch ($Action) {
  'State' {
    @{
      running = $true
      window = $main -ne [IntPtr]::Zero
      visible = $main -ne [IntPtr]::Zero -and [TrayQA]::IsWindowVisible($main)
      foreground = $main -ne [IntPtr]::Zero -and [TrayQA]::GetForegroundWindow() -eq $main
      tray = $tray -ne [IntPtr]::Zero
    } | ConvertTo-Json -Compress
  }
  'Click' {
    if ($tray -eq [IntPtr]::Zero) { throw 'The QA app has no tray icon.' }
    foreach ($message in 0x201, 0x202) { [void][TrayQA]::SendMessage($tray, $callback, [IntPtr]::Zero, [IntPtr]$message) }
  }
  'Open' { Choose 'Open Agent Studio' }
  'Quit' { Choose 'Quit Agent Studio' }
}
