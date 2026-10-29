# Edge cases — Personal Photo Companion

How to read this: each entry states the **current behavior** (what the code
actually does), the **desired behavior**, and whether it is **implemented**
or a **documented limitation**. Nothing here claims detection the app cannot
do. The guiding rule: a reminder must never embarrass the user, never stack
into a burst, and never leave the app in a stuck state.

## 1. In a meeting / sharing your screen

- **Current behavior:** a manual **Do Not Disturb (DND)** toggle pauses all
  reminders. It is available in three places: the toolbar DND button, the
  settings panel checkbox, and the system-tray menu checkbox. Turning DND (or
  quiet mode) on also dismisses any bubble already showing and drops queued
  reminders, so nothing lingers on screen mid-meeting. The status pill reads
  "Do Not Disturb" while it is on.
- **Desired behavior:** no reminder ever pops over a shared screen.
- **Status: implemented via the manual toggle (the reliable path).**
  **Documented limitation:** plain Electron cannot reliably detect that
  Zoom, Meet, or Teams is sharing the screen, or that another app is
  fullscreen, without native modules. There is no automatic meeting
  detection, and none is claimed. The reverse-engineering work on the
  reference product found zero evidence for automatic screen-share detection
  either, so this is designed in — not copied. If you share your screen
  often, turn DND on before the call; one click, and it stays on until you
  turn it off.

## 2. Fullscreen video or game

- **Current behavior:** the companion window is small (240×330), silent, and
  never steals focus (reminders use `showInactive`); each bubble auto-hides
  after 90 seconds. On macOS the window is also set not to appear over
  fullscreen spaces (`visibleOnFullScreen: false`).
- **Desired behavior:** no pop-over during a fullscreen video or game.
- **Status: best effort only.** On Windows and Linux, an always-on-top
  window can still appear over a fullscreen app — Electron exposes no
  cross-platform "another app is fullscreen" signal. The reliable path is
  the DND toggle before starting. This is the same limitation as case 1,
  stated plainly rather than papered over.

## 3. Multiple monitors

- **Current behavior:** the window opens at the bottom-right of the primary
  display. On display-added, display-removed, and display-metrics-changed
  events, the app checks whether its bounds still intersect any display's
  work area; if not, it moves back to the primary display's bottom-right.
  The geometry helpers (`isRectOnAnyScreen`, `bottomRightPosition`) are
  unit-tested, including small and offset displays.
- **Desired behavior:** the companion is never stranded on a disconnected
  monitor.
- **Status: implemented.** (It always returns to the primary display
  rather than the "nearest" one — simple and predictable.)

## 4. Sleep / wake catch-up

- **Current behavior:** on `powerMonitor` resume, overdue timers are reset
  to now + interval, and exactly **one** catch-up bubble is scheduled after
  a 3-minute grace delay, for the first overdue type (water first). If
  reminders are suppressed at grace time (quiet, DND, outside hours), the
  catch-up is dropped, not deferred.
- **Desired behavior:** waking the machine never produces a burst of stale
  reminders.
- **Status: implemented** (`overdueTypes` + `planCatchUp` in core.js;
  `resetOverdueTimers` + `scheduleCatchUp` in main.js).

## 5. App restart persistence

- **Current behavior:** settings — including the exercise rotation index
  and the last-run timestamp — persist in `settings.json` under Electron's
  per-user data folder. On start, if the app was closed longer than a
  reminder interval, the same single grace-delayed catch-up as case 4 is
  scheduled; a short gap just resumes the normal schedule; a first run
  (no file) starts from defaults with no catch-up.
- **Desired behavior:** restarting never replays old reminders, and the
  exercise rotation continues where it left off.
- **Status: implemented.** Limitation: the last-run timestamp is written
  on clean quit (`before-quit`); after a crash it is stale, which can only
  ever cause one grace-delayed catch-up — never a burst.

## 6. Working-hours boundaries

- **Current behavior:** hours are start-inclusive and end-exclusive
  (9:00 fires, 18:00 does not, for a 9–18 window). Overnight windows work
  (22–6 is on at 23:00 and 02:00, off at noon); start == end means always
  on. While suppressed, the tick rechecks every 10 minutes, so a reminder
  lands within 10 minutes of working hours starting.
- **Desired behavior:** reminders fire only inside the configured window,
  with no off-by-one at the edges.
- **Status: implemented and unit-tested.**

## 7. Quiet mode vs snooze interaction

- **Current behavior:** snooze stores a 10-minute snooze in settings
  (`snoozedUntilMs`/`snoozedType`), survives restarts, and is honoured by
  the scheduler; an expired snooze is cleared on the next tick. Snoozing
  also drops any queued reminder of the same type, so a queued copy cannot
  immediately undo the snooze. If quiet mode or DND is on when a snoozed
  reminder comes due, it is rechecked every 10 minutes and fires once
  conditions allow — snooze means "later", not "never".
- **Desired behavior:** snooze and quiet mode compose without surprises:
  no double reminders, no silently swallowed reminders.
