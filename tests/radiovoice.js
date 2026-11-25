// Can the recorded radio say everything? Every wording in the game's source, filled in at random for each map (tools/voice/
// lines.py samples -> tests/data/radiolines.json): how many the packs can say, in how many pieces, and those they cannot,
// which the browser's own voice says. And every line comes out of the radio channel at what level.
//   const m = await import('/tests/radiovoice.js');  await m.radioVoice()      // window.__rv
import { RadioVoice, tokens } from '/src/game/radiovoice.js';
import * as A from '/src/game/audio.js';

export async function radioVoice(opts = {}) {
  const lines = await (await fetch('/tests/data/radiolines.json')).json();
  const out = window.__rv = { lines: 0, said: 0, pieces: 0, missing: [], clips: 0, by: {} };
  const speaker = (t) => (/India 99|Air support/i.test(t) ? 'air' : /^Control\b|^All units\b/i.test(t) ? 'control' : /^[A-Z]+\d+\b/.test(t) ? 'unit' : 'control');
  for (const map of ['city', 'wexbury', 'haldon']) {
    const v = new RadioVoice();
    await v.load('common');
    await v.load(map);
    const t0 = performance.now();
    for (const [m, t] of lines) {
      if (m !== map) continue;
      const kind = speaker(t), plan = v.plan(A.speakable(t), kind);
      const b = out.by[kind] || (out.by[kind] = { said: 0, of: 0, pieces: 0 });
      out.lines++; b.of++;
      if (!plan) { out.missing.push(t); continue; }
      out.said++; b.said++; b.pieces += plan.length; out.pieces += plan.length;
      // The words, in order, are all there.
      const want = tokens(A.speakable(t)).filter((x) => !/[.,!?]/.test(x)).join(' ');
      const got = plan.map((p) => tokens(p.key.split('|')[0]).filter((x) => !/[.,!?]/.test(x)).join(' ')).join(' ');
      if (want !== got) (out.wrong = out.wrong || []).push([want, got]);
    }
    out.planMs = +((performance.now() - t0) / (lines.length / 3)).toFixed(3);
    if (map === 'city' && opts.levels !== false) {
      // Out of the radio channel: loudness of some lines, dB below full, before the volume control.
      const res = [];
      for (const [m, t] of lines.filter((x) => x[0] === 'city').filter((x, i) => i % 9 === 0)) {
        const kind = speaker(t), plan = v.plan(A.speakable(t), kind);
        if (!plan) continue;
        const ctx = new OfflineAudioContext(1, 48000 * 12, 48000), a = Object.create(A.GameAudio.prototype);
        a.ctx = ctx;
        a.master = ctx.createGain();
        a.master.connect(ctx.destination);
        a._buildRadio();
        const line = v.play(ctx, a.radioIn, plan, 0.1, { control: 0.32, unit: 0.33, air: 0.37 }[kind]);
        const d = (await ctx.startRendering()).getChannelData(0).subarray(4800, Math.floor(line.end * 48000));
        let sum = 0, pk = 0;
        for (const x of d) { sum += x * x; pk = Math.max(pk, Math.abs(x)); }
        res.push({ kind, voice: plan[0].voice, db: +(10 * Math.log10(sum / d.length)).toFixed(1), peak: +pk.toFixed(2), secs: +(line.end - 0.1).toFixed(2), wps: +(tokens(t).length / (line.end - 0.1)).toFixed(1) });
      }
      const by = {};
      for (const r of res) (by[r.voice] = by[r.voice] || []).push(r);
      out.levels = Object.fromEntries(Object.entries(by).map(([k, l]) => [k, { n: l.length, db: [Math.min(...l.map((x) => x.db)), Math.max(...l.map((x) => x.db))], secs: +(l.reduce((s, x) => s + x.secs, 0) / l.length).toFixed(2), peak: Math.max(...l.map((x) => x.peak)) }]));
    }
  }
  out.pieces = +(out.pieces / Math.max(1, out.said)).toFixed(2);
  return out;
}
