# Shared helpers for the Study Mode Protection install/uninstall/recovery scripts.

$script:ServiceName = 'StudyModeProtection'
$script:HostName    = 'com.studymode.protection'
$script:ExtId       = 'study-mode@desktop.local'
$script:Base        = Join-Path $env:ProgramData 'StudyMode'

function Assert-Admin {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "ERROR: Run this from an elevated PowerShell (Run as administrator)." -ForegroundColor Red
        exit 1
    }
}

function Get-ProtectionState {
    $file = Join-Path $script:Base 'state.json'
    if (-not (Test-Path $file)) { return $null }
    try { return Get-Content $file -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-ProtectionLog($message) {
    try {
        $line = "{0} RECOVERY {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
        Add-Content -Path (Join-Path $script:Base 'protection.log') -Value $line -Encoding utf8
    } catch { }
    # Also record in the Windows Event Log so the action is visible even if the folder is gone.
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists('StudyModeProtection')) {
            New-EventLog -LogName Application -Source 'StudyModeProtection' -ErrorAction SilentlyContinue
        }
        Write-EventLog -LogName Application -Source 'StudyModeProtection' -EventId 1000 -EntryType Warning -Message $message -ErrorAction SilentlyContinue
    } catch { }
}

function Remove-FirefoxPolicyEntry {
    foreach ($d in @("${env:ProgramFiles}\Mozilla Firefox", "${env:ProgramFiles(x86)}\Mozilla Firefox")) {
        $policy = Join-Path $d 'distribution\policies.json'
        if (-not (Test-Path $policy)) { continue }
        try {
            $json = Get-Content $policy -Raw | ConvertFrom-Json
            if ($json.policies.ExtensionSettings.$script:ExtId) {
                $json.policies.ExtensionSettings.PSObject.Properties.Remove($script:ExtId)
            }
            $remaining = @($json.policies.ExtensionSettings.PSObject.Properties).Count
            if ($remaining -eq 0) { $json.policies.PSObject.Properties.Remove('ExtensionSettings') }
            if (@($json.policies.PSObject.Properties).Count -eq 0) {
                Remove-Item $policy -Force   # we created it and nothing else is in it
            } else {
                $json | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 $policy
            }
            Write-Host "Removed the force-install policy from $policy" -ForegroundColor Cyan
        } catch {
            Write-Host "WARNING: could not edit $policy automatically; remove the Study Mode entry by hand." -ForegroundColor Yellow
        }
    }
}

function Remove-Protection($Reason) {
    Write-ProtectionLog "Protection removed: $Reason"

    # Stop and delete the service.
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    & sc.exe stop $script:ServiceName | Out-Null
    Start-Sleep -Seconds 1
    if ($py -and (Test-Path (Join-Path $script:Base 'install'))) {
        $env:PYTHONPATH = Join-Path $script:Base 'install'
        & $py -m studymode_protection.service remove 2>$null | Out-Null
    }
    & sc.exe delete $script:ServiceName | Out-Null

    # Native-messaging host registration.
    Remove-Item -Path "HKLM:\Software\Mozilla\NativeMessagingHosts\$script:HostName" -Force -ErrorAction SilentlyContinue

    # Firefox force-install policy.
    Remove-FirefoxPolicyEntry

    # The program and state folder.
    if (Test-Path $script:Base) {
        Remove-Item -Recurse -Force $script:Base -ErrorAction SilentlyContinue
    }
    Write-Host "Protection components removed." -ForegroundColor Cyan
}
