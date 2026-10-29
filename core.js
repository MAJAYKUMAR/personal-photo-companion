// Personal Photo Companion — testable core logic (no Electron dependency).
// This module is deliberately free of Electron, windows, timers and I/O so
// it can be unit-tested with plain Node. The Electron shell (main.js) owns
// windows, tray, IPC and scheduling; it calls into this module for decisions.
//
// Feature set (unchanged): water reminders (45 min default), exercise
// reminders (60 min default, rotating 10 general desk stretches — general
// movement only, no medical claims), working-hours gating (9–18 default),
// quiet mode, and an explicit Do Not Disturb / meeting mode. On-device only.

'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  waterIntervalMin: 45,
  exerciseIntervalMin: 60,
  workStartHour: 9, // 9:00 AM local time
  workEndHour: 18, // 6:00 PM local time
  quietMode: false,
  doNotDisturb: false, // explicit meeting / screen-share suppression
  autoMeetingDetect: true, // automatic Zoom/Meet/Teams detection (best effort)
  avatarChoice: 'placeholder', // 'placeholder' | 'custom' (uploaded photo)
  customAvatarPath: '', // local path of the uploaded photo, or '' when none
  lastExerciseIndex: -1,
  lastSeenMs: 0, // last run timestamp (epoch ms); used for wake/restart catch-up
  snoozedUntilMs: null, // epoch ms, or null when no snooze is pending
  snoozedType: null, // 'water' | 'exercise' | null
});

const EXERCISES = Object.freeze([
  'Stand up and stretch your arms overhead for 30 seconds.',
  'Roll your shoulders backwards 10 times, then forwards 10 times.',
  'Do 10 gentle neck turns — look left, then right, slowly.',
  'Walk around the room for 2 minutes.',
  'Do 10 chair squats — stand up and sit down slowly.',
  'Stretch your wrists: press each palm gently back for 15 seconds.',
  'Do 10 calf raises while standing at your desk.',
  'Shake out your hands and arms for 30 seconds.',
  'Do a gentle seated spinal twist, each side, holding 15 seconds.',
  'March in place for 1 minute.',
]);

const MIN_INTERVAL_MIN = 1;
const MAX_INTERVAL_MIN = 480; // 8 hours — anything larger is a typo, not a plan
const AUTO_HIDE_MS = 90 * 1000;
const SNOOZE_MIN = 10;
const SUPPRESSED_RECHECK_MIN = 10;

