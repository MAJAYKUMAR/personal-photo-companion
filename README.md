# Personal Photo Companion

A small cross-platform desktop companion, built from scratch, inspired by the
general idea of a friendly on-screen reminder buddy: a little floating friend
that pops in during your working hours to remind you to drink water and to take
a short movement break. It is an original implementation — no code, art, or
assets from any other product are used here.

## What it does

- A small floating companion window (always on top, draggable by the avatar
  area, dismissible with the ✕ button) showing a photo avatar.
- **Animated companion (original CSS animation):** the avatar walks in on
  load and on every reminder, bobs gently while idle, wiggles for attention
  while a reminder bubble is showing, jumps happily on Done, and droops on
  Snooze. The bubble pops in with it. No video clips from any other
  product are used.
- **Water reminders** on a configurable interval (default: every 45 minutes),
  shown as a speech bubble with **Done ✓** and **Snooze 10 min** actions.
- **Exercise reminders** every 60 minutes by default, each showing one short
  desk exercise or stretch from a rotating list of 10. These are general
  movement breaks only — no medical claims, no diagnosis, no treatment advice.
  If an exercise ever hurts, skip it.
- **Settings** (gear button): water interval, exercise interval, working hours
  (default 9:00 AM–6:00 PM local time), quiet mode, and Do Not Disturb.
  Reminders only fire inside working hours and never while quiet mode or Do
  Not Disturb is on.
- **Do Not Disturb (meetings / screen share):** a toolbar button, a settings
  checkbox, and a tray menu item. Turn it on before a meeting or a screen
  share and no bubble will pop over your shared screen; turning it on also
  dismisses any bubble already showing and drops queued reminders.
- **Automatic meeting detection (Zoom / Meet / Teams, best effort):** on
  by default, polled every 30 seconds. It looks for meeting window titles
  (for example "Zoom Meeting", "Google Meet", "Teams Meeting") — a meeting
  app merely running in the background does NOT suppress reminders, so
  Teams/Zoom open all day will not silence the app. It can miss meetings
  whose window title is just a meeting name, and it does not by itself
  detect screen sharing, so manual Do Not Disturb remains the reliable
  fallback — see `EDGE_CASES.md` for the full story. Turn auto detection
  off in Settings or the tray menu to use manual DND only.
- **Reminder queue:** if a water and an exercise reminder fall due together,
  they never overlap — one bubble shows at a time and the next one follows
  after the first is dismissed (or after its 90-second auto-hide).
- **Missed-reminder catch-up:** after sleep/wake, a screen unlock, or an app
  restart, at most one catch-up bubble appears (water first), after a short
  grace delay — never a burst of stale reminders.
- **Single instance:** launching the app twice focuses the already-running
  companion instead of opening a second one.
- **On-device only:** no accounts, no analytics, no network calls. Settings
  are stored in a local JSON file in Electron's per-user data folder
  (`settings.json` under `userData`).

## Run it

Prerequisites: Node.js 20+ and npm.

```bash
cd personal-photo-companion
npm install
npm start
```

The companion appears in the bottom-right corner of your primary display.
Drag it by the avatar area. The ✕ button hides it; bring it back from the
system tray icon (right-click the tray icon for Show / Quiet mode / Do Not
Disturb / Quit). If your desktop has no tray, closing the window quits the
app instead, so you are never left with an invisible running app.

## Use your own photo (the whole point)

The app ships with a simple placeholder face (`assets/avatar.png`, with
`assets/avatar.svg` as a fallback), which stays the default until you
upload your own photo.

To use your own photo, in the app: open Settings (gear button), set
**Companion photo** to "Upload your photo…", and pick a PNG or JPG (up to
10 MB). It is copied into the app's own userData storage and used from
then on; choosing "Placeholder (built-in)" and saving switches back.
Your photo never leaves your machine — the app makes no network calls,
so nothing is uploaded anywhere.

The old file-swap route still works too: copy a square photo over
`assets/avatar.png` (or `assets/avatar.jpg`) before launching, and the
placeholder path will show it. A missing or corrupt photo never shows a
broken image — the app falls back through `avatar.png`, `avatar.jpg` /
`avatar.jpeg`, `avatar.svg`, then a built-in drawn face.

Tip: crop to a square first so the circular avatar frame doesn't cut off
anything important.

## Change the intervals

Two ways:

- **In the app:** click the gear button, edit the minute values, click Save.
  Changes apply immediately and are saved to `settings.json`.
- **By editing the file:** open the `settings.json` in Electron's userData
  folder and change `waterIntervalMin` / `exerciseIntervalMin`, then restart.
  (On Linux this is typically `~/.config/Personal Photo Companion/`.)

Working hours use whole hours in local time (`workStartHour` /
`workEndHour`, 24-hour clock; overnight ranges like 22–6 work, and
start == end means always on). Quiet mode pauses all reminders until you
turn it off (gear panel, toolbar bell button, or tray menu). Invalid values
in `settings.json` (wrong types, out-of-range numbers, a corrupt file) fall
back to safe defaults instead of crashing — hour 0 (midnight) is a valid
start hour, not a bug.

