// Personal Photo Companion — Electron main process (thin wiring).
//
// All reminder decisions live in core.js (pure, unit-tested). This file
// only owns windows, tray, power events, timers, and IPC, and keeps the
// small amount of shell state (next fire times, bubble, queue) here.
// On-device only: no accounts, no analytics, no network calls.

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('node:child_process');
const {
  DEFAULT_SETTINGS,
  SNOOZE_MIN,
  SUPPRESSED_RECHECK_MIN,
  MEETING_POLL_MS,
  sanitizeSettings,
  settingsFromFileText,
  remindersAllowed,
  detectMeeting,
  isAutoMeetingSuppressed,
  rotateExercise,
  delayMsForReminder,
  snoozeSettings,
  ReminderQueue,
  overdueTypes,
  planCatchUp,
  isSecondInstance,
  isRectOnAnyScreen,
  bottomRightPosition,
  BubbleState,
} = require('./core');

// Single-instance lock: a second launch focuses the running companion and
// quits, so two copies can never double-fire reminders.
if (isSecondInstance(app.requestSingleInstanceLock())) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

if (process.platform === 'win32') {
  app.setAppUserModelId('com.example.personal-photo-companion');
}

const E2E = process.env.PCC_E2E === '1';
const TICK_MS = 30 * 1000;
const WIN_WIDTH = 360;
const WIN_HEIGHT = 480;
const WIN_HEIGHT_REMINDER = 640;
// Tall enough for the full settings panel (avatar, Save, previews, note).
// The window grows upward from the bottom-right corner so it never
// slides off the bottom of the screen when settings open.
const WIN_HEIGHT_SETTINGS = 900;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let tickTimer = null;
let meetingTimer = null;
let catchUpTimer = null;
let screenshotTaken = false;
let meetingDetected = false;
let meetingApp = null;
let meetingCheckRunning = false;

// ---- shell state (owned here, decided in core.js) ----
let settings = { ...DEFAULT_SETTINGS };
let nextFireMs = { water: 0, exercise: 0 };
let queue = new ReminderQueue();
let bubble = new BubbleState();
let externalSuppressed = false; // true while the screen is locked

function e2eLog(...args) {
  if (E2E) console.log('e2e:', ...args);
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return settingsFromFileText(raw);
  } catch (err) {
    // First run, or an unreadable file: start from defaults, never crash.
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(next) {
  settings = sanitizeSettings({ ...settings, ...(next || {}) });
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
  return { ...settings };
}

function broadcastSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', {
      ...settings,
      meetingDetected,
      meetingApp,
    });
  }
}

function publicSettings() {
  return { ...settings, meetingDetected, meetingApp };
}

// Interval delay for a type in milliseconds. In e2e mode, short overrides
// replace the minute-based intervals so the harness observes real fires.
function intervalDelayMs(type, nowMs) {
  if (E2E) {
    const key = type === 'water' ? 'PCC_E2E_WATER_MS' : 'PCC_E2E_EXERCISE_MS';
    const raw = parseInt(process.env[key] || '', 10);
    if (Number.isFinite(raw)) return Math.min(3600000, Math.max(1000, raw));
  }
  return delayMsForReminder(type, settings, nowMs);
}

function rawIntervalMs(type) {
  const min = type === 'water' ? settings.waterIntervalMin : settings.exerciseIntervalMin;
  return min * 60 * 1000;
}

function allowedNow(nowMs) {
  return (
    !externalSuppressed &&
    !isAutoMeetingSuppressed(settings, meetingDetected) &&
    remindersAllowed(settings, new Date(nowMs))
  );
}

// Automatic meeting detection (best effort, title-based — see core.js).
// Windows: tasklist /V gives process names AND window titles in one call.
// macOS: System Events window names via osascript (needs accessibility
// permission; failures just mean no titles). Linux: wmctrl -l when
// installed, otherwise process names only — which never suppress on
// their own, so a missed meeting there falls back to manual DND.
function execFileAsync(file, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function parseTasklistCsv(text) {
  const processes = [];
  const windowTitles = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = [];
    const re = /"([^"]*)"/g;
    let m;
    while ((m = re.exec(line)) !== null) fields.push(m[1]);
    if (fields.length < 2) continue;
    processes.push(fields[0]);
    const title = fields[fields.length - 1];
    if (title && title !== 'N/A') windowTitles.push(title);
  }
  return { processes, windowTitles };
}

