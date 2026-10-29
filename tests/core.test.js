// Unit tests for core.js — pure logic, no Electron, no display needed.
// Run: npm run test:unit   (or: node --test tests/core.test.js)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  EXERCISES,
  AUTO_HIDE_MS,
  SNOOZE_MIN,
  SUPPRESSED_RECHECK_MIN,
  CATCH_UP_GRACE_MS,
  clampInt,
  sanitizeSettings,
  settingsFromFileText,
  withinWorkingHours,
  remindersAllowed,
  detectMeeting,
  isAutoMeetingSuppressed,
  meetingAppFromProcess,
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
} = require('../core');

const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0, 0);

test('clampInt: 0 is valid and never becomes the fallback', () => {
  assert.equal(clampInt(0, 0, 23, 9), 0);
  assert.equal(clampInt('0', 0, 23, 9), 0);
  assert.equal(clampInt('45', 1, 480, 45), 45);
  assert.equal(clampInt(45.6, 1, 480, 45), 46);
  assert.equal(clampInt('', 0, 23, 9), 9);
  assert.equal(clampInt('   ', 0, 23, 9), 9);
  assert.equal(clampInt(true, 0, 23, 9), 9);
  assert.equal(clampInt(null, 0, 23, 9), 9);
  assert.equal(clampInt(undefined, 0, 23, 9), 9);
  assert.equal(clampInt(NaN, 0, 23, 9), 9);
  assert.equal(clampInt(Infinity, 0, 23, 9), 9);
  assert.equal(clampInt('abc', 0, 23, 9), 9);
  assert.equal(clampInt(9999, 1, 480, 45), 480);
  assert.equal(clampInt(-5, 1, 480, 45), 1);
});

test('sanitizeSettings: defaults for empty, null, array, and scalar input', () => {
  for (const bad of [undefined, null, [], 'x', 42, true]) {
    const s = sanitizeSettings(bad);
    assert.equal(s.waterIntervalMin, 45);
    assert.equal(s.workStartHour, 9);
    assert.equal(s.quietMode, false);
    assert.equal(s.doNotDisturb, false);
  }
});

test('sanitizeSettings: midnight start hour survives (v1 regression)', () => {
  assert.equal(sanitizeSettings({ workStartHour: 0 }).workStartHour, 0);
  assert.equal(sanitizeSettings({ workStartHour: '0' }).workStartHour, 0);
});

test('sanitizeSettings: ranges are clamped, unknown keys dropped', () => {
  const s = sanitizeSettings({
    waterIntervalMin: 9999,
    exerciseIntervalMin: -3,
    workStartHour: 25,
    workEndHour: 30,
    unknownKey: 'kept?',
    lastExerciseIndex: 999,
  });
  assert.equal(s.waterIntervalMin, 480);
  assert.equal(s.exerciseIntervalMin, 1);
  assert.equal(s.workStartHour, 23);
  assert.equal(s.workEndHour, 24);
  assert.equal(s.unknownKey, undefined);
  assert.equal(s.lastExerciseIndex, EXERCISES.length - 1);
  assert.equal(sanitizeSettings({ lastExerciseIndex: -5 }).lastExerciseIndex, -1);
});

test('sanitizeSettings: quiet/DND need a real boolean true', () => {
  assert.equal(sanitizeSettings({ quietMode: 'false' }).quietMode, false);
  assert.equal(sanitizeSettings({ quietMode: 1 }).quietMode, false);
  assert.equal(sanitizeSettings({ quietMode: true }).quietMode, true);
  assert.equal(sanitizeSettings({ doNotDisturb: 'yes' }).doNotDisturb, false);
  assert.equal(sanitizeSettings({ doNotDisturb: true }).doNotDisturb, true);
});

test('sanitizeSettings: snooze is kept only as a consistent pair', () => {
  const now = Date.now();
  const full = sanitizeSettings({ snoozedUntilMs: now + 600000, snoozedType: 'water' });
  assert.equal(full.snoozedUntilMs, now + 600000);
  assert.equal(full.snoozedType, 'water');
  const noType = sanitizeSettings({ snoozedUntilMs: now + 600000 });
  assert.equal(noType.snoozedUntilMs, null);
  assert.equal(noType.snoozedType, null);
  const noTime = sanitizeSettings({ snoozedType: 'water' });
  assert.equal(noTime.snoozedUntilMs, null);
  assert.equal(noTime.snoozedType, null);
  const badType = sanitizeSettings({ snoozedUntilMs: now + 600000, snoozedType: 'tea' });
  assert.equal(badType.snoozedUntilMs, null);
  assert.equal(sanitizeSettings({ lastSeenMs: -5 }).lastSeenMs, 0);
  assert.equal(sanitizeSettings({ lastSeenMs: 12345 }).lastSeenMs, 12345);
});