## Tests

All app logic lives in `core.js` so it can be tested without a window.
Unit tests use Node's built-in test runner; the end-to-end test drives the
real app under Xvfb.

```bash
npm test            # unit (tests/core.test.js) + e2e (tests/e2e-smoke.test.js)
npm run test:unit   # unit tests only
npm run test:e2e    # end-to-end test only (needs electron + Xvfb)
npm run test:python # artifact checks against dist/ (see below)
npm run test:all    # npm test + npm run test:python
```

What is covered (29 tests, all passing as of 2026-10-29):

- Unit (20): interval clamping, working-hours boundaries and overnight
  ranges, quiet/DND gating, snooze/dismiss/auto-hide state machine, exercise
  rotation order and wraparound, settings validation (including the
  hour-0 regression), avatar fallback chain, missed-reminder catch-up
  (at most one grace-delayed bubble), single-instance detection, and screen
  geometry (overlap, on-screen checks, bottom-right clamping).
- End-to-end (9): launch under Xvfb, settings save/get through the real
  preload IPC bridge, water and exercise reminders firing on short test
  intervals, queued back-to-back reminders flushing in order, Done/Snooze
  driving the main-process handlers, graceful behaviour with no tray, a
  real window screenshot, and second-instance quit.
- Artifact script (`tests/check_build.py`, stdlib only): checks the built
  installers/packages for expected contents and structure — Windows NSIS
  installer presence/size, Windows unpacked folder (app files hash-matched
  to the repo), Mac zip bundle (Info.plist id/version,
  executable +x bit, app files hash-matched to the repo), Linux AppImage
  (ELF magic, size, executable bit), and source hygiene (no network APIs,
  `asar: false`, `core.js` in packaged files). Final run: 51 checks
  passing, 1 failing — the missing Windows NSIS installer (see below).

## Package for Windows / Mac / Linux

Packaging is configured with `electron-builder` (see the `build` section in
`package.json`). Packages are loose files (`asar: false`) by design, so the
avatar and the app code stay inspectable inside the installed app.

```bash
npm run package:win    # NSIS installer (built on Linux under Wine)
npm run package:win-dir # Windows unpacked folder (no installer)
npm run package:mac    # macOS zip (DMG cannot be built on Linux)
npm run package:mac-zip # macOS zip, same as above
npm run package:mac-dir # macOS .app folder (no zip)
npm run package:linux  # AppImage
```

Build/verify results as of 2026-10-29 (all built on this Linux VM):

- **Windows unpacked** — built and file-verified (`dist/win-unpacked/`,
  `Personal Photo Companion.exe`, 188,784,128 bytes, app files
  hash-matched to the repo, version info stamped with rcedit-x64).
  The NSIS installer itself could NOT be completed on this VM (see below).
- **Windows installer — BLOCKED on this VM, not skipped:** electron-builder's
  NSIS flow stalls at the step where it runs the 32-bit NSIS stub installer
  under Wine to generate the uninstaller: the stub spins at ~100% CPU
  forever and never writes the uninstaller, under both Wine 9.0-amd64 and
  Wine 11.19-amd64-wow64 (SHA-verified download). The same spin affects
  32-bit rcedit (worked around for the version stamp by using the 64-bit
  rcedit-x64 from the same winCodeSign package — the cache's original
  rcedit-ia32.exe was restored afterwards, md5-verified). 32-bit makensis
  itself works (it produced the 161 KB stub). The stock `apt` route to
  distro Wine was also tried: `apt-get update` took ~16 minutes through
  the egress proxy (31 MB fetched, 2 index files failed but old lists
  used), so a distro-Wine retry was not time-boxed further. **To finish
  the installer, run `npm run package:win` on real Windows, or under a
  Wine with working 32-bit NSIS execution.** The `tests/check_build.py`
  failure on the missing installer is the correct signal for this gap.
- **Wine run of the Windows build — attempted, not verified running:**
  the unpacked exe was launched under Wine 11.19-wow64 + Xvfb with a
  60 s timeout: Wine started it (processes spawned, 119 X requests made)
  but it never printed `Personal Photo Companion ready` — Chromium
  startup stalls (libEGL.so.1 is absent in this container) and no app
  crash was logged either. So the Windows build is file-verified but
  NOT runtime-verified under Wine; real Windows is needed for that too.
- **macOS zip** — built (`dist/Personal Photo Companion-1.0.0-mac.zip`,
  ~99.7 MB) and bundle-verified: main Info.plist id
  `com.example.personal-photo-companion`, version `1.0.0`, executable with
  +x bit, helper apps present, app files hash-matched to the repo.
  **Running the Mac build itself is the one residual gap needing macOS
  hardware — it has not been run, and no macOS runtime behaviour is
  claimed.** A DMG cannot be produced on Linux (`dmg-license` is
  macOS-only), so the zip is the Mac deliverable from this machine.
