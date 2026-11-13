r"""Study Mode Protection - the desktop app.

A plainly named, visible window (requirement 10) that shows the current protection status
and, when a deactivation is pending, a live countdown (requirement 5). From here the user
can start the 2 h 40 m wait, cancel it, and - only once it has elapsed - pause or remove
protection (requirements 4, 9).

The app holds no state of its own: it reads and writes through the manager, which the
service also uses, so closing the app changes nothing about the countdown (requirement 6).

Run it with the shared state in a dev folder (no admin, no service needed):
    set STUDYMODE_HOME=C:\path\to\devhome
    python -m studymode_protection.app
"""

from __future__ import annotations

import tkinter as tk
from tkinter import messagebox

import customtkinter as ctk

from . import integrity, manager, paths, state as state_mod
from .service import service_is_alive

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

ACCENT = "#2563eb"
DANGER = "#c0392b"
OK_GREEN = "#2e9e5b"
WARN = "#c47f17"
MUTED = "#9aa3b2"
PAUSE_PRESETS = [("15 minutes", 15 * 60), ("1 hour", 60 * 60), ("4 hours", 4 * 60 * 60)]


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


class ProtectionApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Study Mode Protection")
        self.geometry("460x600")
        self.minsize(440, 560)
        self._build()
        self._refresh()
        # The service advances the real countdown; the app only re-reads once a second so
        # numbers stay fresh even in dev mode where the app ticks the clock itself.
        self.after(1000, self._loop)

    # -- layout ------------------------------------------------------------------------
    def _build(self):
        pad = {"padx": 20}
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", pady=(22, 6), **pad)
        ctk.CTkLabel(header, text="Study Mode Protection",
                     font=ctk.CTkFont(size=20, weight="bold")).pack(anchor="w")
        self.subtitle = ctk.CTkLabel(header, text="", text_color=MUTED, font=ctk.CTkFont(size=12))
        self.subtitle.pack(anchor="w")

        self.status_card = ctk.CTkFrame(self, corner_radius=12)
        self.status_card.pack(fill="x", pady=10, **pad)
        self.status_dot = ctk.CTkLabel(self.status_card, text="\u25cf", font=ctk.CTkFont(size=28))
        self.status_dot.grid(row=0, column=0, padx=(16, 10), pady=16)
        self.status_text = ctk.CTkLabel(self.status_card, text="", font=ctk.CTkFont(size=17, weight="bold"))
        self.status_text.grid(row=0, column=1, sticky="w", pady=(16, 0))
        self.status_detail = ctk.CTkLabel(self.status_card, text="", text_color=MUTED,
                                          font=ctk.CTkFont(size=12), justify="left")
        self.status_detail.grid(row=1, column=1, sticky="w", pady=(0, 16))
        self.status_card.grid_columnconfigure(1, weight=1)

        # Big countdown, shown only while a request is pending.
        self.countdown_frame = ctk.CTkFrame(self, corner_radius=12)
        self.countdown_label = ctk.CTkLabel(self.countdown_frame, text="Time until protection can be turned off",
                                            text_color=MUTED, font=ctk.CTkFont(size=12))
        self.countdown_label.pack(pady=(16, 2))
        self.countdown_value = ctk.CTkLabel(self.countdown_frame, text="0:00:00",
                                            font=ctk.CTkFont(size=42, weight="bold"))
        self.countdown_value.pack(pady=(0, 16))

        self.actions = ctk.CTkFrame(self, fg_color="transparent")
        self.actions.pack(fill="x", pady=6, **pad)

        self.warn_box = ctk.CTkLabel(self, text="", text_color=WARN, wraplength=410,
                                     justify="left", font=ctk.CTkFont(size=12))
        self.warn_box.pack(fill="x", pady=(2, 0), **pad)

        footer = ctk.CTkFrame(self, fg_color="transparent")
        footer.pack(side="bottom", fill="x", pady=12, **pad)
        self.footer_text = ctk.CTkLabel(footer, text="", text_color=MUTED, font=ctk.CTkFont(size=11),
                                        wraplength=410, justify="left")
        self.footer_text.pack(anchor="w")

    def _clear_actions(self):
        for child in self.actions.winfo_children():
            child.destroy()

    def _button(self, text, command, color=None, hover=None):
        btn = ctk.CTkButton(self.actions, text=text, command=command, height=40,
                            fg_color=color, hover_color=hover)
        btn.pack(fill="x", pady=5)
        return btn

    # -- data --------------------------------------------------------------------------
    def _loop(self):
        # In dev mode there is no service, so the app itself advances the clock.
        if paths.is_dev_mode() and not service_is_alive():
            manager.heartbeat()
        self._refresh()
        self.after(1000, self._loop)

    def _refresh(self):
        s = manager.read_state()
        summary = state_mod.summary(s)
        checks = integrity.check_all()
        alive = service_is_alive() or paths.is_dev_mode()
        self._render_status(summary, checks, alive)
        self._render_actions(summary)
        self._render_warnings(checks, alive)

    def _render_status(self, summary, checks, alive):
        status = summary["status"]
        if status == state_mod.ACTIVE:
            self.status_dot.configure(text_color=OK_GREEN)
            self.status_text.configure(text="Protection is ON")
            detail = "Distracting sites are blocked in Firefox."
        elif status == state_mod.PAUSED:
            self.status_dot.configure(text_color=WARN)
            self.status_text.configure(text="Protection is PAUSED")
            detail = f"Turns back on by itself in {format_duration(summary['pause_remaining_seconds'])}."
        else:
            self.status_dot.configure(text_color=DANGER)
            self.status_text.configure(text="Protection is OFF")
            detail = "Blocking is turned off until you switch it back on."
        if not alive:
            detail += "\nThe protection service is not running - the waiting period is not being enforced."
        self.status_detail.configure(text=detail)
        self.subtitle.configure(
            text="Enforced by Windows service + Firefox policy" if checks["ok"] and alive
            else "Reduced protection - see below")

    def _render_actions(self, summary):
        self._clear_actions()
        status = summary["status"]
        req = summary["request_status"]

        self.countdown_frame.pack_forget()
        if status == state_mod.ACTIVE and req is None:
            self._button("Request to turn off protection", self._request, color=DANGER, hover="#962d22")
        elif req == state_mod.WAITING:
            self.countdown_frame.pack(fill="x", pady=10, padx=20, before=self.actions)
            self.countdown_value.configure(text=format_duration(summary["remaining_seconds"]))
            ctk.CTkLabel(self.actions, text="Protection is still on until the wait is over.",
                         text_color=MUTED, font=ctk.CTkFont(size=12)).pack(pady=(0, 4))
            self._button("Cancel request", self._cancel)
        elif req == state_mod.READY:
            ctk.CTkLabel(self.actions, text="The waiting period is over. Choose what to do:",
                         font=ctk.CTkFont(size=13, weight="bold")).pack(pady=(0, 6))
            for label, secs in PAUSE_PRESETS:
                self._button(f"Pause for {label}", lambda s=secs: self._pause(s))
            self._button("Turn protection off", self._remove, color=DANGER, hover="#962d22")
            self._button("Keep protection on (cancel)", self._cancel)
        else:  # PAUSED or REMOVED
            self._button("Turn protection back ON now", self._activate, color=OK_GREEN, hover="#237a46")

    def _render_warnings(self, checks, alive):
        lines = []
        if not alive and not paths.is_dev_mode():
            lines.append("\u26a0 The protection service is not running. Start 'Study Mode Protection' "
                         "in services.msc, or reinstall using the installer.")
        lines += [f"\u26a0 {p}" for p in checks["problems"]]
        lines += [f"\u2139 {w}" for w in checks["warnings"]]
        self.warn_box.configure(text="\n\n".join(lines))
        req = format_duration(manager.read_summary()["required_seconds"])
        self.footer_text.configure(
            text=f"Waiting period: {req}. Turning protection off always requires the full wait; "
                 "turning it on is immediate. This app can be closed at any time without affecting the countdown.")

    # -- commands ----------------------------------------------------------------------
    def _request(self):
        if messagebox.askyesno(
                "Request to turn off protection",
                f"This starts a waiting period of {format_duration(manager.read_summary()['required_seconds'])} "
                "(counted only while the PC is on). Protection stays ON until it ends.\n\nStart the wait now?"):
            manager.request_deactivation()
            self._refresh()

    def _cancel(self):
        manager.cancel_request()
        self._refresh()

    def _pause(self, seconds):
        try:
            manager.pause(seconds)
        except PermissionError as exc:
            messagebox.showerror("Not yet", str(exc))
        self._refresh()

    def _remove(self):
        if messagebox.askyesno("Turn protection off",
                               "Turn blocking off until you switch it back on?"):
            try:
                manager.remove()
            except PermissionError as exc:
                messagebox.showerror("Not yet", str(exc))
        self._refresh()

    def _activate(self):
        manager.activate()
        self._refresh()


def main():
    ProtectionApp().mainloop()


if __name__ == "__main__":
    main()
