"""Checks whether tamper-resistance is actually in force, and reports plainly when it is not.

Requirement 11: the system must say clearly when protection cannot be guaranteed instead of
pretending everything is fine. Each check returns a short, human-readable problem string
(or None when fine); ``check_all`` gathers them for the UI and the logs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import paths

# Firefox's documented policy location on Windows: a "distribution" folder beside firefox.exe.
FIREFOX_DIRS = [
    Path(r"C:\Program Files\Mozilla Firefox"),
    Path(r"C:\Program Files (x86)\Mozilla Firefox"),
]


def firefox_policy_path() -> Optional[Path]:
    for d in FIREFOX_DIRS:
        if (d / "firefox.exe").exists():
            return d / "distribution" / "policies.json"
    return None


def check_policy() -> Optional[str]:
    """Is Study Mode force-installed via Firefox policy?"""
    policy = firefox_policy_path()
    if policy is None:
        return "Firefox was not found in its usual location, so the enforced-install policy could not be checked."
    if not policy.exists():
        return "The Firefox policy that force-installs Study Mode is not present, so the extension can be removed from Firefox."
    try:
        data = json.loads(policy.read_text(encoding="utf-8"))
        ext = data["policies"]["ExtensionSettings"][paths.EXTENSION_ID]
    except (json.JSONDecodeError, KeyError, OSError):
        return "The Firefox policy file is present but does not force-install Study Mode."
    if ext.get("installation_mode") != "force_installed":
        return "The Firefox policy does not force-install Study Mode, so it can be disabled or removed."
    return None


def check_signed_extension() -> Optional[str]:
    """Is the signed .xpi that the policy points at actually present?"""
    xpi = paths.install_dir() / "study_mode.xpi"
    if not xpi.exists():
        return f"The signed extension file is missing ({xpi}); Firefox cannot install it from policy."
    return None


def check_account() -> Optional[str]:
    """Warn if the current user is an administrator (requirement 8)."""
    try:
        import ctypes
        if ctypes.windll.shell32.IsUserAnAdmin():
            return ("You are signed in to Windows as an administrator, so protection can be removed with a "
                    "single Windows prompt. For stronger protection, use a standard account day to day.")
    except Exception:
        return None
    return None


def check_all() -> Dict[str, Any]:
    """{'ok': bool, 'problems': [...], 'warnings': [...]}.

    Problems mean protection is not guaranteed; warnings mean it is weaker than it could be.
    """
    problems: List[str] = []
    for problem in (check_policy(), check_signed_extension()):
        if problem:
            problems.append(problem)
    warnings: List[str] = []
    account = check_account()
    if account:
        warnings.append(account)
    return {"ok": not problems, "problems": problems, "warnings": warnings}
