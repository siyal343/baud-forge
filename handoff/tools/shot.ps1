param(
  [string]$Process = 'bforge-gui',
  [string]$Title = 'BaudForge',
  [string]$Out = "$env:TEMP\window.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Of(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity); return sb.ToString();
  }
}
"@
$proc = Get-Process $Process -ErrorAction Stop | Select-Object -First 1
$best = $null; $bestArea = 0
foreach ($h in [Win]::Of([uint32]$proc.Id)) {
  $r = New-Object Win+RECT; [void][Win]::GetWindowRect($h, [ref]$r)
  $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
  if ([Win]::Title($h) -eq $Title -and $area -gt $bestArea) { $best = $h; $bestArea = $area; $bestRect = $r }
}
if (-not $best) { Write-Output "no BaudForge window"; exit 1 }
[void][Win]::ShowWindow($best, 9)   # SW_RESTORE
[void][Win]::SetForegroundWindow($best)
Start-Sleep -Milliseconds 600
$bestRect = New-Object Win+RECT; [void][Win]::GetWindowRect($best, [ref]$bestRect)
$w = $bestRect.Right - $bestRect.Left; $hh = $bestRect.Bottom - $bestRect.Top
Write-Output "window $w x $hh"
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [Win]::PrintWindow($best, $dc, 2)
$g.ReleaseHdc($dc); $g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "printwindow=$ok"
