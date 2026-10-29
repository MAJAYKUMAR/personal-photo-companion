// Personal Photo Companion — renderer logic.
// Avatar resolution order: assets/avatar.png, then avatar.jpg/jpeg,
// then the bundled placeholder avatar.svg. Replace avatar.png with your
// own square photo (same file name) to use a personal photo.

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
    );
    avatarEl.classList.add(name);
  }
  avatarEl.addEventListener('animationend', (event) => {
    if (event.animationName === 'avatarWalkIn' ||
        event.animationName === 'avatarSuccess' ||
        event.animationName === 'avatarSad') {
      setAvatarAnim('anim-idle');
    }
  });
  // On load the companion walks in, then settles into idle bobbing.
  setAvatarAnim('anim-walk-in');

  function showBubble(reminder) {
    currentReminderType = reminder.type;
    bubbleTitleEl.textContent = reminder.title;
    bubbleTextEl.textContent = reminder.text;
    bubbleEl.classList.remove('hidden');
    // Arrive walking, then wiggle for attention while the bubble shows.
    setAvatarAnim('anim-walk-in');
    setTimeout(() => {
      if (!bubbleEl.classList.contains('hidden')) setAvatarAnim('anim-attention');
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
    // Happy jump, bubble hides immediately but the jump finishes first
    // (keepAnim), then animationend settles back to idle.
    setAvatarAnim('anim-success');
    hideBubble(true);
    window.companion.bubbleDismissed();
  });

  document.getElementById('btn-snooze').addEventListener('click', () => {
    if (currentReminderType) window.companion.snooze(currentReminderType);
    setAvatarAnim('anim-sad');
    hideBubble(true);
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    settingsEl.classList.toggle('hidden');
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
    });
  });
})();