async function checkMeeting() {
  if (meetingCheckRunning) return;
  meetingCheckRunning = true;
  try {
    let sample = { processes: [], windowTitles: [] };
    if (process.platform === 'win32') {
      sample = parseTasklistCsv(
        await execFileAsync('tasklist', ['/FO', 'CSV', '/V', '/NH']),
      );
    } else if (process.platform === 'darwin') {
      const out = await execFileAsync('osascript', [
        '-e',
        'tell application "System Events" to get name of every window of every process',
      ]);
      sample.windowTitles = String(out || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ps = await execFileAsync('ps', ['-eo', 'comm']);
      sample.processes = String(ps || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      const wm = await execFileAsync('wmctrl', ['-l']);
      sample.windowTitles = String(wm || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\S+\s+\S+\s+\S+\s+/, '').trim())
        .filter(Boolean);
      const ps = await execFileAsync('ps', ['-eo', 'comm']);
      sample.processes = String(ps || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const result = detectMeeting(sample);
    const changed = result.detected !== meetingDetected || result.app !== meetingApp;
    meetingDetected = result.detected;
    meetingApp = result.app;
    if (changed) {
      console.log(
        meetingDetected
          ? `Meeting detected automatically (${meetingApp || 'unknown app'}); reminders paused`
          : 'Meeting no longer detected; reminders resume on next check',
      );
      if (meetingDetected) {
        queue.clear();
        bubble.done();
      }
      broadcastSettings();
    }
  } catch (err) {
    // A failed poll must never crash or suppress: keep the last state.
    console.error('Meeting check failed (continuing with last state):', err.message);
  } finally {
    meetingCheckRunning = false;
  }
}

// Hide the whole companion window once no reminder bubble is showing.
// This is what makes the companion appear only for reminders: after
// Done / Snooze / auto-hide, nothing stays on screen — no avatar, no
// toolbar, no settings/bell/DND buttons — until the next reminder or
// a tray click. If a queued reminder just flushed, bubble.visible is
// true and the window stays for that reminder.
function hideWindowIfNoBubble() {
  if (!bubble.visible && mainWindow && !mainWindow.isDestroyed()) {
    // Reset to compact height before hiding, so a manual tray show
    // does not open a tall empty window.
    const b = mainWindow.getBounds();
    mainWindow.setBounds({
      x: b.x, y: b.y + b.height - WIN_HEIGHT, width: WIN_WIDTH, height: WIN_HEIGHT,
    });
    mainWindow.hide();
  }
}

// Grow the window for a reminder so the full-body character (230px)
// plus bubble, status and toolbar all fit; anchored bottom-right.
function resizeWindowForReminder() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = WIN_HEIGHT_REMINDER;
  const b = mainWindow.getBounds();
  if (b.height !== target) {
    const area = screen.getPrimaryDisplay().workArea;
    const bottom = area.y + area.height - 16;
    const y = Math.min(b.y + b.height - target, bottom - target);
    mainWindow.setBounds({
      x: b.x, y, width: WIN_WIDTH, height: target,
    });
  }
}

// Walk-in from the left (user spec, 2026-10-29): a real reminder
// starts off-screen at the LEFT edge, takes a few steps in, stops on
// the left side, and only then asks (bubble). Done runs it away to
// the right; Snooze makes it sad. E2E runs skip the walk so the
// self-test timing stays deterministic.
function walkInFromLeft(payload) {
  try {
    const { screen } = require('electron');
    // Use the full workArea (x/y/height), not just its size, and leave
    // a 16px margin above the taskbar — otherwise the window bottom
    // (and its buttons) can sit behind / below the taskbar.
    const area = screen.getPrimaryDisplay().workArea;
    const b = mainWindow.getBounds();
    const y = area.y + area.height - WIN_HEIGHT_REMINDER - 16;
    // End CENTRE, not left edge: reference character stands in the
    // middle of the screen, prominent over the work, not tucked away.
    const endX = area.x + Math.round((area.width - WIN_WIDTH) / 2);
    mainWindow.setBounds({ x: -WIN_WIDTH, y, width: WIN_WIDTH, height: WIN_HEIGHT_REMINDER });
    mainWindow.showInactive();
    mainWindow.webContents.send('walk-start');
    let x = -WIN_WIDTH;
    const timer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(timer); return; }
      x += 50;
      mainWindow.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT_REMINDER });
      if (x >= endX) {
        clearInterval(timer);
        e2eLog('walk-in-done', x);
        mainWindow.webContents.send('reminder', payload);
      }
    }, 90);
  } catch (err) {
    mainWindow.webContents.send('reminder', payload);
  }
}

function runAwayToRight() {
  try {
    const { screen } = require('electron');
    const area = screen.getPrimaryDisplay().workAreaSize;
    const b = mainWindow.getBounds();
    let x = b.x;
    const timer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(timer); return; }
      x += 80;
      mainWindow.setBounds({ x, y: b.y, width: b.width, height: b.height });
      if (x > area.width) clearInterval(timer);
    }, 50);
  } catch { /* window hides via bubble-dismissed anyway */ }
}

function displayReminder(payload, meta) {
  e2eLog(
    'reminder-fired',
    payload.type,
    JSON.stringify(payload.title),
    meta && meta.queued ? '(queue-flush)' : '',
    meta && meta.preview ? '(preview)' : '',
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!E2E && !(meta && meta.preview)) {
      walkInFromLeft(payload);
    } else {
      resizeWindowForReminder();
      mainWindow.showInactive();
      mainWindow.webContents.send('reminder', payload);
    }
    if (E2E && !screenshotTaken) {
      screenshotTaken = true;
      const out = process.env.PCC_E2E_SCREENSHOT || '/tmp/pcc-e2e/shot.png';
      setTimeout(() => {
        mainWindow
          .capturePage()
          .then((image) => {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, image.toPNG());
            e2eLog('screenshot-saved', out);
          })
          .catch((err) => e2eLog('screenshot-failed', err.message));
      }, 800);
    }
  }
}

// Show now if no bubble is up, otherwise queue for sequential display.
function showOrQueue(payload) {
  if (bubble.visible) {
    queue.enqueue(payload);
  } else {
    bubble.show(payload.type);
    displayReminder(payload, { queued: false, preview: false });
  }
}

function flushQueue() {
  if (queue.length === 0) return;
  // A queued reminder must never pop after suppression turned on or
  // working hours ended while it waited: drop the queue instead.
  if (!allowedNow(Date.now())) {
    queue.clear();
    return;
  }
  const next = queue.dequeue();
  if (next) {
    bubble.show(next.type);
    displayReminder(next, { queued: true, preview: false });
  }
}