test('settingsFromFileText: valid, corrupt, scalar, and empty inputs', () => {
  const ok = settingsFromFileText('{"waterIntervalMin": 30, "quietMode": true}');
  assert.equal(ok.waterIntervalMin, 30);
  assert.equal(ok.quietMode, true);
  assert.equal(ok.exerciseIntervalMin, 60); // untouched keys keep defaults
  for (const bad of ['', '   ', '{not json', '42', '"str"', '[1,2]', 'null']) {
    const s = settingsFromFileText(bad);
    assert.equal(s.waterIntervalMin, 45);
    assert.equal(s.workStartHour, 9);
  }
});

test('withinWorkingHours: boundaries are start-inclusive, end-exclusive', () => {
  const s = { workStartHour: 9, workEndHour: 18 };
  assert.equal(withinWorkingHours(s, at(8, 59)), false);
  assert.equal(withinWorkingHours(s, at(9, 0)), true);
  assert.equal(withinWorkingHours(s, at(12, 30)), true);
  assert.equal(withinWorkingHours(s, at(17, 59)), true);
  assert.equal(withinWorkingHours(s, at(18, 0)), false);
  assert.equal(withinWorkingHours(s, at(23, 0)), false);
});

test('withinWorkingHours: overnight ranges and degenerate always-on', () => {
  const night = { workStartHour: 22, workEndHour: 6 };
  assert.equal(withinWorkingHours(night, at(23, 0)), true);
  assert.equal(withinWorkingHours(night, at(2, 0)), true);
  assert.equal(withinWorkingHours(night, at(5, 59)), true);
  assert.equal(withinWorkingHours(night, at(6, 0)), false);
  assert.equal(withinWorkingHours(night, at(12, 0)), false);
  const always = { workStartHour: 9, workEndHour: 9 };
  assert.equal(withinWorkingHours(always, at(3, 0)), true);
  assert.equal(withinWorkingHours(always, at(15, 0)), true);
});

test('remindersAllowed: quiet, DND, and hours each block independently', () => {
  const base = { workStartHour: 9, workEndHour: 18, quietMode: false, doNotDisturb: false };
  assert.equal(remindersAllowed(base, at(10)), true);
  assert.equal(remindersAllowed({ ...base, quietMode: true }, at(10)), false);
  assert.equal(remindersAllowed({ ...base, doNotDisturb: true }, at(10)), false);
  assert.equal(remindersAllowed(base, at(20)), false);
  // Suppression still blocks inside working hours; hours still block outside.
  assert.equal(remindersAllowed({ ...base, quietMode: true }, at(20)), false);
});

test('exercise rotation: order, wraparound, and payload', () => {
  assert.equal(nextExerciseIndex({ lastExerciseIndex: -1 }), 0);
  assert.equal(nextExerciseIndex({ lastExerciseIndex: 0 }), 1);
  assert.equal(nextExerciseIndex({ lastExerciseIndex: EXERCISES.length - 1 }), 0);
  const r = rotateExercise({ lastExerciseIndex: 2 });
  assert.equal(r.index, 3);
  assert.equal(r.text, EXERCISES[3]);
  assert.equal(r.settings.lastExerciseIndex, 3);
  const wrap = rotateExercise({ lastExerciseIndex: EXERCISES.length - 1 });
  assert.equal(wrap.index, 0);
  assert.equal(wrap.text, EXERCISES[0]);
});

test('delayMsForReminder: interval, pending snooze, expired snooze', () => {
  const now = Date.now();
  const base = { waterIntervalMin: 45, exerciseIntervalMin: 60 };
  assert.equal(delayMsForReminder('water', base, now), 45 * 60 * 1000);
  assert.equal(delayMsForReminder('exercise', base, now), 60 * 60 * 1000);
  const snoozed = { ...base, snoozedType: 'water', snoozedUntilMs: now + 5 * 60 * 1000 };
  assert.equal(delayMsForReminder('water', snoozed, now), 5 * 60 * 1000);
  // A snooze for the other type does not affect this one.
  assert.equal(delayMsForReminder('exercise', snoozed, now), 60 * 60 * 1000);
  const expired = { ...base, snoozedType: 'water', snoozedUntilMs: now - 1000 };
  assert.equal(delayMsForReminder('water', expired, now), 45 * 60 * 1000);
  assert.ok(Number.isFinite(delayMsForReminder('water', {}, now)));
  assert.ok(delayMsForReminder('water', {}, now) > 0);
});

