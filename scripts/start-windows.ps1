param(
    [string]$Executable,
    [switch]$CheckOnly,
    [switch]$DesktopLaunch,
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (!$Executable) { $Executable = Join-Path $repoRoot 'src-tauri\target\debug\agent-studio.exe' }
$appPath = (Resolve-Path -LiteralPath $Executable).ProviderPath
if ([IO.Path]::GetExtension($appPath) -ne '.exe') { throw 'Choose a built Windows executable.' }

if ($DesktopLaunch) {
    try {
        # This branch runs under Task Scheduler's normal interactive user token, not
        # the calling application's inherited MSIX file virtualization context.
        if (!$CheckOnly) {
            $existing = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($appPath)) -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -eq $appPath }
            if ($existing) {
                @{ status = 'already-running'; processId = @($existing)[0].Id } |
                    ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
                exit 0
            }
        }
        $probe = Start-Process -FilePath $appPath -ArgumentList '--check-startup' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
        if (!$probe.WaitForExit(20000)) {
            # Only the owned, noninteractive check process may be stopped.
            $probe.Kill()
            throw 'The startup storage check did not finish. Rebuild the app before retrying.'
        }
        if ($probe.ExitCode -ne 0) { throw 'The startup storage check failed. Open Agent Studio from Windows and review its startup message.' }
        if ($CheckOnly) {
            $result = @{ status = 'verified' }
        } else {
            $app = Start-Process -FilePath $appPath -WorkingDirectory $repoRoot -WindowStyle Normal -PassThru
            $deadline = (Get-Date).AddSeconds(25)
            do {
                Start-Sleep -Milliseconds 250
                $app.Refresh()
                if ($app.HasExited) { throw 'Agent Studio exited before opening its window.' }
            } while ($app.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)
            if ($app.MainWindowHandle -eq 0) { throw 'Agent Studio has not opened its window; inspect it before retrying.' }
            $result = @{ status = 'started'; processId = $app.Id }
        }
        $result | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
        exit 0
    } catch {
        @{ status = 'error'; message = $_.Exception.Message } |
            ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
        exit 1
    }
}

# No persistent task, credentials, administrator token, installation IDs, or
# user-specific paths. A unique result prevents an older launch reporting success.
$runId = [guid]::NewGuid().ToString('N')
$resultDir = Join-Path $repoRoot "artifacts\startup\$runId"
New-Item -ItemType Directory -Path $resultDir | Out-Null
$resultPath = Join-Path $resultDir 'result.json'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'One-shot Agent Studio launch with normal Windows storage'
$definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Hidden = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT2M'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
# Existing filesystem paths cannot contain a double quote. -File passes them as
# literal arguments; no path or account data is interpolated into shell code.
$action.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -DesktopLaunch -Executable "' + $appPath + '" -ResultPath "' + $resultPath + '"'
if ($CheckOnly) { $action.Arguments += ' -CheckOnly' }
$action.WorkingDirectory = $repoRoot
$name = 'AgentStudio-Launch-' + $runId
$task = $folder.RegisterTaskDefinition($name, $definition, 2, $null, $null, 3)
try {
    $task.Run($null) | Out-Null
    $deadline = (Get-Date).AddSeconds(55)
    do {
        Start-Sleep -Milliseconds 500
        $task = $folder.GetTask($name)
    } while ($task.State -in @(2, 4) -and (Get-Date) -lt $deadline)
    if ($task.State -in @(2, 4) -or !(Test-Path -LiteralPath $resultPath)) {
        throw 'Agent Studio startup was not confirmed; inspect the app before retrying.'
    }
    $result = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    if ($task.LastTaskResult -ne 0 -or $result.status -eq 'error') { throw $result.message }
    $result | ConvertTo-Json
} finally {
    $folder.DeleteTask($name, 0)
}