function clampInt(value, min, max, fallback) {
  // Strict parsing: only finite numbers and non-empty numeric strings count.
  // Booleans, empty strings, null, NaN, and Infinity fall back. Note that 0
  // IS valid (midnight as a start hour) and must survive — this must never
  // be written as `Number(x) || fallback`, where 0 would become the fallback.
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate + normalise any partial settings object. Unknown fields are
// dropped; invalid fields fall back to defaults. Crucially this does NOT
// use `Number(x) || fallback`: hour 0 (midnight) is a valid start hour and
// must survive sanitisation, unlike the old v1 handler.
function sanitizeSettings(input) {
  const raw = isPlainObject(input) ? input : {};
  const base = DEFAULT_SETTINGS;
  const lastIndex = clampInt(
    raw.lastExerciseIndex,
    -1,
    EXERCISES.length - 1,
    base.lastExerciseIndex,
  );
  const snoozedUntilMs =
    Number.isFinite(Number(raw.snoozedUntilMs)) && Number(raw.snoozedUntilMs) > 0
      ? Math.round(Number(raw.snoozedUntilMs))
      : null;
  const snoozedType =
    snoozedUntilMs !== null && (raw.snoozedType === 'water' || raw.snoozedType === 'exercise')
      ? raw.snoozedType
      : null;
  return {
    waterIntervalMin: clampInt(
      raw.waterIntervalMin, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, base.waterIntervalMin,
    ),
    exerciseIntervalMin: clampInt(
      raw.exerciseIntervalMin, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, base.exerciseIntervalMin,
    ),
    workStartHour: clampInt(raw.workStartHour, 0, 23, base.workStartHour),
    workEndHour: clampInt(raw.workEndHour, 1, 24, base.workEndHour),
    // Strict booleans: the string "false" in a hand-edited file must NOT
    // enable quiet mode (Boolean("false") is true).
    quietMode: raw.quietMode === true,
    doNotDisturb: raw.doNotDisturb === true,
    // Auto meeting detection defaults ON for settings files written before
    // this field existed; only an explicit false turns it off.
    autoMeetingDetect: raw.autoMeetingDetect === undefined ? true : raw.autoMeetingDetect === true,
    avatarChoice: raw.avatarChoice === 'custom' ? 'custom' : 'placeholder',
    customAvatarPath:
      typeof raw.customAvatarPath === 'string' ? raw.customAvatarPath : '',
    lastExerciseIndex: lastIndex,
    lastSeenMs:
      Number.isFinite(Number(raw.lastSeenMs)) && Number(raw.lastSeenMs) > 0
        ? Math.round(Number(raw.lastSeenMs))
        : 0,
    // A snooze without a type (or vice versa) is discarded, not half-kept.
    snoozedUntilMs: snoozedType ? snoozedUntilMs : null,
    snoozedType,
  };
}

// Parse a settings file's text. Corrupt JSON, a JSON scalar/array, or an
// empty file all fall back to defaults instead of crashing or keeping
// half-parsed state. Existing valid fields are preserved through sanitize.
function settingsFromFileText(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ...DEFAULT_SETTINGS };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!isPlainObject(parsed)) return { ...DEFAULT_SETTINGS };
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
}

// Working-hours gate. Overnight ranges work: start 22, end 6 means on at
// 23:00 and at 02:00, off at noon. start == end means "always on" (a 24 h
// range), which is the only degenerate case, and it is explicit.
function withinWorkingHours(settings, now = new Date()) {
  const s = sanitizeSettings(settings);
  const h = now.getHours() + now.getMinutes() / 60;
  if (s.workStartHour === s.workEndHour) return true;
  if (s.workEndHour > s.workStartHour) {
    return h >= s.workStartHour && h < s.workEndHour;
  }
  // Overnight: on from start until midnight, and from midnight until end.
  return h >= s.workStartHour || h < s.workEndHour;
}

// Automatic meeting detection — title-based, best effort, deliberately
// conservative. A meeting app merely running in the background (Teams
// and Zoom both do this all day) must NOT suppress reminders, so a
// process name alone is never enough: detection requires a window title
// that actually names a meeting or a screen share. That avoids the
// all-day false positive, at the cost of missing meetings whose window
// title is just a meeting name with no app word in it — for those, the
// manual Do Not Disturb toggle remains the reliable fallback. This does
// NOT detect screen sharing by itself; it detects meeting windows.
const MEETING_TITLE_PATTERNS = [
  { app: 'Zoom', pattern: /zoom\s+meeting/i },
  { app: 'Google Meet', pattern: /google\s+meet/i },
  { app: 'Google Meet', pattern: /^\s*meet\s*[-–—]/i },
  { app: 'Teams', pattern: /teams\s+(meeting|call)/i },
  { app: 'Teams', pattern: /microsoft\s+teams\s+(meeting|call)/i },
  { app: 'Screen share', pattern: /sharing\s+your\s+screen/i },
  { app: 'Screen share', pattern: /you\s+are\s+sharing/i },
];
const MEETING_PROCESS_APPS = {
  zoom: 'Zoom',
  'zoom.us': 'Zoom',
  teams: 'Teams',
  'ms-teams': 'Teams',
  'microsoft teams': 'Teams',
};
const MEETING_POLL_MS = 30 * 1000;

function normalizeProcessName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/\.app$/, '')
    .trim();
}

function meetingAppFromProcess(name) {
  return MEETING_PROCESS_APPS[normalizeProcessName(name)] || null;
}