- **Status: implemented.** One deliberate asymmetry: a *catch-up* bubble
  (case 4/5) is dropped if suppressed at grace time, while a *snoozed*
  reminder waits for conditions to allow it. Catch-ups are best-effort
  nudges; snoozes are explicit user requests.

## 8. Back-to-back water + exercise reminders

- **Current behavior:** reminders go through a queue with at most one
  pending reminder per type (a newer one replaces an older one). Only one
  bubble is ever visible; dismissing it (Done, snooze, or auto-hide) shows
  the next queued reminder. Flushing checks the allowed state first: if
  suppression turned on or working hours ended while a reminder waited,
  the queue is dropped instead of displayed.
- **Desired behavior:** two reminders due together display sequentially,
  never overlapping, never stacked.
- **Status: implemented and end-to-end verified** (the e2e run asserts a
  queue-flush marker).

## 9. Missing or corrupt avatar photo

- **Current behavior:** the renderer tries `avatar.png`, then `.jpg`,
  then `.jpeg`, then the bundled `avatar.svg`, then a built-in drawn-face
  data URI — so the companion never shows a broken image. A file that
  exists but fails to decode triggers the same fallback (Chromium fires
  `error` on decode failure). The tray icon tries png → jpg → jpeg and,
  if none exists, runs without a tray (see case 14).
- **Desired behavior:** a bad photo never breaks the app or shows a
  broken-image icon.
- **Status: implemented.** Limitation: a file that decodes successfully
  but contains the wrong picture cannot be detected — it just shows.

## 10. Invalid settings values

- **Current behavior:** every settings input is validated on load and on
  save (`sanitizeSettings`): intervals clamp to 1–480 minutes, hours to
  0–23 / 1–24, quiet/DND require a real boolean `true` (the string
  `"false"` does not enable them), unknown keys are dropped, and a corrupt
  or non-object settings file falls back to defaults. Hour 0 (midnight) is
  preserved — the v1 `Number(x) || default` bug that turned midnight into
  9 AM is fixed and regression-tested.
- **Desired behavior:** no hand-edited or corrupted value can silently
  disable reminders or crash the app.
- **Status: implemented and unit-tested.** Invalid values are corrected
  silently; the settings form re-shows the corrected values.

## 11. Multiple app instances

- **Current behavior:** a single-instance lock
  (`app.requestSingleInstanceLock`) makes a second launch focus the
  running companion and quit immediately, so two copies can never
  double-fire reminders.
- **Desired behavior:** exactly one companion runs per user.
- **Status: implemented and end-to-end verified** (the e2e run launches a
  second instance against the same data dir and asserts it exits with
  code 0 while the first keeps running). Limitation: the lock is per
  user-data directory; launching with a different `--user-data-dir`
  deliberately runs a second copy (used by tests).

## 12. Screen lock

- **Current behavior:** on `powerMonitor` lock-screen, display is
  suppressed; the tick keeps running and pushes each next attempt out by
  10 minutes, so unlocking never produces a burst — the next reminder
  arrives within 10 minutes of unlocking. Unlock-screen clears the
  suppression.
- **Desired behavior:** nothing pops while the screen is locked, and
  unlocking does not replay missed reminders.
- **Status: implemented.** Limitation: lock detection relies on
  Electron's `powerMonitor`, whose Linux coverage depends on the desktop
  session signals; where the platform does not emit them, the DND toggle
  is the fallback.

## 13. Clock / timezone changes

- **Current behavior:** scheduling is tick-based (every 30 seconds) with
  wall-clock due checks. A forward clock jump produces at most one fire
  per type, then timers reset — never a burst. A backward jump simply
  waits until the (now later) next-fire time passes. Working hours use
  local time on every tick, so a timezone change takes effect on the next
  tick without a restart.
- **Desired behavior:** clock adjustments degrade to "wait a bit", never
  to a burst or a stuck scheduler.
- **Status: implemented by the tick design.** Limitation: a large backward
  jump delays reminders until the shifted next-fire time — no worse than
  waiting out one interval.

## 14. No system tray (headless / minimal desktops)

- **Current behavior:** tray creation is wrapped in try/catch; if it
  fails (no tray host, no icon asset), the app continues as a plain
  floating window, and closing the window quits — so the user is never
  left with an invisible running app.
- **Desired behavior:** the app works with or without a tray.
- **Status: implemented and end-to-end verified** (the e2e run under
  Xvfb has no tray and still passes).

## 15. Other small cases

- **Interval change mid-flight:** changing an interval resets only that
  type's next fire time to now + the new interval; the other type is
  untouched. Implemented.
- **Preview while a bubble is showing:** a preview replaces the bubble
  content immediately (it is user-initiated, so it jumps the queue) and
  does not shift the schedule. Queued reminders flush after dismiss.
  Implemented.
- **Quit while a bubble is showing:** bubble state is in-memory only;
  nothing stale reappears on restart. The last-run timestamp is still
  persisted. Implemented.
- **Display disconnect while running:** covered by case 3.
- **Corrupt settings file:** covered by case 10 (falls back to defaults).
- **First run:** defaults, no catch-up, window on the primary display's
  bottom-right. Implemented.
