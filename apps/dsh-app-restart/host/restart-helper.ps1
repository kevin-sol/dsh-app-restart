<#
dsh-app-restart helper.

Runs detached from the Desktop app (created through WMI so its parent is
WmiPrvSE, not the Desktop Host). It waits for the calling HTTP request to be
answered, terminates the Electron main process, waits until that process is
really gone (the single-instance lock must be free), then starts the same
executable again with a clean environment.

Every step appends to helper.log and the final outcome is written to last.json
so the Client half can report a failed attempt after the app came back.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$MainPid,
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$StateDir = (Join-Path $env:TEMP 'dsh-app-restart'),
    [switch]$DryRun,
    [int]$SettleMs = 1500,
    [int]$ExitTimeoutMs = 60000,
    [int]$LaunchVerifyMs = 6000
)

$ErrorActionPreference = 'Stop'

try {
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
} catch {}
$logPath = Join-Path $StateDir 'helper.log'
$statePath = Join-Path $StateDir 'last.json'

function Write-HelperLog([string]$text) {
    try {
        Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString('o') + ' helper ' + $text) -Encoding UTF8
    } catch {}
}

function Write-State([hashtable]$fields) {
    $payload = [ordered]@{
        at = (Get-Date).ToString('o')
        mainPid = $MainPid
        executable = $Exe
        dryRun = [bool]$DryRun
    }
    foreach ($key in $fields.Keys) { $payload[$key] = $fields[$key] }
    try {
        # `Set-Content -Encoding UTF8` writes a BOM under Windows PowerShell 5.1,
        # and a BOM makes the Host half's JSON.parse throw -- which would hide
        # exactly the failure this file exists to report.
        $json = $payload | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    if ($fields.ok -eq $true) { Write-HelperLog ('state ok: ' + $fields.stage) }
    else { Write-HelperLog ('state failed: ' + $fields.stage + ' ' + [string]$fields.message) }
}

function Get-TargetProcess {
    Get-CimInstance Win32_Process -Filter "ProcessId=$MainPid" -ErrorAction Stop
}

function Resolve-FullPath([string]$path) {
    try { return [System.IO.Path]::GetFullPath($path) } catch { return $path }
}

Write-HelperLog ('start mainPid=' + $MainPid + ' exe=' + $Exe + ' dryRun=' + [string]$DryRun)

# Let the HTTP response that scheduled this reach the page first.
Start-Sleep -Milliseconds $SettleMs

$target = $null
try { $target = Get-TargetProcess } catch { $target = $null }
if ($null -eq $target) {
    Write-State @{ ok = $false; stage = 'target-gone'; message = 'the application process is no longer running' }
    exit 1
}

$targetPath = Resolve-FullPath ([string]$target.ExecutablePath)
if ($targetPath -ne (Resolve-FullPath $Exe)) {
    Write-State @{ ok = $false; stage = 'target-mismatch'; message = ('unexpected executable: ' + $targetPath) }
    exit 2
}
if (([string]$target.CommandLine) -match 'dsh-desktop-host') {
    Write-State @{ ok = $false; stage = 'target-mismatch'; message = 'the resolved process is the Desktop Host, not the application' }
    exit 3
}

if ($DryRun) {
    Write-State @{ ok = $true; stage = 'dry-run'; message = ('would restart ' + $targetPath) }
    exit 0
}

# Killing only the main process would orphan the Desktop Host and the renderer
# children it spawned: they would keep the profile lock and their own ports
# while the freshly started app spawns a second Host. Take the whole tree down
# instead. This helper is not part of that tree (WMI parented it to WmiPrvSE),
# so /T cannot kill it.
function Get-DescendantProcessIds([int]$rootPid) {
    $children = @{}
    try {
        foreach ($process in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) {
            $parent = [int]$process.ParentProcessId
            if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
            $children[$parent].Add([int]$process.ProcessId)
        }
    } catch { return @() }
    $found = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($rootPid)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if (-not $children.ContainsKey($current)) { continue }
        foreach ($child in $children[$current]) {
            if (-not $found.Contains($child)) {
                $found.Add($child)
                $queue.Enqueue($child)
            }
        }
    }
    return $found.ToArray()
}

$tree = @(Get-DescendantProcessIds $MainPid)
Write-HelperLog ('terminating mainPid=' + $MainPid + ' with ' + [string]$tree.Count + ' descendant(s)')
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$killed = $false
try {
    if (Test-Path -LiteralPath $taskkill) {
        & $taskkill /PID $MainPid /T /F 2>&1 | Out-Null
        $killed = $LASTEXITCODE -eq 0
    }
} catch {
    $killed = $false
}
if (-not $killed) {
    try {
        Stop-Process -Id $MainPid -Force -ErrorAction Stop
        $killed = $true
    } catch {
        Write-State @{ ok = $false; stage = 'stop-failed'; message = $_.Exception.Message }
        exit 4
    }
}

$deadline = (Get-Date).AddMilliseconds($ExitTimeoutMs)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $still = $null
    try { $still = Get-TargetProcess } catch { $still = $null }
    if ($null -eq $still) { break }
}
if ($null -ne $still) {
    Write-State @{ ok = $false; stage = 'did-not-exit'; message = 'the application process did not exit' }
    exit 5
}
Write-HelperLog 'application process exited'

