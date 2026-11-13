<#
    Study Mode Protection - installer (run as Administrator).

    Sets up the tamper-resistance layer around the already-working extension:
      * copies the protection program and the signed extension into C:\ProgramData\StudyMode
      * locks that folder down with an ACL so standard users cannot edit the countdown
      * writes Firefox's enterprise policy to force-install the extension
      * registers the native-messaging host so the popup can read protection status
      * installs and starts the "Study Mode Protection" Windows service

    What it CANNOT do is make protection unremovable by an administrator: whoever holds
    admin on this PC can always uninstall it (that is the recovery path, by design). For
    the waiting period to actually bite, use a standard Windows account day to day.

    Usage (from an elevated PowerShell):
        .\install.ps1 -Xpi "C:\path\to\signed\study_mode.xpi"
        .\install.ps1 -Xpi ... -RequiredSeconds 9600      # 2h40m (default)

    The .xpi must be signed by Mozilla (see the project README). Without it, Firefox will
    not force-install the extension and the installer will say so.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Xpi,
    [int]$RequiredSeconds = 9600,
    [string]$PythonExe
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'StudyModeProtection'
$HostName    = 'com.studymode.protection'
$ExtId       = 'study-mode@desktop.local'
$Base        = Join-Path $env:ProgramData 'StudyMode'
$InstallDir  = Join-Path $Base 'install'
$PkgSrc      = Join-Path $PSScriptRoot '..\studymode_protection'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Warn($msg) { Write-Host "WARNING: $msg" -ForegroundColor Yellow }

# --- Preconditions --------------------------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Run this from an elevated PowerShell (right-click > Run as administrator)."
}
if (-not (Test-Path $Xpi)) { Fail "Signed extension not found: $Xpi" }

if (-not $PythonExe) {
    $PythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $PythonExe) { Fail "Python was not found. Install Python for all users, or pass -PythonExe." }
}
Info "Using Python: $PythonExe"

# The service runs as LocalSystem, which only sees machine-wide packages. Check pywin32
# is importable outside the installing user's profile.
$pywin = & $PythonExe -c "import win32serviceutil; print('ok')" 2>$null
if ($pywin -ne 'ok') {
    Fail "pywin32 is not available to $PythonExe for all users. Install it machine-wide from an elevated prompt:`n    `"$PythonExe`" -m pip install pywin32`n    `"$PythonExe`" Scripts\pywin32_postinstall.py -install"
}

# --- Copy program + extension into a locked location ----------------------------------
Info "Installing into $Base"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $PkgSrc '*') (New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'studymode_protection')).FullName
Copy-Item -Force $Xpi (Join-Path $InstallDir 'study_mode.xpi')

# config.json holds the configured waiting period.
@{ required_seconds = $RequiredSeconds; heartbeat_seconds = 10 } | ConvertTo-Json |
    Out-File -Encoding utf8 (Join-Path $Base 'config.json')

# Native-messaging host launcher: runs the real host from the locked copy.
$hostBat = Join-Path $InstallDir 'host.bat'
@"
@echo off
set PYTHONPATH=$InstallDir
"$PythonExe" -m studymode_protection.nativehost
"@ | Out-File -Encoding ascii $hostBat

# --- ACL: everyone may read; only Administrators + SYSTEM may change -------------------
Info "Locking down $Base (standard users get read-only)"
icacls $Base /inheritance:r | Out-Null
icacls $Base /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-11:(OI)(CI)RX" | Out-Null

# --- Firefox policy: force-install the extension --------------------------------------
$ffDir = @("${env:ProgramFiles}\Mozilla Firefox", "${env:ProgramFiles(x86)}\Mozilla Firefox") |
    Where-Object { Test-Path (Join-Path $_ 'firefox.exe') } | Select-Object -First 1
if ($ffDir) {
    $dist = Join-Path $ffDir 'distribution'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $xpiUrl = ((Join-Path $InstallDir 'study_mode.xpi') -replace '\\','/')
    $policy = (Get-Content (Join-Path $PSScriptRoot 'policies.template.json') -Raw) -replace '__XPI_URL__', $xpiUrl
    $policy | Out-File -Encoding utf8 (Join-Path $dist 'policies.json')
    Info "Wrote Firefox policy: $(Join-Path $dist 'policies.json')"
} else {
    Warn "Firefox was not found in Program Files. Install Firefox, then re-run this installer so the force-install policy can be written."
}

# --- Register the native-messaging host (machine-wide) --------------------------------
$manifest = (Get-Content (Join-Path $PSScriptRoot 'native-manifest.template.json') -Raw) -replace '__HOST_BAT__', ($hostBat -replace '\\','\\')
$manifestPath = Join-Path $InstallDir 'native-manifest.json'
$manifest | Out-File -Encoding utf8 $manifestPath
New-Item -Path "HKLM:\Software\Mozilla\NativeMessagingHosts\$HostName" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\Software\Mozilla\NativeMessagingHosts\$HostName" -Name '(default)' -Value $manifestPath

# --- Desktop app launcher + Start Menu shortcut ---------------------------------------
# pythonw.exe runs the GUI without a console window; fall back to python.exe if absent.
$pythonwExe = Join-Path (Split-Path $PythonExe) 'pythonw.exe'
if (-not (Test-Path $pythonwExe)) { $pythonwExe = $PythonExe }
$appBat = Join-Path $InstallDir 'StudyModeProtection.bat'
@"
@echo off
set PYTHONPATH=$InstallDir
start "" "$pythonwExe" -m studymode_protection.app
"@ | Out-File -Encoding ascii $appBat

try {
    $programs = [Environment]::GetFolderPath('CommonPrograms')
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs 'Study Mode Protection.lnk'))
    $lnk.TargetPath = $appBat
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Description = 'Study Mode Protection - status and controls'
    $lnk.Save()
    Info "Added Start Menu shortcut 'Study Mode Protection'."
} catch {
    Warn "Could not create the Start Menu shortcut; run $appBat to open the app."
}

# --- Install and start the service ----------------------------------------------------
Info "Installing the '$ServiceName' service"
$env:PYTHONPATH = $InstallDir
& $PythonExe -m studymode_protection.service --startup auto install
if ($LASTEXITCODE -ne 0) { Fail "Service install failed." }
& $PythonExe -m studymode_protection.service start | Out-Null

Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Info "Service is running." }
else { Warn "The service is installed but not running. Open services.msc and start 'Study Mode Protection'." }

Write-Host ""
Info "Done. Open Firefox and confirm Study Mode is installed and cannot be removed (about:addons)."
if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Warn "You are an administrator. Protection can be removed again with uninstall.ps1 (which also honours the waiting period) or, in a real emergency, emergency-recovery.ps1. For stronger protection, use a standard account day to day."
}