test('snoozeSettings: 10-minute snooze, invalid type is a no-op', () => {
  const now = Date.now();
  const s = snoozeSettings('water', {}, now);
  assert.equal(s.snoozedType, 'water');
  assert.equal(s.snoozedUntilMs, now + SNOOZE_MIN * 60 * 1000);
  const unchanged = snoozeSettings('tea', { waterIntervalMin: 30 }, now);
  assert.equal(unchanged.snoozedType, null);
  assert.equal(unchanged.waterIntervalMin, 30);
});

test('resolveAvatar: first existing candidate wins; throws count as missing', () => {
  const exists = (name) => ['avatar.jpg', 'avatar.svg'].includes(name);
  assert.equal(
    resolveAvatar(['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.svg'], exists),
    'avatar.jpg',
  );
  assert.equal(resolveAvatar(['avatar.png', 'avatar.svg'], () => false), null);
  const flaky = (name) => {
    if (name === 'avatar.png') throw new Error('disk hiccup');
    return name === 'avatar.svg';
  };
  assert.equal(resolveAvatar(['avatar.png', 'avatar.svg'], flaky), 'avatar.svg');
});

test('BubbleState: show/done/snooze/expire state machine', () => {
  const b = new BubbleState();
  assert.equal(b.visible, false);
  assert.equal(b.snooze(), null); // stray snooze snoozes nothing
  assert.equal(b.show('tea'), false); // invalid type rejected
  assert.equal(b.visible, false);
  assert.equal(b.show('water'), true);
  assert.equal(b.visible, true);
  assert.equal(b.type, 'water');
  assert.equal(b.snooze(), 'water');
  assert.equal(b.visible, false);
  assert.equal(b.type, null);
  b.show('exercise');
  assert.equal(b.done(), null);
  assert.equal(b.visible, false);
  b.show('water');
  assert.equal(b.expire(), null); // auto-hide never snoozes
  assert.equal(b.visible, false);
  assert.equal(AUTO_HIDE_MS, 90 * 1000);
});

test('ReminderQueue: order, per-type coalescing, clearType, clear', () => {
  const q = new ReminderQueue();
  assert.equal(q.length, 0);
  assert.equal(q.dequeue(), null);
  q.enqueue({ type: 'water', text: 'a' });
  q.enqueue({ type: 'exercise', text: 'b' });
  assert.equal(q.length, 2);
  q.enqueue({ type: 'water', text: 'a2' }); // replaces, does not stack
  assert.equal(q.length, 2);
  assert.equal(q.peek().text, 'a2');
  assert.equal(q.dequeue().text, 'a2');
  assert.equal(q.dequeue().text, 'b');
  q.enqueue({ type: 'water', text: 'x' });
  q.enqueue({ type: 'exercise', text: 'y' });
  q.clearType('water');
  assert.equal(q.length, 1);
  assert.equal(q.peek().type, 'exercise');
  q.clear();
  assert.equal(q.length, 0);
});

test('overdueTypes + planCatchUp: at most one grace-delayed bubble', () => {
  assert.deepEqual(overdueTypes({ water: 100, exercise: 200 }, 150), ['water']);
  assert.deepEqual(overdueTypes({ water: 100, exercise: 200 }, 50), []);
  assert.deepEqual(overdueTypes({ water: 100, exercise: 100 }, 100), ['water', 'exercise']);
  assert.deepEqual(planCatchUp([]), { due: false, type: null, delayMs: 0 });
  assert.deepEqual(planCatchUp(null), { due: false, type: null, delayMs: 0 });
  const plan = planCatchUp(['water', 'exercise']);
  assert.equal(plan.due, true);
  assert.equal(plan.type, 'water'); // first overdue wins; never one per type
  assert.equal(plan.delayMs, CATCH_UP_GRACE_MS);
  assert.equal(CATCH_UP_GRACE_MS, 3 * 60 * 1000);
});

test('isSecondInstance: only a held lock means "not second"', () => {
  assert.equal(isSecondInstance(true), false);
  assert.equal(isSecondInstance(false), true);
  assert.equal(isSecondInstance(undefined), true);
  assert.equal(isSecondInstance(null), true);
});

