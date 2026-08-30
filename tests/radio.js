// Police radio, measured off the rendered signal.
//
// There is no way to listen to this from here, so it is checked the way any
// other signal would be: raise the radio chain inside an OfflineAudioContext,
// render a transmission, and look at the samples. Rendering offline rather
// than tapping an analyser also means the numbers do not depend on frame rate,
// tab focus or how a browser throttles a background timer.
//
// Four things have to be true or the sound is not what it claims to be:
//
//   1. something comes out at all, with the shape of a transmission -- a click
//      to open, a body of speech, then a louder squelch crash at the end;
//   2. it is band-limited to the radio channel: next to nothing below 300 Hz
//      or above 3 kHz;
//   3. the three voices are actually different from each other;
//   4. the channel is one at a time -- queued calls must not overlap.
window.__runRadio = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const mod = await import('/src/game/audio.js');
    const GameAudio = mod.GameAudio;
    const rows = [];

    /** A GameAudio just complete enough to raise the radio chain offline. */
    const render = async (text, hot, seconds = 6) => {
      const SR = 44100;
      const off = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
      const a = Object.create(GameAudio.prototype);
      a.ctx = off;
      a.ready = true;
      a.muted = false;
      a.failed = false;
      // The shared noise buffer the real _build makes.
      const len = SR * 2;
      const buf = off.createBuffer(1, len, SR);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      a.noiseBuffer = buf;
      a.master = off.createGain();
      a.master.connect(off.destination);
      a._buildRadio();
      a._transmit({ text, hot });
      const out = await off.startRendering();
      return { pcm: out.getChannelData(0), sr: SR, freeAt: a.radioFreeAt };
    };

    /** RMS envelope in fixed windows. */
    const envelope = (pcm, sr, winMs = 20) => {
      const w = Math.round((sr * winMs) / 1000);
      const out = [];
      for (let i = 0; i + w <= pcm.length; i += w) {
        let s = 0;
        for (let k = 0; k < w; k++) s += pcm[i + k] * pcm[i + k];
        out.push(Math.sqrt(s / w));
      }
      return out;
    };

    /** Goertzel: energy at one frequency over a window of samples. */
    const goertzel = (pcm, sr, hz, from, n) => {
      const k = (2 * Math.PI * hz) / sr;
      const coeff = 2 * Math.cos(k);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        s0 = pcm[from + i] + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
    };

    // ------------------------------------------------ 1. shape and level
    // A plain call, so the measurement is of the transmission itself and not
    // of the attention tone a priority call from Control opens with.
    const plain = await render('Control — all units, vehicle failing to stop on Kingsway', false);
    const env = envelope(plain.pcm, plain.sr);
    const peak = Math.max(...env);
    const peakAt = env.indexOf(peak) / env.length;
    const audible = env.filter((v) => v > peak * 0.06).length;
    rows.push(['peak level', peak.toFixed(4)]);
    rows.push(['audible', `${(audible * 20 / 1000).toFixed(2)} s`]);
    rows.push(['transmission length', `${plain.freeAt.toFixed(2)} s`]);

    // The squelch crash on key-up should be the loudest single moment, and it
    // should land right at the end.
    const speechEnd = Math.floor((env.length * plain.freeAt * 0.86) / (plain.pcm.length / plain.sr));
    const speech = Math.max(...env.slice(0, speechEnd));
    rows.push(['loudest moment at', `${(peakAt * 100).toFixed(0)}% of the buffer`]);
    rows.push(['key-up crash vs speech', `${(peak / Math.max(speech, 1e-9)).toFixed(2)}x`]);

    // The priority version should open with the attention tone, so it starts
    // loud where the plain one starts with only a click.
    const hot = await render('Control — all units, vehicle failing to stop on Kingsway', true);
    const henv = envelope(hot.pcm, hot.sr);
    const first300 = Math.max(...henv.slice(0, 15));
    const plainFirst300 = Math.max(...env.slice(0, 15));
    rows.push(['priority opens louder', `${(first300 / Math.max(plainFirst300, 1e-9)).toFixed(1)}x`]);

    // ------------------------------------------------ 2. is it in the band
    // Sample the middle of the speech, well clear of both squelch bursts.
    const mid = Math.floor(plain.sr * plain.freeAt * 0.45);
    const n = 4096;
    const probes = [80, 150, 250, 500, 900, 1500, 2200, 3500, 5000, 7000];
    const e = probes.map((hz) => goertzel(plain.pcm, plain.sr, hz, mid, n));
    const tot = e.reduce((x, y) => x + y, 0) || 1;
    const pct = (lo, hi) => probes.reduce(
      (s, hz, i) => s + (hz >= lo && hz <= hi ? e[i] : 0), 0,
    ) / tot * 100;
    rows.push(['energy below 300 Hz', `${pct(0, 299).toFixed(1)}%`]);
    rows.push(['energy 300 Hz - 3 kHz', `${pct(300, 3000).toFixed(1)}%`]);
    rows.push(['energy above 3 kHz', `${pct(3001, 99999).toFixed(1)}%`]);

    // ------------------------------------------------ 3. the voices differ
    const lines = {
      control: 'Control — all units, resume patrol on the ring road',
      unit: 'U7 responding, northbound on Kingsway now',
      air: 'India 99 overhead, we have them on the ring road',
    };
    const sig = {};
    for (const [name, line] of Object.entries(lines)) {
      const r = await render(line, false);
      const at = Math.floor(r.sr * r.freeAt * 0.45);
      // Where the energy sits, as a crude brightness measure.
      const lowE = goertzel(r.pcm, r.sr, 500, at, n) + goertzel(r.pcm, r.sr, 800, at, n);
      const hiE = goertzel(r.pcm, r.sr, 1800, at, n) + goertzel(r.pcm, r.sr, 2500, at, n);
      // The body of the speech only. The overall peak is no use here: it is
      // the squelch crash, which is the same burst whoever is talking.
      const ev = envelope(r.pcm, r.sr);
      const w = 1000 / 20;
      const body = ev.slice(Math.round(0.25 * w), Math.round((r.freeAt - 0.45) * w));
      sig[name] = {
        len: +r.freeAt.toFixed(2),
        bright: +(hiE / Math.max(lowE, 1e-12)).toFixed(2),
        body: +Math.max(...body).toFixed(3),
      };
      rows.push([`${name} voice`,
        `${sig[name].len.toFixed(2)} s, speech ${sig[name].body.toFixed(3)}, `
        + `brightness ${sig[name].bright.toFixed(2)}`]);
    }
    // Two voices count as telling apart if any of the three measures moves by
    // a fifth or more -- below that a listener would hear the same person.
    const names = Object.keys(sig);
    let apart = 0, pairs = 0;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairs++;
        const a = sig[names[i]], b = sig[names[j]];
        const rel = (x, y) => Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-9);
        if (rel(a.len, b.len) > 0.2 || rel(a.body, b.body) > 0.2 || rel(a.bright, b.bright) > 0.2) {
          apart++;
        }
      }
    }
    rows.push(['voice pairs told apart', `${apart} of ${pairs}`]);

    // ------------------------------------------------ 4. one call at a time
    const g = window.__game, live = g.audio;
    if (live && live.ready && live.ctx.state === 'running') {
      live.radioQueue.length = 0;
      live.radioFreeAt = 0;
      live.radio('Control — all units, box formation', true);
      live.radio('U2 responding, southbound');
      live.radio('India 99 overhead, we have them');
      rows.push(['queued', `${live.radioQueue.length} waiting`]);
      live._pumpRadio();
      const first = live.radioFreeAt;
      live._pumpRadio();               // must refuse: channel still busy
      const stillFirst = live.radioFreeAt;
      rows.push(['second call held off', first === stillFirst ? 'yes' : 'NO -- they overlap']);
      rows.push(['queue after one goes', `${live.radioQueue.length} waiting`]);
      live.radioQueue.length = 0;
    } else {
      rows.push(['live channel test', 'skipped, audio not running']);
    }

    window.__res = rows.map((r) => `${r[0].padEnd(26)} ${r[1]}`).join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
