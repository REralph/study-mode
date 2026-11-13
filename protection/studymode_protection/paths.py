"""Where the protection system keeps its files, and how they are named.

Everything lives under one base directory:

* Production: ``C:\\ProgramData\\StudyMode`` (shared, machine-wide). The installer gives
  it an ACL that lets everyone read but only Administrators and the service account write,
  so a standard user cannot edit the countdown.
* Development / tests: set the ``STUDYMODE_HOME`` environment variable to any folder.
  This lets the whole system run and be tested without admin rights or touching ProgramData.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_HOME = "STUDYMODE_HOME"
PRODUCTION_HOME = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "StudyMode"

SERVICE_NAME = "StudyModeProtection"
SERVICE_DISPLAY_NAME = "Study Mode Protection"
NATIVE_HOST_NAME = "com.studymode.protection"
EXTENSION_ID = "study-mode@desktop.local"


def home() -> Path:
    """The base directory, honouring STUDYMODE_HOME for dev/test."""
    override = os.environ.get(ENV_HOME)
    return Path(override) if override else PRODUCTION_HOME


def is_dev_mode() -> bool:
    return bool(os.environ.get(ENV_HOME))


def state_file() -> Path:
    return home() / "state.json"


def config_file() -> Path:
    return home() / "config.json"


def log_file() -> Path:
    return home() / "protection.log"


def install_dir() -> Path:
    """Where the signed .xpi and policy template are kept (checked by integrity.py)."""
    return home() / "install"
