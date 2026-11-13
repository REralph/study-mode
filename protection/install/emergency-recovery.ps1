<#
    Study Mode Protection - emergency recovery (run as Administrator).

    This removes protection immediately, overriding the 2h40m waiting period. It exists so
    the owner of the computer can always regain control if the app or service is broken or
    stuck. It is deliberately harder to run than the normal uninstaller, and it records that
    it ran (protection.log and the Windows Application event log) so the action is never
    hidden (requirements 9, 10).

    You must pass the exact confirmation phrase:
        .\emergency-recovery.ps1 -Confirm "REMOVE PROTECTION NOW"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Confirm
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

Assert-Admin

$phrase = 'REMOVE PROTECTION NOW'
if ($Confirm -ne $phrase) {
    Write-Host "To confirm, re-run with:  -Confirm `"$phrase`"" -ForegroundColor Yellow
    exit 2
}

Write-Host "EMERGENCY RECOVERY: removing protection now and recording that this was done." -ForegroundColor Red
Remove-Protection -Reason "emergency-recovery.ps1 (waiting period overridden by an administrator)"
Write-Host ""
Write-Host "Protection has been removed. This override was logged to:" -ForegroundColor Cyan
Write-Host "  - the Windows Application event log (source 'StudyModeProtection')"
Write-Host "  - %ProgramData%\StudyMode\protection.log (now removed with the folder; the event log entry remains)"