// Pure detection: { processes: [names], windowTitles: [titles] }.
// Returns { detected, app, source, candidateApp } where candidateApp is
// the meeting app seen running (if any) even when no meeting title was
// found — useful for logging, never for suppression on its own.
function detectMeeting(input) {
  const titles = Array.isArray(input && input.windowTitles) ? input.windowTitles : [];
  const processes = Array.isArray(input && input.processes) ? input.processes : [];
  let candidateApp = null;
  for (const p of processes) {
    const app = meetingAppFromProcess(p);
    if (app && !candidateApp) candidateApp = app;
  }
  for (const rawTitle of titles) {
    const title = String(rawTitle || '');
    if (!title.trim()) continue;
    for (const entry of MEETING_TITLE_PATTERNS) {
      if (entry.pattern.test(title)) {
        return { detected: true, app: entry.app, source: 'window-title', candidateApp };
      }
    }
  }
  return { detected: false, app: null, source: null, candidateApp };
}

// Shell-level suppression from automatic detection, separate from the
// manual settings: on only when the user left auto detection enabled
// AND a meeting window was actually detected on the last poll.
function isAutoMeetingSuppressed(settings, meetingDetected) {
  const s = sanitizeSettings(settings);
  return s.autoMeetingDetect === true && meetingDetected === true;
}

// A reminder may fire only when quiet mode and Do Not Disturb are both off
// and the working-hours gate passes. Do Not Disturb is the meeting /
// screen-share suppression path: it is explicit and user-controlled.
// Automatic detection (detectMeeting + isAutoMeetingSuppressed, owned by
// the shell in main.js) is an additional layer on top of this, not a
// replacement: plain Electron cannot reliably detect screen sharing or
// another app's fullscreen state without native modules.
function remindersAllowed(settings, now = new Date()) {
  const s = sanitizeSettings(settings);
  return !s.quietMode && !s.doNotDisturb && withinWorkingHours(s, now);
}

function nextExerciseIndex(settings) {
  const s = sanitizeSettings(settings);
  return (s.lastExerciseIndex + 1) % EXERCISES.length;
}

// Pure rotation step: returns the next exercise and updated settings.
function rotateExercise(settings) {
  const s = sanitizeSettings(settings);
  const index = nextExerciseIndex(s);
  return { index, text: EXERCISES[index], settings: { ...s, lastExerciseIndex: index } };
}

// Delay (ms) before the next reminder of a type should fire. A pending
// snooze for that type wins over the regular interval; an expired snooze
// is ignored (and the caller should clear it). Never returns NaN/negative.
function delayMsForReminder(type, settings, nowMs = Date.now()) {
  const s = sanitizeSettings(settings);
  const intervalMin = type === 'water' ? s.waterIntervalMin : s.exerciseIntervalMin;
  if (s.snoozedType === type && s.snoozedUntilMs !== null && s.snoozedUntilMs > nowMs) {
    return s.snoozedUntilMs - nowMs;
  }
  return intervalMin * 60 * 1000;
}

// Start a 10-minute snooze for a type. Returns updated settings.
function snoozeSettings(type, settings, nowMs = Date.now()) {
  const s = sanitizeSettings(settings);
  if (type !== 'water' && type !== 'exercise') return s;
  return { ...s, snoozedUntilMs: nowMs + SNOOZE_MIN * 60 * 1000, snoozedType: type };
}

// First existing avatar candidate, or null when none exists. The renderer
// falls back to a built-in placeholder in that case; a missing/corrupt file
// must never crash the app.
function resolveAvatar(candidates, exists) {
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // A throwing existence check counts as "not found" for this candidate.
    }
  }
  return null;
}

// Speech-bubble state machine (no DOM, no timers — the shell owns timing).
// show -> visible; done -> hidden; snooze -> hidden + returns the type to
// snooze (null when nothing is visible, so a stray click snoozes nothing);
// expire -> hidden (the 90 s auto-hide). Done and auto-hide never snooze.
class BubbleState {
  constructor() {
    this.visible = false;
    this.type = null;
  }

