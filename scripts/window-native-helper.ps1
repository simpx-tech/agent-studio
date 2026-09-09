param(
  [Parameter(Mandatory)][ValidateSet('Restore', 'Maximize', 'Resize', 'Drag')][string]$Action,
  [Parameter(Mandatory)][int]$QAProcessId,
  [int]$Width,
  [int]$Height,
  [int]$X,
  [int]$Y,
  [int]$DeltaX,
  [int]$DeltaY
)
$ErrorActionPreference = 'Stop'
$app = Get-Process -Id $QAProcessId
if ($app.ProcessName -ne 'agent-studio') { throw 'Only operate the isolated window QA app.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowQA {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr className, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
# .NET's MainWindowHandle/Title can disappear while a WebView window is minimized.
$handle = [WindowQA]::FindWindow([IntPtr]::Zero, 'Agent Studio Window QA')
$ownerId = [uint32]0
[void][WindowQA]::GetWindowThreadProcessId($handle, [ref]$ownerId)
if ($handle -eq [IntPtr]::Zero -or $ownerId -ne $QAProcessId) { throw 'Only operate the isolated window QA app.' }
# Match CDP's physical-pixel dimensions on monitors with scaling enabled.
$previousDpi = [WindowQA]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  switch ($Action) {
    'Restore' { [void][WindowQA]::ShowWindow($handle, 9) }
    'Maximize' { [void][WindowQA]::ShowWindow($handle, 3) }
    'Resize' {
      $outer = New-Object WindowQA+Rect
      $client = New-Object WindowQA+Rect
      [void][WindowQA]::GetWindowRect($handle, [ref]$outer)
      [void][WindowQA]::GetClientRect($handle, [ref]$client)
      # Frameless windows still retain invisible native resize margins.
      $outerWidth = $Width + $outer.Right - $outer.Left - $client.Right
      $outerHeight = $Height + $outer.Bottom - $outer.Top - $client.Bottom
      [void][WindowQA]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $outerWidth, $outerHeight, 6)
    }
    'Drag' {
      [void][WindowQA]::SetForegroundWindow($handle)
      $rect = New-Object WindowQA+Rect
      $cursor = New-Object WindowQA+Point
      [void][WindowQA]::GetWindowRect($handle, [ref]$rect)
      [void][WindowQA]::GetCursorPos([ref]$cursor)
      try {
        if (-not [WindowQA]::SetCursorPos($rect.Left + $X, $rect.Top + $Y)) {
          throw 'Native pointer input is unavailable on this Windows desktop.'
        }
        Start-Sleep -Milliseconds 100
        [WindowQA]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 200
        for ($step = 1; $step -le 10; $step++) {
          [void][WindowQA]::SetCursorPos($rect.Left + $X + [int]($DeltaX * $step / 10), $rect.Top + $Y + [int]($DeltaY * $step / 10))
          Start-Sleep -Milliseconds 30
        }
      } finally {
        [WindowQA]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        [void][WindowQA]::SetCursorPos($cursor.X, $cursor.Y)
      }
    }
  }
} finally {
  [void][WindowQA]::SetThreadDpiAwarenessContext($previousDpi)
}
