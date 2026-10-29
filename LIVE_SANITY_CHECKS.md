# Live sanity checks — installed app, not unit tests

These checks run against the **actually installed** app on a real Windows
machine (GitHub Actions `windows-latest` runner, installed via the NSIS
installer), not against source code or an unpacked folder. The installed
self-test (`PCC_E2E=1` in `main.js`, `runE2eSelfTest`) performs the
automated ones and logs `e2e: check-pass <name>` / `e2e: check-FAIL <name>`
for each. A run is only "green" for installation if every automated check
passes AND the install step itself passes (it no longer has
`continue-on-error`, so a failed install fails the run).

## 1. Install
- [ ] Installer runs silently (`/S`), exit code 0.
- [ ] Installed exe found by searching Programs folders (folder is the
      package name: `%LOCALAPPDATA%\Programs\personal-photo-companion\Personal Photo Companion.exe`).
- [ ] Uninstall registry entry exists: "Personal Photo Companion 1.0.0".

## 2. Launch (installed app)
- [ ] Installed app launches, exits cleanly with code 0 in the self-test.
- [ ] Window is 240×330, bottom-right, always on top, transparent.
- [ ] Avatar image loads (placeholder blue face by default), status reads
      "Here with you", toolbar shows ⚙ / 🔕 / DND / ✕.

## 3. Settings panel (the bug that was found on a real PC)
- [ ] Clicking gear opens settings AND grows the window to 700px tall,
      upward from the bottom-right corner.
- [ ] Every control is visible inside the window: Water, Exercise,
      Working hours start, Working hours end, Quiet, DND, Auto meeting
      detection, Companion photo dropdown, Preview 💧, Preview 🏃, Save.
- [ ] Changing values and clicking Save persists them (re-read via
      settings bridge) and shrinks the window back to 330px.

## 4. Reminders and buttons
- [ ] Water reminder fires on its timer: bubble title "Water break",
      text "Time for a sip of water.", Done + Snooze buttons visible.
- [ ] Clicking Snooze on water: avatar shows the sleepy sway animation,
      bubble hides, snooze is recorded.
- [ ] Exercise reminder (preview): bubble title "Movement break", text
      is one of the 10 rotating desk stretches.
- [ ] Clicking Done on exercise: avatar shows the celebration spin-jump
      animation, bubble hides, status returns to "Here with you".
- [ ] First reminder takes a real window screenshot
      (`installed-launch-shot.png` in the installed run).

## 5. Suppression
- [ ] Do Not Disturb on: status reads "Do Not Disturb"; off again restores
      "Here with you".
- [ ] Quiet mode on: status reads "Quiet mode"; off again restores.

## 6. Tray and persistence
- [ ] Tray icon is created (`tray-ready` in the log), tooltip
      "Personal Photo Companion".
- [ ] Settings survive a settings save round-trip (see check 3); the
      settings file lives under Electron userData, on-device only.

## 7. Uninstall (runner only, after the installed checks)
- [ ] Silent uninstall removes the installed exe folder and the
      uninstall registry entry.
- [ ] This step runs only on the runner. On a personal PC, uninstall is
      a manual step via Windows Settings / Apps.

## 8. Manual-only checks (cannot be automated on a runner)
These are NOT covered by any automated run and must be done once by a
person on a real personal PC:
- [ ] SmartScreen prompt for the unsigned installer (expected: unsigned
      build shows a warning; "Run anyway" proceeds).
- [ ] Photo picker dialog: gear → Companion photo → "Upload your
      photo…" opens the system file picker; picking a PNG/JPG shows
      that photo as the avatar.
- [ ] Dragging the companion window by the avatar area moves it.
- [ ] Real Zoom / Meet / Teams call: auto meeting detection pauses
      reminders, manual DND is the fallback if it misses.
- [ ] Real 45-minute water and 60-minute exercise reminders over a
      working day, inside and outside working hours.
- [ ] Long-term tray behaviour (hide via ✕, restore from tray, quit
      from tray menu).

## What is NOT a substitute
Unit tests (`tests/core.test.js`) and the unpacked-exe launch are
pre-checks only. They do not prove installation, the installed path,
the installed screenshot, or the settings-panel size on a real screen.
Only sections 1–7 above, run against the installed app, count as a
live installation check.
