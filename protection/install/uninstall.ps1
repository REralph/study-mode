<#
    Study Mode Protection - uninstaller (run as Administrator).

    By design this honours the waiting period: it will only remove protection once you have
    gone through the desktop app, requested deactivation, and let the 2h40m wait finish (or
    already turned protection off there). If you try to uninstall while protection is still
    on, it refuses and tells you to use the app first.

    For a genuine emergency (the app or service is broken and you must regain control now),
    use emergency-recovery.ps1, which overrides the wait but records that it did.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin
$state = Get-ProtectionState
$status = if ($state) { $state.status } else { 'active' }
$request = if ($state -and $state.request) { $state.request.status } else { $null }

if ($status -eq 'active' -and $request -ne 'ready') {
    Write-Host ""
    Write-Host "Protection is still on, and the waiting period has not been completed." -ForegroundColor Yellow
    Write-Host "To uninstall the normal way:" -ForegroundColor Yellow
    Write-Host "  1. Open 'Study Mode Protection' from the Start menu."
    Write-Host "  2. Choose 'Request to turn off protection' and wait for the countdown (2h40m of on-time)."
    Write-Host "  3. When the wait is over, run this uninstaller again."
    Write-Host ""
    Write-Host "In a real emergency, run emergency-recovery.ps1 instead." -ForegroundColor Yellow
    exit 2
}

Write-Host "The waiting period is satisfied; removing protection." -ForegroundColor Cyan
Remove-Protection -Reason "uninstall.ps1 (waiting period satisfied)"
Write-Host "Done. Study Mode's blocking extension may still be present in Firefox; remove it from about:addons if you want it gone too." -ForegroundColor Cyan
