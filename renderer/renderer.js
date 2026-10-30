// Personal Photo Companion — renderer logic.
// Avatar resolution order: generated full-body 3D cartoon character
// (character-fullbody.png) first, then avatar.png/jpg/jpeg, then the
// bundled placeholder avatar.svg. The character is shown full-body,
// top to bottom, not cropped to a circle.

(function () {
  const avatarEl = document.getElementById('avatar');
  const statusEl = document.getElementById('status');
  const bubbleEl = document.getElementById('bubble');
  const bubbleTitleEl = document.getElementById('bubble-title');
  const bubbleTextEl = document.getElementById('bubble-text');
  const settingsEl = document.getElementById('settings');
  const quietBtn = document.getElementById('btn-quiet');
  const dndBtn = document.getElementById('btn-dnd');

  let currentReminderType = null;
  let bubbleTimer = null;
  let settings = null;
  let lastAvatarKey = null;

  const AVATAR_CANDIDATES = [
    '../assets/character-fullbody-cutout.png',
    '../assets/character-fullbody.png',
    '../assets/avatar.png',
    '../assets/avatar.jpg',
    '../assets/avatar.jpeg',
    '../assets/avatar.svg',
  ];
  // Last-resort avatar: a simple drawn face as a data URI, so the companion
  // never shows a broken image even if every avatar file is missing/corrupt.
  const AVATAR_FALLBACK =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
        '<circle cx="48" cy="48" r="46" fill="#dff3ff"/>' +
        '<circle cx="34" cy="40" r="5" fill="#222"/>' +
        '<circle cx="62" cy="40" r="5" fill="#222"/>' +
        '<path d="M32 60 Q48 74 64 60" stroke="#222" stroke-width="4" fill="none" stroke-linecap="round"/>' +
        '</svg>',
    );

  // Bubble auto-hide delay: 90 seconds normally, shorter under the e2e
  // harness (preload exposes the override, null in normal runs).
  const AUTOHIDE_MS =
    window.companion.autohideMs && window.companion.autohideMs > 0
      ? window.companion.autohideMs
      : 90 * 1000;

  function loadAvatar(index) {
    if (index >= AVATAR_CANDIDATES.length) {
      avatarEl.src = AVATAR_FALLBACK;
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      avatarEl.src = AVATAR_CANDIDATES[index];
    };
    probe.onerror = () => loadAvatar(index + 1);
    probe.src = AVATAR_CANDIDATES[index];
  }
  // Avatar refresh: a custom uploaded photo (via the main process, as a
  // data URL) wins when selected; otherwise the built-in placeholder
  // candidates. Only reloads when the avatar choice actually changed.
  function refreshAvatar() {
    const key = settings
      ? `${settings.avatarChoice || 'placeholder'}|${settings.customAvatarPath || ''}`
      : 'placeholder|';
    if (key === lastAvatarKey) return;
    lastAvatarKey = key;
    if (settings && settings.avatarChoice === 'custom') {
      window.companion
        .getCustomAvatar()
        .then((url) => {
          if (url) avatarEl.src = url;
          else loadAvatar(0);
        })
        .catch(() => loadAvatar(0));
      return;
    }
    loadAvatar(0);
  }
  loadAvatar(0);
  lastAvatarKey = 'placeholder|';

  // Animation states: only one anim-* class at a time. One-shot states
  // (walk-in, success, sad) fall back to idle when they finish; attention
  // runs while a reminder bubble is showing.
  function setAvatarAnim(name) {
    avatarEl.classList.remove(
      'anim-idle',
      'anim-walk-in',
      'anim-attention',
      'anim-success',
      'anim-sad',
      'anim-celebrate',
      'anim-sleepy',
    );
    avatarEl.classList.add(name);
  }
  avatarEl.addEventListener('animationend', (event) => {
    if (event.animationName === 'avatarWalkIn' ||
        event.animationName === 'avatarSuccess' ||
        event.animationName === 'avatarSad') {
      setAvatarAnim('anim-idle');
    }
    // Unique exits settle back to centre idle when they finish.
    if (event.animationName === 'avatarCelebrate' ||
        event.animationName === 'avatarSleepy') {
      setAvatarAnim('anim-idle');
    }
  });
  // On load the companion walks in, then settles into idle bobbing.
  setAvatarAnim('anim-walk-in');

  function showBubble(reminder) {
    currentReminderType = reminder.type;
    bubbleTitleEl.textContent = reminder.title;
    bubbleTextEl.textContent = reminder.text;
    // Exercise reminders show the 3D cartoon doing that exercise:
    // a photo for exercises 0-4, a looping squat video for squats
    // (index 4), and the animated SVG figure as fallback for 5-9
    // until their photos are generated. Water shows none of these.
    const figureEl = document.getElementById('bubble-figure');
    const photoEl = document.getElementById('bubble-photo');
    const videoEl = document.getElementById('bubble-video');
    const EXERCISE_PHOTOS = [
      'ex0-arms-overhead-cutout.png', 'ex1-shoulder-rolls-cutout.png',
      'ex2-neck-turns-cutout.png', 'ex3-walk-around-cutout.png',
      'ex4-chair-squats-cutout.png',
    ];
    // Overlay mode: the bubble photo IS the person — hide the main
    // avatar so there is only one person on screen, never two.
    const avatarEl = document.getElementById('avatar');
    if (avatarEl) avatarEl.classList.add('hidden');
    if (photoEl) photoEl.classList.add('hidden');
    if (videoEl) { videoEl.classList.add('hidden'); videoEl.pause(); videoEl.removeAttribute('src'); }
    const canvasEl = document.getElementById('bubble-canvas');
    if (canvasEl) canvasEl.classList.add('hidden');
    if (window.__pccVideoLoop) { cancelAnimationFrame(window.__pccVideoLoop); window.__pccVideoLoop = 0; }
    if (figureEl) figureEl.classList.add('hidden');
    if (reminder.type === 'water' && photoEl) {
      // Water: the character holding a water bottle up in his hand,
      // cut out, floating over the desktop — no box, just the person
      // + bottle + text + buttons. (Previously it was the plain
      // sitting character with no bottle at all.)
      photoEl.src = '../assets/water-bottle-cutout.png';
      photoEl.className = '';
    }
    if (reminder.type === 'exercise' &&
        Number.isInteger(reminder.exerciseIndex)) {
      const idx = reminder.exerciseIndex;
      // REA pattern, original clips only: pre-rendered video clips,
      // played through a canvas chromakey so only the person shows.
      const EXERCISE_VIDEOS = [
        'ex0-arms-overhead.mp4', 'ex1-shoulder-rolls.mp4',
        'ex2-neck-turns.mp4', 'ex3-walk-around.mp4',
        'ex4-chair-squats-green.mp4', 'ex5-wrist-stretch-v2.mp4',
        'ex6-calf-raises.mp4', 'ex7-shake-hands-v2.mp4',
        'ex8-spinal-twist.mp4', 'ex9-march-in-place.mp4',
      ];
      const KEY_COLORS = [
        [214, 211, 210], [214, 211, 210], [214, 211, 210],
        [214, 211, 210], [41, 171, 34],
        [214, 211, 210], [214, 211, 210], [214, 211, 210],
        [214, 211, 210], [214, 211, 210],
      ];
      if (EXERCISE_VIDEOS[idx] && videoEl && canvasEl) {
        const ctx = canvasEl.getContext('2d');
        videoEl.src = `../assets/exercises/${EXERCISE_VIDEOS[idx]}`;
        videoEl.muted = true; videoEl.loop = true;
        canvasEl.classList.remove('hidden');
        const draw = () => {
          if (videoEl.paused || videoEl.ended) return;
          ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
          const frame = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
          const d = frame.data; const kc = KEY_COLORS[idx];
          for (let i = 0; i < d.length; i += 4) {
            const dr = d[i] - kc[0], dg = d[i + 1] - kc[1], db = d[i + 2] - kc[2];
            if (Math.sqrt(dr * dr + dg * dg + db * db) < 42) d[i + 3] = 0;
          }
          ctx.putImageData(frame, 0, 0);
          window.__pccVideoLoop = requestAnimationFrame(draw);
        };
        videoEl.onloadeddata = () => { videoEl.play().then(draw).catch(() => {}); };
        videoEl.load();
      } else if (EXERCISE_PHOTOS[idx] && photoEl) {
        photoEl.src = `../assets/exercises/${EXERCISE_PHOTOS[idx]}`;
        photoEl.className = '';
        photoEl.classList.add(`pose-${idx}`);
      } else if (figureEl) {
        figureEl.className = '';
        figureEl.classList.add(`pose-${idx}`);
      }
    }
    bubbleEl.classList.remove('hidden');
    // Arrive, then settle to a gentle idle — NO left-right shaking
    // while the bubble shows (that shaking on a passport photo is
    // exactly what the user reported as not good).
    setAvatarAnim('anim-walk-in');
    setTimeout(() => {
      if (!bubbleEl.classList.contains('hidden')) setAvatarAnim('anim-idle');
    }, 1300);
    statusEl.textContent =
      reminder.type === 'water' ? 'Water break' : 'Movement break';
    if (bubbleTimer) clearTimeout(bubbleTimer);
    // Auto-hide so a missed reminder never lingers forever; the main
    // process is told so it can show the next queued reminder, if any.
    bubbleTimer = setTimeout(() => {
      hideBubble();
      window.companion.bubbleDismissed();
    }, AUTOHIDE_MS);
  }

  function statusText(data) {
    if (!data) return 'Here with you';
    if (data.doNotDisturb) return 'Do Not Disturb';
    if (data.meetingDetected) {
      return data.meetingApp ? `In a meeting (${data.meetingApp}, auto)` : 'In a meeting (auto)';
    }
    if (data.quietMode) return 'Quiet mode';
    return 'Here with you';
  }

  function hideBubble(keepAnim) {
    bubbleEl.classList.add('hidden');
    const figureEl = document.getElementById('bubble-figure');
    if (figureEl) figureEl.classList.add('hidden');
    const photoEl = document.getElementById('bubble-photo');
    if (photoEl) photoEl.classList.add('hidden');
    const videoEl = document.getElementById('bubble-video');
    if (videoEl) { videoEl.classList.add('hidden'); videoEl.pause(); }
    if (window.__pccVideoLoop) { cancelAnimationFrame(window.__pccVideoLoop); window.__pccVideoLoop = 0; }
    const canvasEl = document.getElementById('bubble-canvas');
    if (canvasEl) canvasEl.classList.add('hidden');
    // Done/Snooze pass keepAnim so their jump/droop can finish;
    // animationend then settles back to idle. All other hides go idle.
    if (!keepAnim) setAvatarAnim('anim-idle');
    statusEl.textContent = statusText(settings);
    currentReminderType = null;
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
  }

  function fillSettingsForm(data) {
    document.getElementById('in-water').value = data.waterIntervalMin;
    document.getElementById('in-exercise').value = data.exerciseIntervalMin;
    document.getElementById('in-start').value = data.workStartHour;
    document.getElementById('in-end').value = data.workEndHour;
    document.getElementById('in-quiet').checked = data.quietMode;
    document.getElementById('in-dnd').checked = !!data.doNotDisturb;
    document.getElementById('in-auto-meeting').checked = data.autoMeetingDetect !== false;
    document.getElementById('in-avatar').value =
      data.avatarChoice === 'custom' ? 'custom' : 'placeholder';
    quietBtn.textContent = data.quietMode ? '🔔' : '🔕';
    quietBtn.title = data.quietMode ? 'Turn quiet mode off' : 'Turn quiet mode on';
    dndBtn.classList.toggle('active', !!data.doNotDisturb);
    dndBtn.title = data.doNotDisturb
      ? 'Do Not Disturb is on — turn off to resume reminders'
      : 'Do Not Disturb: meeting / screen share';
    statusEl.textContent = statusText(data);
  }

  window.companion.onReminder((reminder) => showBubble(reminder));

  window.companion.onSettingsUpdated((data) => {
    settings = data;
    fillSettingsForm(data);
    refreshAvatar();
    // Turning on quiet mode or Do Not Disturb dismisses a bubble that is
    // already showing — suppression must not leave a reminder on screen
    // during a meeting or screen share. The main process is told so its
    // bubble state stays in sync (its queue was already cleared).
    if (data.quietMode || data.doNotDisturb) {
      hideBubble();
      window.companion.bubbleDismissed();
    }
  });

  window.companion.getSettings().then((data) => {
    settings = data;
    fillSettingsForm(data);
    refreshAvatar();
  });

  // Photo dropdown: picking "Upload your photo…" opens the system file
  // picker in the main process. Cancelling reverts the dropdown to the
  // previous choice; a successful pick is broadcast back as settings.
  document.getElementById('in-avatar').addEventListener('change', (event) => {
    const value = event.target.value;
    if (value !== 'custom') return;
    window.companion.pickAvatarPhoto().then((result) => {
      if (!result || result.cancelled) {
        event.target.value = settings && settings.avatarChoice === 'custom' ? 'custom' : 'placeholder';
        if (result && result.error) alert(result.error);
      }
    });
  });

  document.getElementById('btn-done').addEventListener('click', () => {
    // Unique Done reaction: celebration spin-jump in place, not a
    // walk to a side. Bubble hides immediately but the spin finishes
    // first (keepAnim), then animationend settles back to idle.
    setAvatarAnim('anim-celebrate');
    hideBubble(true);
    window.companion.bubbleDismissed();
  });

  document.getElementById('btn-snooze').addEventListener('click', () => {
    // Snooze reaction: for exercise, the character goes SAD first —
    // droops, dims and greys out for 1.6s so you actually see it —
    // then the snooze is sent and the screen clears. Water keeps the
    // sleepy sway. Previously the window hid instantly, so the
    // reaction was never visible.
    if (currentReminderType === 'exercise') {
      // Keep the bubble on screen for the sad beat — hiding it first
      // would hide the canvas too, so the reaction was invisible.
      setAvatarAnim('anim-sad');
      bubbleEl.classList.add('anim-sad');
      const canvasEl = document.getElementById('bubble-canvas');
      if (canvasEl) canvasEl.classList.add('anim-sad');
      setTimeout(() => {
        bubbleEl.classList.remove('anim-sad');
        if (canvasEl) canvasEl.classList.remove('anim-sad');
        hideBubble(true);
        window.companion.snooze('exercise');
      }, 1600);
    } else {
      if (currentReminderType) window.companion.snooze(currentReminderType);
      setAvatarAnim('anim-sleepy');
      hideBubble(true);
    }
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    settingsEl.classList.toggle('hidden');
    // Grow the window when settings open so Save + photo option are
    // visible; shrink it back when settings close.
    // Reminder-only rule: closing settings with no bubble showing
    // hides the whole window (tray only) — no "Here with you" pill
    // or toolbar left on the desktop by default.
    if (settingsEl.classList.contains('hidden')) {
      window.companion.resizeWindow(330);
      if (bubbleEl.classList.contains('hidden')) window.companion.hideWindow();
    } else {
      window.companion.resizeWindow(850);
    }
  });

  document.getElementById('btn-hide').addEventListener('click', () => {
    window.companion.hideWindow();
  });

  quietBtn.addEventListener('click', () => {
    if (!settings) return;
    window.companion.saveSettings({ ...settings, quietMode: !settings.quietMode });
  });

  dndBtn.addEventListener('click', () => {
    if (!settings) return;
    window.companion.saveSettings({ ...settings, doNotDisturb: !settings.doNotDisturb });
  });

  document.getElementById('btn-preview-water').addEventListener('click', () => {
    window.companion.previewReminder('water');
  });

  document.getElementById('btn-preview-exercise').addEventListener('click', () => {
    window.companion.previewReminder('exercise');
  });

  settingsEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = {
      waterIntervalMin: document.getElementById('in-water').value,
      exerciseIntervalMin: document.getElementById('in-exercise').value,
      workStartHour: document.getElementById('in-start').value,
      workEndHour: document.getElementById('in-end').value,
      quietMode: document.getElementById('in-quiet').checked,
      doNotDisturb: document.getElementById('in-dnd').checked,
      autoMeetingDetect: document.getElementById('in-auto-meeting').checked,
      // Only carry the dropdown choice forward when it is 'placeholder':
      // a 'custom' choice is set by the file picker itself (with its
      // stored path), not by saving the form, so a form save must not
      // clear an already-uploaded photo's path.
      ...(document.getElementById('in-avatar').value === 'placeholder'
        ? { avatarChoice: 'placeholder', customAvatarPath: '' }
        : {}),
    };
    window.companion.saveSettings(next).then((data) => {
      settings = data;
      fillSettingsForm(data);
      settingsEl.classList.add('hidden');
      window.companion.resizeWindow(330);
      // Reminder-only rule (user report 2026-10-29): after Save, with
      // no reminder showing, the window must hide completely — no
      // status pill or toolbar left on the default screen.
      if (bubbleEl.classList.contains('hidden')) window.companion.hideWindow();
    });
  });
})();
