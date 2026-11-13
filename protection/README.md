# Study Mode Protection

A tamper-resistance layer around the Study Mode Firefox extension. It makes turning the
blocker off a slow, deliberate act instead of an impulsive one, while keeping the computer
owner able to recover control.

It has four parts:

| Part | What it does |
| --- | --- |
| **Windows service** (`StudyModeProtection`) | Advances the waiting-period countdown while the PC is on, and owns the protection state in `C:\ProgramData\StudyMode`. |
| **Desktop app** | A visible window and Start Menu entry showing status and the countdown, and the only place protection can be paused or removed - after the wait. |
| **Native-messaging host** | Lets the Firefox extension read the protection status so the popup shows it. Read-only: it cannot turn protection off. |
| **Firefox policy** | Force-installs the extension so it can't be disabled or removed from `about:addons`. |

The blocking itself is still the extension; this layer only governs when it can be switched
off. The extension keeps working on its own if this layer is never installed.

## How it behaves

- Turning protection **on** is always immediate. Turning it **off** takes a waiting period,
  **2 hours 40 minutes** by default, configurable.
- The wait counts **only while the PC is on**. Time while it's off or asleep doesn't count.
  This is the safe direction: it can only make the wait longer.
- Closing Firefox, restarting the browser, closing the app, stopping the service or
  rebooting does **not** shorten or reset the wait. The countdown lives in a file the
  service updates, and downtime simply isn't counted.
- Once the wait is over you choose, in the app: **pause** for a set time (protection comes
  back on by itself) or **remove** it until you turn it back on.
- If the service or policy is missing or broken, the extension keeps blocking and the popup
  and app say plainly that protection can't be fully verified. It never silently fails open.

## What it can and cannot guarantee

Protection rests on **Windows account permissions**, not on a background process that any
user could kill. The state folder and the policy can only be changed by Administrators, so
a **standard** Windows user cannot shorten the countdown or remove the blocker.

An **administrator can always remove it** (that is the recovery path). So:

- For real protection, use a **standard** account day to day, with the administrator
  password held separately. If you run as an administrator, the app says so: protection can
  be undone with one Windows prompt.
- `uninstall.ps1` also honours the waiting period. `emergency-recovery.ps1` overrides it for
  genuine emergencies and records that it did, so control is always recoverable but never
  silently.

Nothing is hidden: the service and app use their real names, appear in services.msc, Task
Manager and Programs, and every change is written to `protection.log` and the Windows
Application event log.

## Install

Needs: Firefox, Python **installed for all users** with `pywin32` available machine-wide
(the service runs as LocalSystem and can't see per-user packages), and a **Mozilla-signed**
build of the extension (`study_mode.xpi` - see the main README for signing).

From an **elevated** PowerShell, in this `protection` folder:

```powershell
# Install pywin32 for the all-users Python, once:
& "C:\Path\To\Python\python.exe" -m pip install pywin32
& "C:\Path\To\Python\python.exe" "C:\Path\To\Python\Scripts\pywin32_postinstall.py" -install

# Install the protection layer:
.\install\install.ps1 -Xpi "C:\path\to\study_mode.xpi"
# Optional: a different waiting period, in seconds (default 9600 = 2h40m)
.\install\install.ps1 -Xpi "C:\path\to\study_mode.xpi" -RequiredSeconds 9600
```

The installer copies everything into `C:\ProgramData\StudyMode`, locks that folder
(standard users read-only), writes the Firefox policy, registers the native host, installs
and starts the service, and adds the **Study Mode Protection** Start Menu shortcut. It
stops and explains if a prerequisite is missing.

## Turning protection off (the intended way)

1. Open **Study Mode Protection** from the Start menu.
2. Click **Request to turn off protection**. The countdown starts; protection stays on.
3. When it reaches zero, choose **Pause** or **Turn protection off**.

## Uninstall / recovery

```powershell
.\install\uninstall.ps1              # removes everything, but only once the wait is satisfied
.\install\emergency-recovery.ps1 -Confirm "REMOVE PROTECTION NOW"   # emergency override (logged)
```

## Development and tests

The logic is pure Python with no admin needed. Point the system at a throwaway folder and
run everything locally:

```powershell
$env:STUDYMODE_HOME = "C:\temp\sbdev"   # use a dev folder instead of C:\ProgramData
python -m studymode_protection.app      # run the desktop app; it ticks its own clock in dev mode
python -m unittest discover -s tests      # unit + integration tests
```

In dev mode (`STUDYMODE_HOME` set) there is no service, so the app advances the clock
itself - handy for watching a short countdown. Set a short wait first with:
`python -c "import studymode_protection.manager as m; m.set_required_seconds(60)"`.

The extension's side of the link is covered by `test/e2e/protection.mjs` in the main project
(`npm run test:e2e:protection`): a fake native host drives the extension through active,
removed, paused and unhealthy states.

### Files

```
studymode_protection/
  state.py        countdown + state machine (pure logic)
  store.py        atomic JSON load/save of state and config
  manager.py      locked read-modify-write used by service, app and host
  service.py      the Windows service (pywin32)
  app.py          the desktop app (customtkinter)
  nativehost.py   native-messaging host the extension reads
  integrity.py    checks the policy/xpi/account and reports problems plainly
  paths.py        where files live (honours STUDYMODE_HOME)
install/          install / uninstall / emergency-recovery PowerShell + templates
tests/            Python unit and integration tests
```
