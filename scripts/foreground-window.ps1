Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskpetWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [DeskpetWin32]::GetForegroundWindow()
$rect = New-Object DeskpetWin32+RECT
[void][DeskpetWin32]::GetWindowRect($hwnd, [ref]$rect)
$procId = 0
[void][DeskpetWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
[pscustomobject]@{ x=$rect.Left; y=$rect.Top; width=($rect.Right-$rect.Left); height=($rect.Bottom-$rect.Top); pid=$procId } | ConvertTo-Json -Compress