# The tree kill above normally takes the children down with it; anything that
# outlived it (a helper of its own that re-parented itself) is reported.
$leftovers = @($tree | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
if ($leftovers.Count -gt 0) { Write-HelperLog ('leftover pids: ' + ($leftovers -join ',')) }

# The relaunch must not inherit this process tree's Node/DSH environment: the
# Desktop Host runs with ELECTRON_RUN_AS_NODE=1 and stale DSH_* values, which
# would make the fresh process start in Node mode with the old session context.
foreach ($name in @(
        'ELECTRON_RUN_AS_NODE',
        'ELECTRON_FORCE_RENDERER_ACCESSIBILITY',
        'NODE_PATH',
        'NODE_OPTIONS',
        'DSH_SESSION_ID',
        'DSH_SHELL',
        'DSH_WEB_URL',
        'DSH_PROFILE',
        'DSH_PROFILE_DIR'
    )) {
    try { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue } catch {}
}

# `Split-Path -LiteralPath X -Parent` is an ambiguous parameter set on Windows
# PowerShell 5.1, so resolve the directory through .NET instead.
$workingDirectory = [System.IO.Path]::GetDirectoryName($Exe)
$startedAfter = Get-Date

function ConvertTo-VbsLiteral([string]$value) {
    return '"' + $value.Replace('"', '""') + '"'
}

# The app must be started by a process that has no console at all.
#
# This helper always has one: a console-subsystem program gets a console even
# when its window is hidden. `Start-Process` would hand that console to the app,
# the Desktop Host would inherit it, and its log output would appear in a stray
# window whose close button raises CTRL_CLOSE_EVENT for every process attached
# to it -- so closing that window takes the whole app down. That is exactly the
# bug this indirection fixes.
#
# Windows gives a console only when there is a console to inherit, and WmiPrvSE
# (a service) has none. So WMI creates a GUI-subsystem `wscript.exe`, which in
# turn starts the app: no console is created anywhere on the way, which is the
# same state a desktop-shortcut launch produces.
function Write-RelaunchScript {
    $scriptPath = Join-Path $StateDir 'relaunch.vbs'
    $lines = @(
        'Option Explicit',
        'Dim agent',
        'Set agent = CreateObject("WScript.Shell")',
        ('agent.CurrentDirectory = ' + (ConvertTo-VbsLiteral $workingDirectory)),
        ('agent.Run ' + (ConvertTo-VbsLiteral (ConvertTo-VbsLiteral $Exe)) + ', 1, False'),
        ''
    )
    [System.IO.File]::WriteAllText($scriptPath, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    return $scriptPath
}

function ConvertTo-PsString([string]$value) {
    return "'" + $value.Replace("'", "''") + "'"
}

# Identity is the process name plus a start time after the kill, not
# ExecutablePath: some apps (Notepad on Windows 11, for one) are started through
# an execution alias, so the running process reports a different image path than
# the file that was launched.
function Get-ApplicationProcessId([int]$excludePid, [datetime]$startedAfter) {
    $name = [System.IO.Path]::GetFileName($Exe)
    try {
        $candidates = Get-CimInstance Win32_Process -Filter ("Name=" + (ConvertTo-PsString $name)) -ErrorAction Stop
    } catch {
        return 0
    }
    foreach ($candidate in $candidates) {
        $candidateId = [int]$candidate.ProcessId
        if ($candidateId -eq $excludePid) { continue }
        if (([string]$candidate.CommandLine) -match 'dsh-desktop-host') { continue }
        try {
            if ([datetime]$candidate.CreationDate -lt $startedAfter) { continue }
        } catch {
            continue
        }
        return $candidateId
    }
    return 0
}

$relaunchScript = $null
try {
    $relaunchScript = Write-RelaunchScript
} catch {
    Write-State @{ ok = $false; stage = 'launch-failed'; message = $_.Exception.Message }
    exit 6
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launchCommand = '"' + $wscript + '" //nologo "' + $relaunchScript + '"'
$created = $null
try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $launchCommand
        CurrentDirectory = $workingDirectory
    } -ErrorAction Stop
} catch {
    $created = $null
}

if ($null -eq $created -or [int]$created.ReturnValue -ne 0) {
    # Last resort: the shell owns an existing console-less process, so it can
    # still start the app without handing it a console.
    Write-HelperLog ('wmi relaunch failed, using the shell: ' + [string]$created.ReturnValue)
    try {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $Exe + '"') -ErrorAction Stop | Out-Null
    } catch {
        Write-State @{ ok = $false; stage = 'launch-failed'; message = $_.Exception.Message }
        exit 6
    }
}
Write-HelperLog ('relaunch requested via ' + [string]$wscript + ' rv=' + [string]$created.ReturnValue)

# The launcher reports no child PID, so confirm the restart by watching for the
# application process itself instead of trusting the launcher's exit code.
$newPid = 0
$verifyDeadline = (Get-Date).AddMilliseconds($LaunchVerifyMs)
while ((Get-Date) -lt $verifyDeadline) {
    Start-Sleep -Milliseconds 300
    $newPid = Get-ApplicationProcessId -excludePid $MainPid -startedAfter $startedAfter
    if ($newPid -ne 0) { break }
}
if ($newPid -eq 0) {
    Write-State @{ ok = $false; stage = 'launch-unconfirmed'; message = 'the application process did not come back' }
    exit 7
}
Write-HelperLog ('relaunched newPid=' + [string]$newPid)

# A new instance fails the single-instance lock fast, so a short liveness check
# separates "started and stayed up" from "started and quit immediately".
$alive = $true
$settleDeadline = (Get-Date).AddMilliseconds([Math]::Min($LaunchVerifyMs, 3000))
while ((Get-Date) -lt $settleDeadline) {
    Start-Sleep -Milliseconds 300
    $alive = $null -ne (Get-Process -Id $newPid -ErrorAction SilentlyContinue)
    if (-not $alive) { break }
}
if (-not $alive) {
    Write-State @{ ok = $false; stage = 'launch-exited'; message = 'the relaunched process exited'; newPid = $newPid }
    exit 7
}

Write-State @{ ok = $true; stage = 'relaunched'; message = 'the application was restarted'; newPid = $newPid }
exit 0