test('screen geometry: overlap, any-screen, bottom-right clamping', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(rectsOverlap({ x: 10, y: 10, width: 10, height: 10 }, area), true);
  assert.equal(rectsOverlap({ x: 5000, y: 10, width: 10, height: 10 }, area), false);
  // Touching edges do not count as overlapping.
  assert.equal(rectsOverlap({ x: 1920, y: 0, width: 10, height: 10 }, area), false);
  const areas = [
    area,
    { x: 1920, y: 0, width: 1280, height: 1024 },
  ];
  assert.equal(isRectOnAnyScreen({ x: 2000, y: 100, width: 240, height: 330 }, areas), true);
  assert.equal(isRectOnAnyScreen({ x: 5000, y: 100, width: 240, height: 330 }, areas), false);
  assert.deepEqual(bottomRightPosition(area, 240, 330), { x: 1664, y: 734 });
  // A display smaller than the window clamps to the area origin.
  assert.deepEqual(bottomRightPosition({ x: 0, y: 0, width: 200, height: 200 }, 240, 330), {
    x: 0,
    y: 0,
  });
  // An offset primary display (e.g. secondary monitor as primary) is honoured.
  assert.deepEqual(
    bottomRightPosition({ x: 1920, y: 0, width: 1280, height: 1024 }, 240, 330),
    { x: 1920 + 1280 - 240 - 16, y: 1024 - 330 - 16 },
  );
});

test('constants: recheck and snooze intervals are 10 minutes', () => {
  assert.equal(SNOOZE_MIN, 10);
  assert.equal(SUPPRESSED_RECHECK_MIN, 10);
  assert.equal(EXERCISES.length, 10);
  assert.equal(DEFAULT_SETTINGS.waterIntervalMin, 45);
  assert.equal(DEFAULT_SETTINGS.exerciseIntervalMin, 60);
});

test('autoMeetingDetect + avatarChoice: defaults, explicit off, and bad values', () => {
  assert.equal(sanitizeSettings({}).autoMeetingDetect, true);
  assert.equal(sanitizeSettings({ autoMeetingDetect: false }).autoMeetingDetect, false);
  assert.equal(sanitizeSettings({ autoMeetingDetect: 'false' }).autoMeetingDetect, false);
  assert.equal(sanitizeSettings({ autoMeetingDetect: true }).autoMeetingDetect, true);
  assert.equal(sanitizeSettings({}).avatarChoice, 'placeholder');
  assert.equal(sanitizeSettings({ avatarChoice: 'custom', customAvatarPath: '/tmp/x.png' }).avatarChoice, 'custom');
  assert.equal(sanitizeSettings({ avatarChoice: 'custom', customAvatarPath: '/tmp/x.png' }).customAvatarPath, '/tmp/x.png');
  assert.equal(sanitizeSettings({ avatarChoice: 'other' }).avatarChoice, 'placeholder');
  assert.equal(sanitizeSettings({ customAvatarPath: 42 }).customAvatarPath, '');
});

test('detectMeeting: meeting window titles detect, background processes do not', () => {
  assert.deepEqual(detectMeeting({ processes: ['Zoom.exe'], windowTitles: ['Zoom Meeting'] }).detected, true);
  assert.equal(detectMeeting({ processes: ['Zoom.exe'], windowTitles: ['Zoom Meeting'] }).app, 'Zoom');
  assert.equal(detectMeeting({ processes: ['ms-teams.exe'], windowTitles: ['Teams Meeting - Q1 Review'] }).app, 'Teams');
  assert.equal(detectMeeting({ processes: ['chrome.exe'], windowTitles: ['Sprint planning - Google Meet'] }).app, 'Google Meet');
  assert.equal(detectMeeting({ processes: ['chrome.exe'], windowTitles: ['Meet - abc-def-ghi'] }).app, 'Google Meet');
  // Background app alone must NOT suppress: Teams/Zoom run all day.
  const bg = detectMeeting({ processes: ['Teams.exe', 'Zoom.exe'], windowTitles: ['Microsoft Teams', 'Zoom'] });
  assert.equal(bg.detected, false);
  assert.equal(bg.candidateApp, 'Teams');
  // A meeting name alone, with no app word, is a known miss (not a false positive).
  assert.equal(detectMeeting({ processes: [], windowTitles: ['Q1 Review'] }).detected, false);
  assert.equal(detectMeeting({ processes: [], windowTitles: [] }).detected, false);
  assert.equal(detectMeeting(null).detected, false);
});

test('meetingAppFromProcess: normalises exe/app suffixes and case', () => {
  assert.equal(meetingAppFromProcess('Zoom.exe'), 'Zoom');
  assert.equal(meetingAppFromProcess('MS-TEAMS.EXE'), 'Teams');
  assert.equal(meetingAppFromProcess('chrome.exe'), null);
  assert.equal(meetingAppFromProcess(null), null);
});

test('isAutoMeetingSuppressed: needs both the setting and a detection', () => {
  assert.equal(isAutoMeetingSuppressed({ autoMeetingDetect: true }, true), true);
  assert.equal(isAutoMeetingSuppressed({ autoMeetingDetect: true }, false), false);
  assert.equal(isAutoMeetingSuppressed({ autoMeetingDetect: false }, true), false);
  assert.equal(isAutoMeetingSuppressed({}, true), true); // default on
});