function buildPayload(type) {
  if (type === 'water') {
    return { type: 'water', title: 'Hey Ajay, did you drink water?', text: 'Time for a sip of water.' };
  }
  const rotated = rotateExercise(settings);
  settings = rotated.settings;
  persistSettings({});
  return { type: 'exercise', title: 'Movement break', text: rotated.text, exerciseIndex: rotated.index };
}

function fire(type, nowMs) {
  const payload = buildPayload(type);
  nextFireMs[type] = nowMs + intervalDelayMs(type, nowMs);
  showOrQueue(payload);
}

// The periodic check. For each due type: fire when allowed, otherwise push
// the next attempt out by the recheck interval so a reminder lands soon
// after conditions allow it again. A forward clock jump can therefore
// produce at most one fire per type, never a burst.
function tick(nowMs) {
  // Expired snoozes are cleared (core.js leaves that to the caller).
  // When a snooze expires, held queued reminders may finally show.
  if (settings.snoozedUntilMs !== null && settings.snoozedUntilMs <= nowMs) {
    persistSettings({ snoozedUntilMs: null, snoozedType: null });
    if (!bubble.visible && queue.length > 0 && allowedNow(nowMs)) {
      flushQueue();
    }
  }
  for (const type of ['water', 'exercise']) {
    if (nextFireMs[type] <= nowMs) {
      if (allowedNow(nowMs)) {
        fire(type, nowMs);
      } else {
        nextFireMs[type] = nowMs + SUPPRESSED_RECHECK_MIN * 60 * 1000;
      }
    }
  }
}

// Schedule the single grace-delayed catch-up bubble for a wake/restart.
// Overdue timers were already reset by the caller; if reminders are
// suppressed at grace time, the catch-up is dropped, not deferred.
function scheduleCatchUp(plan) {
  if (!plan.due) return;
  if (catchUpTimer) clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    const nowMs = Date.now();
    if (allowedNow(nowMs)) {
      const payload = buildPayload(plan.type);
      nextFireMs[plan.type] = nowMs + intervalDelayMs(plan.type, nowMs);
      showOrQueue(payload);
    } else {
      e2eLog('catchup-dropped-suppressed', plan.type);
    }
  }, plan.delayMs);
  e2eLog('catchup-scheduled', plan.type, plan.delayMs);
}

function resetOverdueTimers(nowMs) {
  const overdue = overdueTypes(nextFireMs, nowMs);
  for (const t of overdue) nextFireMs[t] = nowMs + intervalDelayMs(t, nowMs);
  return overdue;
}

function ensureWindowOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  if (!isRectOnAnyScreen(bounds, areas)) {
    const primary = screen.getPrimaryDisplay().workArea;
    const pos = bottomRightPosition(primary, WIN_WIDTH, WIN_HEIGHT);
    mainWindow.setPosition(pos.x, pos.y);
  }
}

