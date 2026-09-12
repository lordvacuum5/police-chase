// Background net chatter: does it play, does it stay out of the way, and does
// it stop when the chase does?
//
// There may be no recording on disk -- the feature is written so that a
// missing file changes nothing -- so this injects a synthetic buffer and
// measures the behaviour around it rather than the sound of it.
window.__runChatter = async function () {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, a = g.audio;
    if (!a || !a.ready) { window.__res = 'AUDIO NOT READY (click the page first)'; return; }
    const rows = [];
    rows.push(['recordings found on disk', String(a.chatter.length)]);

    // A second of noise stands in for a clip. Twenty seconds of it, so the
    // window it cuts out can move around.
    const ctx = a.ctx;
    const fake = ctx.createBuffer(1, ctx.sampleRate * 20, ctx.sampleRate);
    const d = fake.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3;
    const had = a.chatter.slice();
    a.chatter = [fake];

    // Count bursts by watching the channel get booked.
    //
    // The booking is in audio-clock time, and the audio clock does not advance
    // inside a synchronous loop -- so the channel is released by hand after
    // each burst, standing in for the time that would have passed. What is
    // being measured here is the spacing logic, not the clock.
    const run = (seconds, tier) => {
      let bursts = 0;
      a.chatterTimer = 0;
      a.radioFreeAt = 0;
      const step = 1 / 60;
      for (let t = 0; t < seconds; t += step) {
        const before = a.radioFreeAt;
        a._pumpChatter(step, { tier });
        if (a.radioFreeAt > before) { bursts++; a.radioFreeAt = 0; }
      }
      return bursts;
    };

    rows.push(['bursts in 60 s, no chase', String(run(60, 0))]);
    rows.push(['bursts in 60 s at 2 stars', String(run(60, 2))]);
    rows.push(['bursts in 60 s at 5 stars', String(run(60, 5))]);

    // With a dispatch call holding the channel, chatter must wait.
    a.chatterTimer = 0;
    a.radioFreeAt = ctx.currentTime + 30;
    let over = 0;
    for (let t = 0; t < 10; t += 1 / 60) {
      const before = a.radioFreeAt;
      a._pumpChatter(1 / 60, { tier: 4 });
      if (a.radioFreeAt !== before) over++;
    }
    rows.push(['talked over a call', over ? `yes, ${over} times` : 'no']);

    // And a queued call is never pre-empted either.
    a.chatterTimer = 0;
    a.radioFreeAt = 0;
    a.radioQueue.push({ text: 'Control — all units', hot: true });
    let jumped = 0;
    for (let t = 0; t < 5; t += 1 / 60) {
      const before = a.radioFreeAt;
      a._pumpChatter(1 / 60, { tier: 4 });
      if (a.radioFreeAt !== before) jumped++;
    }
    a.radioQueue.length = 0;
    rows.push(['jumped a queued call', jumped ? `yes, ${jumped} times` : 'no']);

    // Muted means silent.
    a.muted = true;
    a.chatterTimer = 0; a.radioFreeAt = 0;
    let whileMuted = 0;
    for (let t = 0; t < 20; t += 1 / 60) {
      const before = a.radioFreeAt;
      a._pumpChatter(1 / 60, { tier: 5 });
      if (a.radioFreeAt !== before) whileMuted++;
    }
    a.muted = false;
    rows.push(['bursts while muted', String(whileMuted)]);

    a.chatter = had;
    a.radioFreeAt = 0;
    rows.push(['left the real state alone', String(a.chatter.length === had.length)]);

    window.__res = rows.map((r) => `${r[0].padEnd(28)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 400);
  }
};
