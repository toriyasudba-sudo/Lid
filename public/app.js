(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  const key = 'toriya_mini_session_id';
  const sessionId = localStorage.getItem(key) || crypto.randomUUID();
  localStorage.setItem(key, sessionId);
  let currentScreen = location.hash || '#s0';
  let lastSent = '';

  function initData() { return tg?.initData || ''; }
  async function event(name, meta = {}) {
    const payload = { event: name, session_id: sessionId, screen: currentScreen, meta };
    try {
      await fetch('/api/event', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ ...payload, init_data: initData() })
      });
    } catch (_) {}
  }

  function screenFromHash() { return location.hash || '#s0'; }
  function trackScreen() {
    currentScreen = screenFromHash();
    const id = currentScreen.slice(1);
    if (id !== lastSent) {
      lastSent = id;
      event('SCREEN_VIEW', { screen: id });
      if (id === 's0') event('START');
      if (['s3material','s3break','s3product','s3return'].includes(id)) event('RESULT_SHOWN', { result: id });
      if (id === 's4') event('LIVE_USER_VIEWED');
      if (id === 's5') event('ANALYTICS_VIEWED');
      if (id === 's6') event('RETURN_LOGIC_VIEWED');
      if (id === 's7') event('OBJECTION_VIEWED');
      if (id === 's8') event('ARCHITECTURE_VIEWED');
      if (id === 's9') event('GIFT_OPENED');
      if (id === 's10') event('FINAL_VIEWED');
    }
  }

  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const text = (a.innerText || '').trim().slice(0,180);
    if (href.startsWith('#')) event('CLICK', { target: href.slice(1), text });
    if (href.includes('15')) event('CTA_15000_CLICK');
    if (href.includes('30')) event('CTA_30000_CLICK');
  }, {passive:true});

  window.addEventListener('hashchange', trackScreen);
  trackScreen();

  document.querySelectorAll('video').forEach(v => {
    let sent = false;
    v.addEventListener('play', () => { if (!sent) { sent = true; event('VIDEO_PLAY', {src: v.currentSrc || v.src}); } });
  });

  // Ask Telegram for permission to send messages when available.
  if (tg?.requestWriteAccess) {
    setTimeout(() => tg.requestWriteAccess(() => {}), 900);
  }
})();
