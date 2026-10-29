// End-to-end smoke test: launches the real Electron app under Xvfb and
// drives it through its real preload bridge and renderer DOM.
// Run: npm run test:e2e   (or: node --test tests/e2e-smoke.test.js)
// Requires: the electron binary in node_modules and Xvfb (xvfb-run).
// Skips cleanly (not a failure) when either is unavailable.
// Runtime is ~50 s: the app self-quits after PCC_E2E_EXIT_MS.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(ROOT, 'node_modules', '.bin', 'electron');

const hasElectron = fs.existsSync(ELECTRON_BIN);
const hasXvfbRun = spawnSync('which', ['xvfb-run']).status === 0;
const hasXvfb = spawnSync('which', ['Xvfb']).status === 0;
const CAN_RUN = hasElectron && (hasXvfbRun || hasXvfb);

if (!CAN_RUN) {
  const reason = !hasElectron
    ? 'electron binary not found (run npm install first)'
    : 'no Xvfb available for a headless display';
  test(`e2e smoke (skipped: ${reason})`, { skip: true }, () => {});
} else {
  let tmpDir = null;
  let userDataDir = null;
  let shotPath = null;
  let first = null;
  let firstOut = '';
  let firstErr = '';
  let firstCode = null;
  let secondCode = null;
  let secondMs = null;
  let firstAliveAtSecondExit = null;
  let manualXvfb = null;

  function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve('timeout');
      }, timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  function waitForXvfbSocket(display, timeoutMs = 10000) {
    const started = Date.now();
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (fs.existsSync(`/tmp/.X11-unix/X${display}`)) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(iv);
          resolve(false);
        }
      }, 100);
    });
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-e2e-'));
    userDataDir = path.join(tmpDir, 'user-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    shotPath = path.join(tmpDir, 'shot.png');
    // Pre-seeded settings: the app must load these verbatim (see assertion).
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify(
        {
          waterIntervalMin: 45,
          exerciseIntervalMin: 60,
          workStartHour: 9,
          workEndHour: 18,
          quietMode: false,
          doNotDisturb: false,
          lastExerciseIndex: 2,
        },
        null,
        2,
      ),
      'utf8',
    );

    const appEnv = {
      ...process.env,
      PCC_E2E: '1',
      PCC_E2E_WATER_MS: '8000',
      PCC_E2E_EXERCISE_MS: '8500',
      PCC_E2E_AUTOHIDE_MS: '4000',
      PCC_E2E_EXIT_MS: '45000',
      PCC_E2E_SCREENSHOT: shotPath,
      ELECTRON_DISABLE_SANDBOX: '1',
    };
    const appArgs = ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`];

    let cmd;
    let args;
    let env = appEnv;
    if (hasXvfbRun) {
      cmd = 'xvfb-run';
      args = ['-a', ELECTRON_BIN, ...appArgs];
    } else {
      // Fallback: start our own X server on :99.
      manualXvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x1024x24'], {
        stdio: 'ignore',
      });
      await waitForXvfbSocket(99);
      env = { ...appEnv, DISPLAY: ':99' };
      cmd = ELECTRON_BIN;
      args = appArgs;
    }

    first = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    first.stdout.on('data', (d) => {
      firstOut += d.toString();
    });
    first.stderr.on('data', (d) => {
      firstErr += d.toString();
    });

    // Second-instance check at ~20 s: same user-data dir, so the lock must
    // make it quit promptly while the first instance keeps running.
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const secondStarted = Date.now();
    const second = spawn(
      hasXvfbRun ? 'xvfb-run' : ELECTRON_BIN,
      hasXvfbRun
        ? ['-a', ELECTRON_BIN, '.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`]
        : ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDataDir}`],
      {
        cwd: ROOT,
        // The second instance must not inherit the e2e harness env: it must
        // quit on the lock alone, without self-test timers.
        env: hasXvfbRun
          ? process.env
          : Object.fromEntries(
              Object.entries(env).filter(([k]) => !k.startsWith('PCC_E2E')),
            ),
        stdio: 'ignore',
      },
    );
    secondCode = await waitForExit(second, 20000);
    secondMs = Date.now() - secondStarted;
    firstAliveAtSecondExit = first.exitCode === null;

    firstCode = await waitForExit(first, 100000);
  });

  after(() => {
    try {
      if (first && first.exitCode === null) first.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      if (manualXvfb && manualXvfb.exitCode === null) manualXvfb.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('app launches, reports ready, and exits cleanly on its own', () => {
    assert.match(firstOut, /Personal Photo Companion ready/);
    assert.equal(firstCode, 0);
    assert.doesNotMatch(firstOut + firstErr, /FATAL/);
  });

  test('settings load from the pre-seeded file (load path)', () => {
    assert.match(firstOut, /e2e: settings-loaded/);
    assert.match(firstOut, /"waterIntervalMin":45/);
    assert.match(firstOut, /"exerciseIntervalMin":60/);
  });

  test('settings save/get IPC round-trip through the preload bridge', () => {
    assert.match(firstOut, /e2e: check-pass settings-save-persists/);
    assert.doesNotMatch(firstOut, /check-FAIL/);
    assert.doesNotMatch(firstOut, /selftest-error/);
  });

  test('live sanity checks: window, settings panel, buttons, suppression', () => {
    for (const name of [
      'window-240x330', 'avatar-loads', 'status-here-with-you',
      'toolbar-4-buttons', 'bubble-hidden-at-launch', 'settings-visible',
      'window-grows-to-700-on-settings', 'save-button-fits-in-window',
      'photo-option-visible', 'window-shrinks-to-330-after-save',
      'water-reminder-fires', 'water-bubble-content', 'snooze-recorded',
      'exercise-bubble-content', 'done-celebration-animation',
      'done-hides-bubble', 'dnd-status', 'quiet-status',
      'status-back-to-here-with-you',
    ]) {
      assert.match(firstOut, new RegExp(`e2e: check-pass ${name}`), name);
    }
  });

  test('water and exercise reminders fire, including a preview', () => {
    assert.match(firstOut, /e2e: reminder-fired water/);
    assert.match(firstOut, /e2e: reminder-fired exercise/);
    assert.match(firstOut, /\(preview\)/);
  });

  test('back-to-back reminders queue and flush sequentially, never overlap', () => {
    assert.match(firstOut, /\(queue-flush\)/);
  });

  test('snooze and Done buttons drive the main-process handlers', () => {
    assert.match(firstOut, /e2e: snooze water/);
    assert.match(firstOut, /e2e: bubble-dismissed/);
  });

  test('tray absence under Xvfb is handled gracefully', () => {
    assert.ok(
      firstOut.includes('e2e: tray-ready') ||
        firstOut.includes('e2e: tray-unavailable-continuing'),
      'expected a tray outcome marker in output',
    );
  });

  test('first reminder renders a real window screenshot', () => {
    assert.match(firstOut, /e2e: screenshot-saved/);
    const stat = fs.statSync(shotPath);
    assert.ok(stat.size > 5000, `screenshot too small: ${stat.size} bytes`);
  });

  test('second instance quits promptly while the first keeps running', () => {
    assert.equal(secondCode, 0);
    assert.ok(secondMs !== null && secondMs < 20000, `second instance took ${secondMs} ms`);
    assert.equal(firstAliveAtSecondExit, true);
  });
}