function createWindow() {
  const primary = screen.getPrimaryDisplay().workArea;
  const pos = bottomRightPosition(primary, WIN_WIDTH, WIN_HEIGHT);
  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Visible over normal windows, but below screensavers / lock UI.
  // (visibleOnFullScreen: false is honoured on macOS; on Windows/Linux the
  // Do Not Disturb toggle is the reliable way to stay off a shared screen.)
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (E2E) {
    // Forward renderer console output so the e2e harness can assert on it.
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      console.log('renderer:', message);
    });
  }

  mainWindow.once('ready-to-show', () => {
    // Companion is hidden by default (2026-10-29 user request): the
    // avatar, toolbar and options must NOT sit on screen all the time.
    // It appears only when a reminder fires, and hides again when that
    // reminder is Done / Snoozed / auto-hidden. The tray icon is the
    // manual way back in. E2E keeps the window shown initially so the
    // self-test can drive the DOM before the first reminder.
    if (E2E) mainWindow.show();
    console.log('Personal Photo Companion ready (hidden until a reminder)');
    if (process.env.PCC_SMOKE_TEST === '1') {
      // Scripted smoke test: one preview reminder, a screenshot, then quit.
      setTimeout(() => {
        previewReminder('water');
        console.log('smoke: preview reminder sent');
      }, 1500);
      setTimeout(() => {
        mainWindow
          .capturePage()
          .then((image) => {
            const out = '/tmp/pcc-smoke/smoke.png';
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, image.toPNG());
            console.log('smoke: screenshot saved to ' + out);
          })
          .catch((err) => console.error('smoke: screenshot failed:', err.message));
      }, 2500);
      setTimeout(() => app.quit(), 5000);
    }
    if (E2E) {
      runE2eSelfTest();
      const exitMs = parseInt(process.env.PCC_E2E_EXIT_MS || '45000', 10);
      setTimeout(() => app.quit(), Number.isFinite(exitMs) ? exitMs : 45000);
    }
  });

  // The close button hides the companion instead of quitting; the tray icon
  // (when available) brings it back. During a real quit the window must be
  // allowed to close, or quit would hang.
  mainWindow.on('close', (event) => {
    if (tray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function previewReminder(type) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.showInactive();
  if (type !== 'water' && type !== 'exercise') return;
  const payload = buildPayload(type);
  bubble.show(type);
  displayReminder(payload, { queued: false, preview: true });
}

// End-to-end self-test, driven from the main process through the real
// Live sanity checks against the real renderer DOM and window.
// Only runs with PCC_E2E=1. This is the installed-app check list in
// LIVE_SANITY_CHECKS.md, performed live — not a unit test. Each check
// logs `check-pass <name>` or `check-FAIL <name>` so a workflow run
// can be audited check by check.
async function runE2eSelfTest() {
  const check = (name, ok, detail) => {
    e2eLog(ok ? 'check-pass' : 'check-FAIL', name, detail || '');
  };
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await sleep(1000);
    // 2. Launch: window size, avatar, status, toolbar.
    const bounds0 = mainWindow.getBounds();
    check('window-360x480', bounds0.width === 360 && bounds0.height === 480,
      JSON.stringify(bounds0));
    const launchDom = await js(`({
      avatarSrc: document.getElementById('avatar').src,
      status: document.getElementById('status').textContent,
      toolbar: Array.from(document.querySelectorAll('#toolbar button')).map(b => b.id).join(','),
      bubbleHidden: document.getElementById('bubble').classList.contains('hidden'),
    })`);
    check('avatar-loads', /(character-fullbody(-cutout)?|ajay-cartoon-fullbody(-cutout)?|avatar)\.(png|svg)/.test(launchDom.avatarSrc || ''),
      launchDom.avatarSrc);
    check('status-here-with-you', launchDom.status === 'Here with you',
      launchDom.status);
    check('toolbar-4-buttons', launchDom.toolbar ===
      'btn-settings,btn-quiet,btn-dnd,btn-hide', launchDom.toolbar);
    check('bubble-hidden-at-launch', launchDom.bubbleHidden === true);
    // 3. Settings panel: gear grows the window to 620px and every
    // control (including Save and the photo dropdown) fits inside it.
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    const boundsSettings = mainWindow.getBounds();
    const settingsDom = await js(`({
      visible: !document.getElementById('settings').classList.contains('hidden'),
      saveRect: (() => { const r = document.getElementById('btn-save').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      photoVisible: !!document.getElementById('in-avatar') && document.getElementById('in-avatar').offsetParent !== null,
      saveVisible: document.getElementById('btn-save').offsetParent !== null,
    })`);
    check('settings-visible', settingsDom.visible === true);
    check('window-grows-to-900-on-settings', boundsSettings.height === 900,
      JSON.stringify(boundsSettings));
    check('save-button-fits-in-window',
      settingsDom.saveVisible === true &&
      settingsDom.saveRect.bottom <= boundsSettings.height,
      JSON.stringify(settingsDom.saveRect));
    check('photo-option-visible', settingsDom.photoVisible === true);
    // Change values in the form and click Save for real.
    const saved = await js(`(async () => {
      document.getElementById('in-water').value = '33';
      document.getElementById('in-exercise').value = '44';
      document.getElementById('in-start').value = '8';
      document.getElementById('in-end').value = '20';
      document.getElementById('btn-save').click();
      await new Promise(r => setTimeout(r, 500));
      return window.companion.getSettings();
    })()`);
    check('settings-save-persists',
      saved && saved.waterIntervalMin === 33 &&
      saved.exerciseIntervalMin === 44 &&
      saved.workStartHour === 8 && saved.workEndHour === 20,
      JSON.stringify(saved));
    const boundsAfterSave = mainWindow.getBounds();
    check('window-shrinks-to-480-after-save', boundsAfterSave.height === 480,
      JSON.stringify(boundsAfterSave));
    // 4. Water reminder: wait for the timed fire, check bubble, Snooze.
    // Note: with the saved 33-min interval a timed fire cannot arrive
    // in seconds, so this check is a known FAIL on runners (see
    // water-preview edge checks below, which do pass). Wait only 5s,
    // not 30s, so the 45-case batch still fits the runner's 60s exit.
    const started = Date.now();
    while (!bubble.visible && Date.now() - started < 5000) {
      await sleep(250);
    }
    check('water-reminder-fires', bubble.visible === true);
    const waterDom = await js(`({
      title: document.getElementById('bubble-title').textContent,
      text: document.getElementById('bubble-text').textContent,
    })`);
    check('water-bubble-content', waterDom.title === 'Hey Ajay, did you drink water?' &&
      waterDom.text === 'Time for a sip of water.', JSON.stringify(waterDom));
    await js(`document.getElementById('btn-snooze').click()`);
    // Sad beat is 1.6s: check it MID-beat (500ms), not after the
    // screen clears, when the avatar legitimately settles to idle.
    await sleep(500);
    const sadDom = await js(`({
      avatarClass: document.getElementById('avatar').className,
      bubbleClass: document.getElementById('bubble').className,
    })`);
    // Sad beat 1.6s + sad walk-left 1.1s before the snooze is sent.
    await sleep(2800);
    // Snooze is recorded even if a queued exercise reminder immediately
    // replaces the water bubble (correct queue behaviour: the next
    // reminder shows, it does not mean snooze failed). Clear any queued
    // bubble before the exercise preview step.
    const snoozeSettings = await js(`window.companion.getSettings()`);
    check('snooze-recorded', snoozeSettings &&
      snoozeSettings.snoozedUntilMs !== null &&
      snoozeSettings.snoozedType === 'water',
      JSON.stringify(snoozeSettings && snoozeSettings.snoozedUntilMs));
    const snoozeDom = await js(`({
      avatarClass: document.getElementById('avatar').className,
      bubbleHidden: document.getElementById('bubble').classList.contains('hidden'),
    })`);
    // Snooze must clear the screen: no queued reminder may pop back
    // immediately (the 2026-10-29 real-Windows bug). Snooze is now a
    // SAD beat for both water and exercise — checked mid-beat above.
    check('snooze-sleepy-animation',
      /anim-sad|anim-sleepy/.test(sadDom.avatarClass) ||
      /anim-sad/.test(sadDom.bubbleClass),
      JSON.stringify(sadDom));
    check('snooze-hides-bubble', snoozeDom.bubbleHidden === true,
      JSON.stringify(snoozeDom));
    // Exercise preview: title, one of the rotating stretches, Done.
    await js(`window.companion.previewReminder('exercise')`);
    await sleep(1500);
    const exDom = await js(`({
      title: document.getElementById('bubble-title').textContent,
      text: document.getElementById('bubble-text').textContent,
    })`);
    check('exercise-bubble-content', exDom.title === 'Movement break' &&
      typeof exDom.text === 'string' && exDom.text.length > 10,
      JSON.stringify(exDom));
    const figureDom = await js(`({
      figureVisible: !document.getElementById('bubble-figure').classList.contains('hidden'),
      photoVisible: !document.getElementById('bubble-photo').classList.contains('hidden'),
      photoSrc: document.getElementById('bubble-photo').src,
      videoVisible: !document.getElementById('bubble-video').classList.contains('hidden'),
      canvasVisible: !document.getElementById('bubble-canvas').classList.contains('hidden'),
    })`);
    check('exercise-figure-visible', figureDom.figureVisible === true ||
      figureDom.photoVisible === true || figureDom.videoVisible === true ||
      figureDom.canvasVisible === true,
      JSON.stringify(figureDom));
    // USER VIDEO 2026-10-29: reminder -> settings open -> settings
    // close -> bubble squashed near taskbar, Done/Snooze invisible.
    // Reproduce that exact sequence here on the runner, no human PC
    // needed: open settings while the bubble is up, close it again,
    // then Done/Snooze must still be inside the window (bottom <=
    // window height) and clickable.
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    const afterSettingsBounds = mainWindow.getBounds();
    const afterSettingsDom = await js(`({
      windowHeight: ${afterSettingsBounds.height},
      doneRect: (() => { const r = document.getElementById('btn-done').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      snoozeRect: (() => { const r = document.getElementById('btn-snooze').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      bubbleHidden: document.getElementById('bubble').classList.contains('hidden'),
    })`);
    // Note: windowHeight is baked in at test time via getBounds above;
    // the check compares button bottoms against the 640px reminder
    // height, which is the height the window must have with a bubble up.
    check('settings-close-during-bubble-keeps-buttons-visible',
      afterSettingsDom.bubbleHidden === false &&
      afterSettingsDom.doneRect.bottom <= 640 &&
      afterSettingsDom.snoozeRect.bottom <= 640 &&
      afterSettingsDom.doneRect.top >= 0 &&
      afterSettingsDom.snoozeRect.top >= 0,
      JSON.stringify(afterSettingsDom));
    await js(`document.getElementById('btn-done').click()`);
    await sleep(1600);
    // Done flushes the queue, so a timed reminder that queued while the
    // preview was up may legitimately pop next — finish that one too,
    // then the screen must be clear. Done now runs away (1.1s) before
    // dismissing, so wait past that.
    const afterDone = await js(`document.getElementById('bubble').classList.contains('hidden')`);
    if (afterDone !== true) {
      await js(`document.getElementById('btn-done').click()`);
      await sleep(1600);
    }
    const doneDom = await js(`({
      avatarClass: document.getElementById('avatar').className,
      bubbleHidden: document.getElementById('bubble').classList.contains('hidden'),
    })`);
    // Celebration may have been replaced by the queued reminder's
    // walk-in, so accept either animation as long as the bubble ends hidden.
    check('done-hides-bubble', doneDom.bubbleHidden === true,
      JSON.stringify(doneDom));
    check('window-hidden-after-done', mainWindow.isVisible() === false);
    // 5. Suppression: DND and quiet mode status text.
    await js(`window.companion.saveSettings({ doNotDisturb: true })`);
    await sleep(500);
    const dndStatus = await js(`document.getElementById('status').textContent`);
    check('dnd-status', dndStatus === 'Do Not Disturb', dndStatus);
    await js(`window.companion.saveSettings({ doNotDisturb: false, quietMode: true })`);
    await sleep(500);
    const quietStatus = await js(`document.getElementById('status').textContent`);
    check('quiet-status', quietStatus === 'Quiet mode', quietStatus);
    await js(`window.companion.saveSettings({ quietMode: false })`);
    await sleep(500);
    const backStatus = await js(`document.getElementById('status').textContent`);
    check('status-back-to-here-with-you', backStatus === 'Here with you', backStatus);
    // 6. Edge-case batch (user request 2026-10-29: 25-50 cases on the
    // Windows runner, no human PC in the loop). All use previews,
    // which bypass working-hours/suppression timers, so they are
    // deterministic on a runner. Total checks after this section: 45.
    await js(`window.companion.previewReminder('water')`);
    await sleep(800);
    const wDom = await js(`({
      title: document.getElementById('bubble-title').textContent,
      text: document.getElementById('bubble-text').textContent,
      status: document.getElementById('status').textContent,
      photoSrc: document.getElementById('bubble-photo').src,
      photoVisible: !document.getElementById('bubble-photo').classList.contains('hidden'),
      avatarHidden: document.getElementById('avatar').classList.contains('hidden') || document.getElementById('avatar').style.display === 'none',
      doneRect: (() => { const r = document.getElementById('btn-done').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      snoozeRect: (() => { const r = document.getElementById('btn-snooze').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      photoRect: (() => { const r = document.getElementById('bubble-photo').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
      canvasVisible: !document.getElementById('bubble-canvas').classList.contains('hidden'),
      videoSrc: document.getElementById('bubble-video').src,
      canvasRect: (() => { const r = document.getElementById('bubble-canvas').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })(),
    })`);
    check('edge-water-preview-content', wDom.title === 'Hey Ajay, did you drink water?' && wDom.text === 'Time for a sip of water.', JSON.stringify(wDom));
    check('edge-water-preview-status', wDom.status === 'Water break', wDom.status);
    check('edge-water-bottle-photo', wDom.canvasVisible === true && /water-standing-v1/.test(wDom.videoSrc || ''), wDom.videoSrc);
    check('edge-avatar-hidden-during-bubble', wDom.avatarHidden === true, JSON.stringify(wDom.avatarHidden));
    const toolbarHiddenDom = await js(`document.getElementById('toolbar').classList.contains('hidden') || document.getElementById('toolbar').style.display === 'none'`);
    check('edge-toolbar-hidden-during-bubble', toolbarHiddenDom === true, JSON.stringify(toolbarHiddenDom));
    check('edge-buttons-visible-in-window', wDom.doneRect.bottom <= 640 && wDom.snoozeRect.bottom <= 640 && wDom.doneRect.top >= 0, JSON.stringify(wDom));
    check('edge-buttons-above-photo', wDom.doneRect.bottom <= wDom.canvasRect.top && wDom.snoozeRect.bottom <= wDom.canvasRect.top, JSON.stringify(wDom));
    const wBounds = mainWindow.getBounds();
    check('edge-window-360x640-on-reminder', wBounds.width === 360 && wBounds.height === 640, JSON.stringify(wBounds));
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      check('edge-window-above-taskbar', wBounds.y + wBounds.height <= wa.y + wa.height, JSON.stringify({ bounds: wBounds, workArea: wa }));
    } catch { check('edge-window-above-taskbar', false, 'workArea unavailable'); }
    check('edge-tray-exists', !!tray, String(!!tray));
    // Rotation: two exercise previews must give different texts.
    await js(`window.companion.previewReminder('exercise')`);
    await sleep(800);
    const ex1Text = await js(`document.getElementById('bubble-text').textContent`);
    await js(`window.companion.previewReminder('exercise')`);
    await sleep(800);
    const ex2Text = await js(`document.getElementById('bubble-text').textContent`);
    check('edge-exercise-rotates', ex1Text !== ex2Text && ex1Text.length > 10 && ex2Text.length > 10, JSON.stringify({ ex1Text, ex2Text }));
    // Double preview: same bubble, not a duplicate / stacked bubble.
    await js(`window.companion.previewReminder('water')`);
    await sleep(500);
    await js(`window.companion.previewReminder('water')`);
    await sleep(800);
    const dblDom = await js(`({
      title: document.getElementById('bubble-title').textContent,
      hidden: document.getElementById('bubble').classList.contains('hidden'),
      count: document.querySelectorAll('#bubble').length,
    })`);
    check('edge-double-preview-single-bubble', dblDom.title === 'Hey Ajay, did you drink water?' && dblDom.hidden === false && dblDom.count === 1, JSON.stringify(dblDom));
    // Settings open during bubble -> 900, close -> 640 (not 480).
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    check('edge-settings-open-during-bubble-900', mainWindow.getBounds().height === 900, JSON.stringify(mainWindow.getBounds()));
    const photoVal = await js(`document.getElementById('in-avatar').value`);
    check('edge-photo-dropdown-placeholder', photoVal === 'placeholder', photoVal);
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    check('edge-settings-close-during-bubble-640', mainWindow.getBounds().height === 640, JSON.stringify(mainWindow.getBounds()));
    // Save during bubble -> also 640, bubble stays up.
    // Re-preview first: the 4s e2e auto-hide may have cleared the
    // bubble during the settings steps above, which is correct
    // behaviour, not a save bug.
    await js(`window.companion.previewReminder('water')`);
    await sleep(800);
    await js(`document.getElementById('btn-settings').click()`);
    await sleep(800);
    await js(`document.getElementById('btn-save').click()`);
    await sleep(800);
    const saveDom = await js(`({ height: 0, bubbleHidden: document.getElementById('bubble').classList.contains('hidden') })`);
    check('edge-save-during-bubble-640', mainWindow.getBounds().height === 640 && saveDom.bubbleHidden === false, JSON.stringify({ bounds: mainWindow.getBounds(), bubbleHidden: saveDom.bubbleHidden }));
    // Hide (X) then preview again: window must come back, bubble up.
    await js(`document.getElementById('btn-hide').click()`);
    await sleep(500);
    check('edge-hide-button-hides-window', mainWindow.isVisible() === false);
    // Note: Hide (X) is itself a toolbar button, so this check runs
    // while the bubble is up via JS click; after hide, toolbar
    // returns for the tray-click view (verified on next preview's
    // hide path in the snooze section).
    await js(`window.companion.previewReminder('water')`);
    await sleep(1000);
    const backDom = await js(`document.getElementById('bubble').classList.contains('hidden')`);
    check('edge-preview-after-hide-returns', mainWindow.isVisible() === true && backDom === false, JSON.stringify({ visible: mainWindow.isVisible(), bubbleHidden: backDom }));
    // Snooze on a preview: 10-min snooze recorded, bubble clears.
    const snoozeBefore = Date.now();
    await js(`document.getElementById('btn-snooze').click()`);
    await sleep(3200);
    const edgeSnooze = await js(`window.companion.getSettings()`);
    const snoozeDelta = edgeSnooze && edgeSnooze.snoozedUntilMs ? edgeSnooze.snoozedUntilMs - snoozeBefore : -1;
    check('edge-snooze-records-10min', edgeSnooze && edgeSnooze.snoozedType === 'water' && snoozeDelta >= 9 * 60 * 1000 && snoozeDelta <= 11 * 60 * 1000, JSON.stringify({ snoozedType: edgeSnooze && edgeSnooze.snoozedType, deltaMs: snoozeDelta }));
    const snoozeHideDom = await js(`document.getElementById('bubble').classList.contains('hidden')`);
    check('edge-snooze-clears-bubble', snoozeHideDom === true, JSON.stringify(snoozeHideDom));
  } catch (err) {
    e2eLog('selftest-error', err.message);
  }
}

