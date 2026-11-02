# ATLIS Desktop Control bridge. Dot-sourced once into a persistent PowerShell
# process (src/main/desktop/manager.ts DesktopShell). Finds a real OS window by
# title, then drives it with actual OS-level input (SetForegroundWindow +
# SetCursorPos + mouse_event + SendKeys) - there is no reliable way to click
# into a background Electron/Chromium window without this, since apps like
# Discord ignore synthetic input sent via PostMessage/SendMessage.
#
# Wire protocol: Invoke-AtlisDesktop always writes exactly one line
# "ATLIS_JSON:<compact json>" (success or {ok:false,error}), then the caller
# writes its own sentinel line so Node knows the call finished.

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AtlisNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008;
    public const uint RIGHTUP = 0x0010;
    public const int SW_RESTORE = 9;
}
"@

# appName -> tracked AutomationElement (top-level window)
$script:AtlisWindows = @{}

function Find-AtlisWindow([string]$TitlePattern, [double]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($w in $children) {
            try { if ($w.Current.Name -match $TitlePattern) { return $w } } catch {}
        }
        Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Get-AtlisTrackedWindow([string]$Name) {
    $win = $script:AtlisWindows[$Name]
    if (-not $win) { throw "No tracked window for app '$Name' - launch it first." }
    if (-not [AtlisNative]::IsWindow([IntPtr]$win.Current.NativeWindowHandle)) { throw "Window for '$Name' was closed." }
    return $win
}

function Show-AtlisForeground([System.Windows.Automation.AutomationElement]$Win) {
    $hwnd = [IntPtr]$Win.Current.NativeWindowHandle
    [void][AtlisNative]::ShowWindow($hwnd, [AtlisNative]::SW_RESTORE)
    [void][AtlisNative]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
}

# Escape literal text for SendKeys: +^%~(){}[] are special and must be
# bracketed; newlines/tabs become their key tokens.
function Convert-ToSendKeys([string]$Text) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        if ('+^%~(){}[]'.IndexOf($ch) -ge 0) { [void]$sb.Append("{$ch}") }
        elseif ($ch -eq "`n") { [void]$sb.Append('{ENTER}') }
        elseif ($ch -eq "`t") { [void]$sb.Append('{TAB}') }
        else { [void]$sb.Append($ch) }
    }
    return $sb.ToString()
}

$script:AtlisKeyTokens = @{
    enter = '{ENTER}'; return = '{ENTER}'; tab = '{TAB}'; esc = '{ESC}'; escape = '{ESC}'
    backspace = '{BACKSPACE}'; delete = '{DELETE}'; del = '{DELETE}'; home = '{HOME}'; end = '{END}'
    pageup = '{PGUP}'; pagedown = '{PGDN}'; up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'
    space = ' '; f1='{F1}'; f2='{F2}'; f3='{F3}'; f4='{F4}'; f5='{F5}'; f6='{F6}'
}

# Human syntax like "Ctrl+Enter" / "Ctrl+Shift+A" -> SendKeys syntax.
function Convert-KeysToSendKeys([string]$Keys) {
    $parts = $Keys -split '\+'
    $mods = ''
    $last = $parts[$parts.Length - 1].Trim().ToLower()
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        switch ($parts[$i].Trim().ToLower()) {
            'ctrl' { $mods += '^' }
            'control' { $mods += '^' }
            'alt' { $mods += '%' }
            'shift' { $mods += '+' }
        }
    }
    $keyToken = if ($script:AtlisKeyTokens.ContainsKey($last)) { $script:AtlisKeyTokens[$last] } else { $last }
    return "$mods$keyToken"
}

function ConvertTo-AtlisRect([System.Windows.Rect]$R) {
    return @{ left = [int]$R.Left; top = [int]$R.Top; width = [int]$R.Width; height = [int]$R.Height }
}

function Invoke-AtlisDesktop {
    param([string]$Action, [string]$ArgsJson)
    $a = $ArgsJson | ConvertFrom-Json
    try {
        switch ($Action) {
            'find' {
                $win = Find-AtlisWindow -TitlePattern $a.titlePattern -TimeoutSec $a.timeoutSec
                if (-not $win) {
                    $result = @{ ok = $true; found = $false }
                } else {
                    $script:AtlisWindows[$a.name] = $win
                    $result = @{ ok = $true; found = $true; title = $win.Current.Name; rect = ConvertTo-AtlisRect $win.Current.BoundingRectangle }
                }
            }
            'rect' {
                $win = Get-AtlisTrackedWindow $a.name
                $result = @{ ok = $true; title = $win.Current.Name; rect = ConvertTo-AtlisRect $win.Current.BoundingRectangle }
            }
            'click' {
                $win = Get-AtlisTrackedWindow $a.name
                Show-AtlisForeground $win
                [void][AtlisNative]::SetCursorPos([int]$a.x, [int]$a.y)
                Start-Sleep -Milliseconds 60
                if ($a.button -eq 'right') { $down = [AtlisNative]::RIGHTDOWN; $up = [AtlisNative]::RIGHTUP } else { $down = [AtlisNative]::LEFTDOWN; $up = [AtlisNative]::LEFTUP }
                [AtlisNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 40
                [AtlisNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
                if ($a.doubleClick) {
                    Start-Sleep -Milliseconds 70
                    [AtlisNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
                    Start-Sleep -Milliseconds 40
                    [AtlisNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
                }
                $result = @{ ok = $true }
            }
            'type' {
                $win = Get-AtlisTrackedWindow $a.name
                Show-AtlisForeground $win
                # Warmup keystroke: the very first SendKeys character right after a
                # focus change can be silently swallowed (validated live - "100%"
                # arrived as "0%" without this). {HOME} is a content-safe no-op.
                [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
                Start-Sleep -Milliseconds 120
                # One character per SendWait call, each with a tiny pace delay.
                # Sending the whole escaped string in a single call let shifted
                # symbols (%, (, etc.) occasionally resolve to their unshifted
                # base key - e.g. "100%" arrived as "1005" - validated live;
                # per-character pacing fixed it completely.
                foreach ($ch in $a.text.ToCharArray()) {
                    [System.Windows.Forms.SendKeys]::SendWait((Convert-ToSendKeys ([string]$ch)))
                    Start-Sleep -Milliseconds 15
                }
                if ($a.submit) { Start-Sleep -Milliseconds 60; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
                $result = @{ ok = $true }
            }
            'key' {
                $win = Get-AtlisTrackedWindow $a.name
                Show-AtlisForeground $win
                [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
                Start-Sleep -Milliseconds 120
                [System.Windows.Forms.SendKeys]::SendWait((Convert-KeysToSendKeys $a.keys))
                $result = @{ ok = $true }
            }
            'stop' {
                $script:AtlisWindows.Remove($a.name)
                $result = @{ ok = $true }
            }
            default { throw "Unknown action '$Action'." }
        }
    } catch {
        $result = @{ ok = $false; error = $_.Exception.Message }
    }
    Write-Output "ATLIS_JSON:$(ConvertTo-Json -Depth 6 -Compress $result)"
}