  show(type) {
    if (type !== 'water' && type !== 'exercise') return false;
    this.visible = true;
    this.type = type;
    return true;
  }

  done() {
    this.visible = false;
    this.type = null;
    return null;
  }

  snooze() {
    const type = this.visible ? this.type : null;
    this.visible = false;
    this.type = null;
    return type;
  }

  expire() {
    return this.done();
  }
}

// Delay before a post-wake / post-restart catch-up bubble. A catch-up is
// never immediate and never one bubble per missed type (see planCatchUp).
const CATCH_UP_GRACE_MS = 3 * 60 * 1000;

// Small queue for pending reminders. At most one pending reminder per type:
// a newer one replaces the older one, so back-to-back firings never stack
// into a burst of overlapping bubbles — they display one at a time, in
// order, and the shell drops the queue when suppression turns on.
class ReminderQueue {
  constructor() {
    this.items = [];
  }

  enqueue(reminder) {
    const i = this.items.findIndex((r) => r.type === reminder.type);
    if (i >= 0) this.items[i] = reminder;
    else this.items.push(reminder);
    return this.items.length;
  }

  dequeue() {
    return this.items.shift() || null;
  }

  peek() {
    return this.items[0] || null;
  }

  clearType(type) {
    this.items = this.items.filter((r) => r.type !== type);
  }

  clear() {
    this.items = [];
  }

  get length() {
    return this.items.length;
  }
}

// Which reminder types are overdue, given a { type: nextFireMs } map.
function overdueTypes(nextFireMs, nowMs) {
  return Object.keys(nextFireMs || {}).filter((t) => nextFireMs[t] <= nowMs);
}

// Catch-up plan for a wake/restart: at most ONE bubble, after a grace
// delay, for the first overdue type (water takes priority by list order).
// Returns { due, type, delayMs }. The caller resets overdue timers to
// now + interval and schedules the single bubble; if reminders are
// suppressed at grace time, the bubble is dropped, not deferred.
function planCatchUp(overdue) {
  if (!overdue || overdue.length === 0) return { due: false, type: null, delayMs: 0 };
  return { due: true, type: overdue[0], delayMs: CATCH_UP_GRACE_MS };
}

// Second-instance decision (the real OS lock lives in main.js via
// app.requestSingleInstanceLock; this is the pure decision around it).
function isSecondInstance(gotLock) {
  return gotLock !== true;
}

function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function isRectOnAnyScreen(bounds, workAreas) {
  return (workAreas || []).some((area) => rectsOverlap(bounds, area));
}

// Bottom-right position inside a work area, with a margin, clamped so the
// window never hangs off-screen even on a small display.
function bottomRightPosition(workArea, winWidth, winHeight, margin = 16) {
  const maxX = workArea.x + Math.max(0, workArea.width - winWidth - margin);
  const maxY = workArea.y + Math.max(0, workArea.height - winHeight - margin);
  return {
    x: Math.max(workArea.x, maxX),
    y: Math.max(workArea.y, maxY),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  EXERCISES,
  MIN_INTERVAL_MIN,
  MAX_INTERVAL_MIN,
  AUTO_HIDE_MS,
  SNOOZE_MIN,
  SUPPRESSED_RECHECK_MIN,
  CATCH_UP_GRACE_MS,
  clampInt,
  sanitizeSettings,
  settingsFromFileText,
  withinWorkingHours,
  remindersAllowed,
  MEETING_POLL_MS,
  MEETING_TITLE_PATTERNS,
  normalizeProcessName,
  meetingAppFromProcess,
  detectMeeting,
  isAutoMeetingSuppressed,
  nextExerciseIndex,
  rotateExercise,
  delayMsForReminder,
  snoozeSettings,
  resolveAvatar,
  BubbleState,
  ReminderQueue,
  overdueTypes,
  planCatchUp,
  isSecondInstance,
  rectsOverlap,
  isRectOnAnyScreen,
  bottomRightPosition,
};