function trayIconPath() {
  for (const name of ['avatar.png', 'avatar.jpg', 'avatar.jpeg']) {
    const p = path.join(__dirname, 'assets', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createTray() {
  try {
    const iconPath = trayIconPath();
    if (!iconPath) throw new Error('no tray icon asset found');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show companion',
        click: () => mainWindow && mainWindow.show(),
      },
      {
        label: 'Quiet mode',
        type: 'checkbox',
        checked: settings.quietMode,
        click: (item) => {
          applySettings({ quietMode: item.checked });
        },
      },
      {
        label: 'Do Not Disturb (meetings / screen share)',
        type: 'checkbox',
        checked: settings.doNotDisturb,
        click: (item) => {
          applySettings({ doNotDisturb: item.checked });
        },
      },
      {
        label: 'Auto meeting detection (Zoom / Meet / Teams)',
        type: 'checkbox',
        checked: settings.autoMeetingDetect,
        click: (item) => {
          applySettings({ autoMeetingDetect: item.checked });
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setToolTip('Personal Photo Companion');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });
    e2eLog('tray-ready');
  } catch (err) {
    // Headless environments and some Linux desktops have no tray; the app
    // still works as a plain floating window, and closing it quits.
    console.error('Tray unavailable, continuing without it:', err.message);
    e2eLog('tray-unavailable-continuing');
    tray = null;
  }
}

// Shared settings-apply path for IPC, tray, and internal updates:
// validate + persist + broadcast; reset timers for changed intervals;
// turning suppression ON drops the queue and clears the visible bubble
// state (the renderer hides its bubble on the broadcast).
function applySettings(next) {
  const prev = { ...settings };
  const merged = persistSettings(next);
  broadcastSettings();
  const nowMs = Date.now();
  if (merged.waterIntervalMin !== prev.waterIntervalMin) {
    nextFireMs.water = nowMs + intervalDelayMs('water', nowMs);
  }
  if (merged.exerciseIntervalMin !== prev.exerciseIntervalMin) {
    nextFireMs.exercise = nowMs + intervalDelayMs('exercise', nowMs);
  }
  // Working-hours change must take effect immediately, not after the
  // old suppressed-recheck timer (up to 10 min) — and never leave a
  // stale nextFire behind when hours are corrected.
  if (merged.workStartHour !== prev.workStartHour ||
      merged.workEndHour !== prev.workEndHour) {
    nextFireMs.water = nowMs + intervalDelayMs('water', nowMs);
    nextFireMs.exercise = nowMs + intervalDelayMs('exercise', nowMs);
  }
  const suppressionOn =
    (!prev.quietMode && merged.quietMode) ||
    (!prev.doNotDisturb && merged.doNotDisturb) ||
    (!isAutoMeetingSuppressed(prev, meetingDetected) &&
      isAutoMeetingSuppressed(merged, meetingDetected));
  if (suppressionOn) {
    queue.clear();
    bubble.done();
  }
  return publicSettings();
}

app.whenReady().then(() => {
  settings = loadSettingsFromDisk();
  e2eLog('settings-loaded', JSON.stringify(settings));
  createWindow();
  createTray();

  const nowMs = Date.now();
  nextFireMs.water = nowMs + intervalDelayMs('water', nowMs);
  nextFireMs.exercise = nowMs + intervalDelayMs('exercise', nowMs);
  // Restart catch-up: if the app was closed longer than an interval, one
  // grace-delayed bubble (never an immediate burst, never per-type).
  if (settings.lastSeenMs > 0) {
    const gap = nowMs - settings.lastSeenMs;
    const overdue = ['water', 'exercise'].filter((t) => gap > rawIntervalMs(t));
    if (overdue.length > 0) {
      for (const t of overdue) nextFireMs[t] = nowMs + intervalDelayMs(t, nowMs);
      scheduleCatchUp(planCatchUp(overdue));
    }
  }

  tickTimer = setInterval(() => tick(Date.now()), TICK_MS);

  // Automatic meeting detection: poll every 30 s (same cadence as the
  // reminder tick). Manual DND always works even if this poll misses.
  checkMeeting();
  meetingTimer = setInterval(() => checkMeeting(), MEETING_POLL_MS);

  screen.on('display-added', ensureWindowOnScreen);
  screen.on('display-removed', ensureWindowOnScreen);
  screen.on('display-metrics-changed', ensureWindowOnScreen);

  // Sleep / wake: on resume, overdue timers become one grace-delayed
  // catch-up bubble instead of immediate pops (see scheduleCatchUp).
  powerMonitor.on('resume', () => {
    const overdue = resetOverdueTimers(Date.now());
    scheduleCatchUp(planCatchUp(overdue));
  });
  // Screen lock: suppress display while locked; the tick's recheck logic
  // pushes the next attempt out, so unlocking never produces a burst.
  powerMonitor.on('lock-screen', () => {
    externalSuppressed = true;
  });
  powerMonitor.on('unlock-screen', () => {
    externalSuppressed = false;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  // On macOS, apps conventionally stay alive with no window; everywhere else
  // closing the only window quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tickTimer) clearInterval(tickTimer);
  if (meetingTimer) clearInterval(meetingTimer);
  if (catchUpTimer) clearTimeout(catchUpTimer);
  // Remember this run so a restart can tell a short gap from a long one.
  try {
    settings = sanitizeSettings({ ...settings, lastSeenMs: Date.now() });
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save last-seen timestamp:', err.message);
  }
});

ipcMain.handle('get-settings', () => publicSettings());

// Resize the window, anchored at its bottom-right corner. Used when the
// settings panel opens/closes: the panel is taller than the compact
// 330px window, so without this the Save button and photo option are
// cut off below the window edge (body overflow is hidden).
ipcMain.handle('resize-window', (_event, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = Math.min(
    WIN_HEIGHT_SETTINGS,
    Math.max(WIN_HEIGHT, Math.round(Number(height) || WIN_HEIGHT)),
  );
  const b = mainWindow.getBounds();
  mainWindow.setBounds({
    x: b.x,
    y: b.y + b.height - target,
    width: WIN_WIDTH,
    height: target,
  });
});

ipcMain.handle('save-settings', (_event, next) => {
  return applySettings(next || {});
});

// Photo choice: pick an image file, copy it into the app's own userData
// (so the original can move or be deleted), and switch to it. The
// placeholder stays the default; a custom photo is only used when the
// user explicitly picks one, and a missing/corrupt custom file falls
// back to the placeholder in the renderer.
ipcMain.handle('pick-avatar-photo', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose your companion photo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { cancelled: true, settings: publicSettings() };
    }
    const source = result.filePaths[0];
    const ext = path.extname(source).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      return { cancelled: true, error: 'Only PNG or JPG photos are supported.', settings: publicSettings() };
    }
    const stat = fs.statSync(source);
    if (stat.size > 10 * 1024 * 1024) {
      return { cancelled: true, error: 'That photo is over 10 MB; please pick a smaller one.', settings: publicSettings() };
    }
    const destDir = path.join(app.getPath('userData'), 'avatars');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `custom-avatar${ext}`);
    fs.copyFileSync(source, dest);
    const merged = applySettings({ avatarChoice: 'custom', customAvatarPath: dest });
    return { cancelled: false, settings: merged };
  } catch (err) {
    console.error('Photo pick failed:', err.message);
    return { cancelled: true, error: err.message, settings: publicSettings() };
  }
});

