// Police radio: the parts that can be measured from here.
//
// The voice is the browser's speech engine, which plays outside Web Audio and
// cannot be recorded or rendered offline -- so it is checked by what it is
// given and whether it runs, not by listening. Everything around it can still
// be measured properly:
//
//   1. the channel is band-limited: raise it in an OfflineAudioContext, push
//      white noise through it, and look at where the energy ends up;
//   2. the key-up crash is louder than the click that opens a call;
//   3. every line the game says is rewritten into something readable aloud;
//   4. voices are picked sensibly from the machine's list, and from a few
//      lists this machine does not have;
//   5. live: calls go out one at a time, one that would wait too long is
//      dropped, an urgent call cuts routine commentary off, and muting stops it.
window.__runRadio = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const mod = await import('/src/game/audio.js');
    const { GameAudio, speakable, pickVoices } = mod;
    const rows = [];

    // ---------------------------------------------------- 1 & 2: the channel
    const SR = 44100;
    const raise = async (fill, seconds) => {
      const off = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
      const a = Object.create(GameAudio.prototype);
      a.ctx = off; a.ready = true; a.muted = false; a.failed = false;
      const buf = off.createBuffer(1, SR * 2, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      a.noiseBuffer = buf;
      a.master = off.createGain();
      a.master.connect(off.destination);
      // _buildRadio also looks for recordings and a speech engine; neither
      // matters to an offline render.
      a._loadChatter = () => {};
      a._buildRadio();
      fill(a, off);
      return (await off.startRendering()).getChannelData(0);
    };

    const noise = await raise((a, off) => {
      const src = off.createBufferSource();
      src.buffer = a.noiseBuffer; src.loop = true;
      const g = off.createGain(); g.gain.value = 0.02;
      src.connect(g); g.connect(a.radioIn);
      src.start(0);
    }, 1.0);

    // Band energy via a simple DFT on a 4096-sample window.
    const N = 4096;
    let lo = 0, mid = 0, hi = 0;
    for (let w = 0; w + N <= noise.length; w += N) {
      for (let k = 1; k < N / 2; k++) {
        let re = 0, im = 0;
        const f = (k * SR) / N;
        if (k % 4 !== 0) continue;            // every 4th bin is plenty
        for (let n = 0; n < N; n++) {
          const ang = (2 * Math.PI * k * n) / N;
          re += noise[w + n] * Math.cos(ang);
          im -= noise[w + n] * Math.sin(ang);
        }
        const e = re * re + im * im;
        if (f < 300) lo += e; else if (f <= 3000) mid += e; else hi += e;
      }
      break;                                   // one window is enough
    }
    const total = lo + mid + hi || 1;
    rows.push(['energy below 300 Hz', `${(100 * lo / total).toFixed(1)}%`]);
    rows.push(['energy 300 Hz - 3 kHz', `${(100 * mid / total).toFixed(1)}%`]);
    rows.push(['energy above 3 kHz', `${(100 * hi / total).toFixed(1)}%`]);

    const clicks = await raise((a) => {
      a._squelch(0.10, 0.05, 0.55, 2400);     // the key closing
      a._squelch(0.60, 0.12, 1.7, 3200);      // the key coming up
    }, 1.0);
    const peak = (from, to) => {
      let p = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) p = Math.max(p, Math.abs(clicks[i]));
      return p;
    };
    const open = peak(0.08, 0.30), crash = peak(0.58, 0.90);
    rows.push(['key-up crash vs opening click', `${(crash / Math.max(open, 1e-6)).toFixed(2)}x`]);

    // The signalling around a call: each rendered on its own, measured against
    // the key-up crash. They should all be clearly there and none of them
    // should be the loudest thing in a transmission.
    const alone = async (fn) => {
      const pcm = await raise((a) => fn(a), 0.8);
      let p = 0, e = 0, n = 0;
      for (let i = 0; i < pcm.length; i++) { p = Math.max(p, Math.abs(pcm[i])); e += pcm[i] * pcm[i]; if (Math.abs(pcm[i]) > 0.002) n++; }
      return { peak: p, audible: n / SR };
    };
    for (const [label, fn] of [
      ['data burst (Control)', (a) => a._dataBurst(0.1, 0.16)],
      ['talk permit chirps (unit)', (a) => a._talkPermit(0.1)],
      ['roger beep (unit)', (a) => a._rogerBeep(0.1)],
      ['attention beep (Control)', (a) => a._alertTone(0.1)],
      ['static crackle', (a) => a._crackle(0.1, 0.5, 3)],
    ]) {
      const r = await alone(fn);
      rows.push([label, `peak ${(r.peak / Math.max(crash, 1e-6)).toFixed(2)}x the crash, ${(r.audible * 1000).toFixed(0)} ms audible`]);
    }

    // --------------------------------------------- 3: readable aloud
    rows.push(['', '']);
    for (const line of [
      'Control — reports of a vehicle driving dangerously. All units respond.',
      'U4 — PIT authorised',
      'U2, I\'ll cut them off at Fifteenth Street / Meridian Avenue.',
      'Air support is up — India 99 overhead',
      'U12 — cut them off at the roundabout, 3s',
    ]) {
      rows.push(['  says', speakable(line)]);
    }

    // --------------------------------------------- 4: voice choice
    rows.push(['', '']);
    const name = (v) => (v ? v.name : '-');
    const show = (label, list) => {
      const p = pickVoices(list);
      rows.push([label, p ? `control ${name(p.control)} / unit ${name(p.unit)} / air ${name(p.air)}` : 'none -> recorded fallback']);
    };
    if (window.speechSynthesis) {
      await new Promise((r) => {
        if (speechSynthesis.getVoices().length) r();
        else { speechSynthesis.addEventListener('voiceschanged', r, { once: true }); setTimeout(r, 2000); }
      });
      show('this machine', speechSynthesis.getVoices());
    }
    show('US only', [
      { name: 'Microsoft David - English (United States)', lang: 'en-US', localService: true },
      { name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true },
    ]);
    show('Google voices', [
      { name: 'Google UK English Female', lang: 'en-GB', localService: false },
      { name: 'Google UK English Male', lang: 'en-GB', localService: false },
      { name: 'Google US English', lang: 'en-US', localService: false },
    ]);
    show('one voice', [{ name: 'Some Voice', lang: 'en-AU', localService: true }]);
    show('no English', [{ name: 'Microsoft Hedda', lang: 'de-DE', localService: true }]);

    // --------------------------------------------- 5: live
    rows.push(['', '']);
    const g = window.__game, a = g.audio;
    if (!a || !a.ready || !a.speech) {
      rows.push(['live channel test', 'skipped: audio not started (click the page first)']);
    } else {
      for (let i = 0; i < 60 && (speechSynthesis.speaking || a.radioFreeAt === Infinity); i++) {
        a._pumpRadio();
        await new Promise((r) => setTimeout(r, 250));
      }
      a.radioQueue.length = 0;
      // The game loop does not tick in a background tab, so pump by hand.
      // Straight to the audio side, not through Game.radio, whose clock does
      // not run here either and would drop a repeat of the same sentence.
      const pump = setInterval(() => a._pumpRadio(), 50);
      const spoken = [];
      let overlap = 0;
      const real = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (u) => {
        const rec = { text: u.text, at: performance.now(), end: null, how: null };
        spoken.push(rec);
        const done = (how) => () => { if (!rec.end) { rec.end = performance.now(); rec.how = how; } };
        u.addEventListener('end', done('end'));
        u.addEventListener('error', done('cut'));
        u.volume = 0.02;
        real(u);
      };
      const idle = async () => {
        for (let i = 0; i < 80 && (a.busy || speechSynthesis.speaking); i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      const sec = (ms) => (ms / 1000).toFixed(1);

      // Three priority calls at once. The second waits for the first; the third
      // would have to wait for both, which is longer than any call may wait.
      a.radio('Control, all units, radio check.', true);
      a.radio('U1, received.', true);
      a.radio('U2, received.', true);
      for (let i = 0; i < 100; i++) {
        if (speechSynthesis.speaking && speechSynthesis.pending) overlap++;
        await new Promise((r) => setTimeout(r, 100));
        if (!a.busy && !speechSynthesis.speaking && spoken.length) break;
      }
      rows.push(['three calls at once', `${spoken.length} spoken: ${spoken.map((s) => `"${s.text}"`).join(', ')}`]);
      if (spoken[1]) rows.push(['  second call went out', `${sec(spoken[1].at - spoken[0].at)} s after the first`]);
      rows.push(['ticks with two calls live at once', String(overlap)]);

      // A routine line, then something urgent while it is still being read.
      await idle();
      await new Promise((r) => setTimeout(r, 2200));   // routine needs a gap
      spoken.length = 0;
      a.radio('U3, still with them, northbound on Sixth Street, speeds forty, no change.', false, { low: true });
      for (let i = 0; i < 40 && !(spoken[0] && speechSynthesis.speaking); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 700));
      const urgentAt = performance.now();
      a.radio('Control, all units, they have rammed a unit.', true);
      await idle();
      const routine = spoken[0], urgent = spoken[1];
      rows.push(['routine line on the air', routine ? `ended by ${routine.how}, ${sec(routine.end - routine.at)} s in` : 'never started']);
      rows.push(['urgent call went out', urgent ? `${sec(urgent.at - urgentAt)} s after it was made` : 'never']);

      a.toggleMute();
      await new Promise((r) => setTimeout(r, 300));
      rows.push(['still speaking after mute', String(speechSynthesis.speaking)]);
      a.toggleMute();
      clearInterval(pump);
      speechSynthesis.speak = real;
    }

    window.__res = rows.map((r) => `${r[0].padEnd(32)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