- **Linux AppImage** — built (`dist/Personal Photo Companion-1.0.0.AppImage`,
  ~108 MB) and launch-verified under Xvfb: it printed
  `Personal Photo Companion ready` and ran until the test timeout.
  (An earlier attempt with a reused user-data dir exited 127; a clean run
  with a fresh data dir passed, so the 127 is treated as a stale-state
  artifact, not an AppImage defect.)

Notes for later: macOS builds need a Mac and, for distribution outside the
App Store, an Apple Developer ID for signing/notarisation. Windows builds
benefit from a code-signing certificate to avoid SmartScreen warnings, but
unsigned builds still run. Test the packaged app on a real Windows/Mac
desktop before sharing it — window placement, tray behaviour, and
always-on-top handling differ slightly per platform. The app sets no custom
icon yet (electron-builder warns about the default Electron icon); add one
before a public release.

## Edge cases

See `EDGE_CASES.md` — 15 entries, each with current behaviour, desired
behaviour, and what was implemented vs what is a documented limitation.
Summary:

- **Handled in code:** meeting/screen-share (manual DND toggle — the
  reliable path), fullscreen video/game (best-effort small silent window +
  DND), multiple monitors (repositions to a visible display), sleep/wake
  catch-up (one grace-delayed bubble, no burst), restart persistence
  (settings + rotation survive; timers restart, no stale burst),
  working-hours boundaries (start-inclusive, end-exclusive, overnight
  ranges), quiet vs snooze (snooze expiry never overrides quiet/DND/hours),
  back-to-back reminders (queue, never overlapping bubbles), missing/corrupt
  avatar (fallback chain to a drawn face), invalid settings (strict
  validation, safe defaults), multiple instances (single-instance lock),
  screen lock (display suppressed, cleared on unlock).
- **Documented as limited (no reliable Electron-only way):** automatic
  detection of another app's screen share or fullscreen state (use the DND
  toggle), and clock/timezone jumps (timers are wall-clock based; a big
  jump can delay or advance the next reminder by up to one interval, but
  never bursts).
- **Small cases covered:** interval change mid-flight, preview while a
  bubble shows, quit while a bubble shows, display disconnect, corrupt
  settings file, first run.

## Fullscreen behaviour (best effort)

Plain Electron cannot reliably detect another application's fullscreen state
on all three platforms without native modules, so the app does not claim
full fullscreen suppression. Instead it stays unobtrusive by design: a small
window, no sound, no focus steal (reminders use `showInactive`), a 90-second
auto-hide on each bubble, working-hours limits, one-click quiet mode, and
the Do Not Disturb toggle for meetings, screen shares, and fullscreen
sessions. A future version could add a native fullscreen watcher per
platform.

## Project layout

```text
personal-photo-companion/
├── package.json          # scripts + electron-builder packaging config
├── main.js               # window, tray, scheduler, settings storage (thin wiring)
├── core.js               # all testable logic: settings, scheduler, queue, geometry
├── preload.js            # minimal safe IPC bridge (contextIsolation on)
├── renderer/
│   ├── index.html        # companion UI
│   ├── styles.css
│   └── renderer.js       # bubble, settings panel, avatar fallback chain
├── tests/
│   ├── core.test.js      # unit tests (node --test)
│   ├── e2e-smoke.test.js # end-to-end test under Xvfb
│   └── check_build.py    # Python artifact-verification script
├── EDGE_CASES.md         # edge-case behaviour and limitations
├── assets/
│   ├── avatar.png        # placeholder face — replace with your photo
│   └── avatar.svg        # placeholder fallback
└── README.md
```

## Exercise list

Overhead stretch, shoulder rolls, neck turns, 2-minute walk, chair squats,
wrist stretches, calf raises, hand/arm shake-out, seated spinal twist,
marching in place — all general movement breaks, rotated in order.
Edit the `EXERCISES` array in `core.js` to customise them.

## What was verified here (and what was not)

Verified on this Linux VM: dependency install, JavaScript syntax checks,
unit tests (20/20), end-to-end tests under Xvfb (9/9), packaged Linux
AppImage launch, Mac zip bundle structure/contents/plist, Windows unpacked
build file verification + version stamping, and the artifact script (51
checks passing, 1 failing only on the not-built Windows installer). Reproduce the smoke
test with:

```bash
PCC_SMOKE_TEST=1 ELECTRON_DISABLE_SANDBOX=1 \
  xvfb-run -a ./node_modules/.bin/electron . --no-sandbox --disable-gpu
```

It should print `Personal Photo Companion ready`, then
`smoke: preview reminder sent`, then exit cleanly on its own. **Not verified
here:** running the Mac build (needs macOS hardware), completing the
Windows NSIS installer or running the Windows build on real Windows (the
installer is blocked at electron-builder's Wine uninstaller-generation step
and the unpacked exe did not reach ready under Wine — see above),
system-tray behaviour on a real desktop, and fullscreen
interaction with games/video players — those need real hardware to confirm.