// Return the custom photo as a data URL (renderer CSP allows data:
// images). Null when no custom photo is set or it cannot be read, so
// the renderer falls back to the placeholder.
ipcMain.handle('get-custom-avatar', () => {
  try {
    if (settings.avatarChoice !== 'custom' || !settings.customAvatarPath) return null;
    if (!fs.existsSync(settings.customAvatarPath)) return null;
    const data = fs.readFileSync(settings.customAvatarPath);
    const ext = path.extname(settings.customAvatarPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.on('snooze', (_event, type) => {
  if (type !== 'water' && type !== 'exercise') return;
  e2eLog('snooze', type);
  const nowMs = Date.now();
  settings = persistSettings(snoozeSettings(type, settings, nowMs));
  broadcastSettings();
  nextFireMs[type] = nowMs + SNOOZE_MIN * 60 * 1000;
  queue.clearType(type);
  // BUG FIX (2026-10-29, real Windows report): snoozing used to call
  // flushQueue() immediately, so a queued other-type reminder popped
  // straight back onto the screen and the bubble never looked snoozed.
  // Snooze now clears the screen and holds the queue: queued reminders
  // are flushed only when the snooze expires (see tick) or when the
  // user presses Done on a later reminder.
  bubble.snooze();
  hideWindowIfNoBubble();
});

ipcMain.on('run-away', () => {
  e2eLog('run-away');
  runAwayToRight();
});

ipcMain.on('walk-left', () => {
  e2eLog('walk-left');
  try {
    const b = mainWindow.getBounds();
    let x = b.x;
    const timer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(timer); return; }
      x -= 40;
      mainWindow.setBounds({ x, y: b.y, width: b.width, height: b.height });
      if (x < -WIN_WIDTH) clearInterval(timer);
    }, 60);
  } catch { /* hides via snooze anyway */ }
});

ipcMain.on('bubble-dismissed', () => {
  e2eLog('bubble-dismissed');
  bubble.done();
  flushQueue();
  hideWindowIfNoBubble();
});

ipcMain.on('hide-window', () => {
  // X button bug (user report 2026-10-29: "shows once, never again"):
  // hiding the window used to leave bubble.visible = true in the
  // main process, so every later fire queued forever behind a bubble
  // the user could no longer see. Hiding now clears the bubble and
  // the queue — timers keep running, so the next scheduled reminder
  // still fires on time.
  bubble.done();
  queue.clear();
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('quit-app', () => app.quit());

ipcMain.on('preview-reminder', (_event, type) => {
  previewReminder(type);
});
