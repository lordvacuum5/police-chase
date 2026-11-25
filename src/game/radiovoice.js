// The police radio's own voices: recorded, put together, and through the radio.
//
// "Is it possible to find like a really cool like police speak text to speech engine thing? ... it could be much better."
// The browser's speech plays through its own output, so it could never be put through the radio's band-limiting, and which voices
// there are is down to the machine. A speech model in the browser would take the processor a laptop has none of to spare. So
// every line the game can say was said once, by Kokoro (tools/voice), in pieces: "Unit 3" "approaching" "Mercer Street" "and
// Fourth Street". Here they are found, put end to end, and played into the radio channel, like everything else on the net.
// A line with a piece missing is null, and the browser's voice says it as before.

const FILES = 'resources/voice/';
/** Counted up whenever the packs change: the server lets a browser keep one for a week. */
const VERSION = 2;

/** Gaps after a piece, s: run straight on (the pieces have a little silence of their own), after a comma, after a sentence. */
const RUN_ON = -0.045, COMMA = 0.02, STOP = 0.13;

const STEP = new Int32Array([7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]);
const MOVE = [-1, -1, -1, -1, 2, 4, 6, 8];

/** IMA ADPCM, 4 bits a sample, low nibble first, from nothing: floats. */
export function decode(bytes, n) {
  const out = new Float32Array(n);
  let pred = 0, idx = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i >> 1], c = i & 1 ? b >> 4 : b & 15, st = STEP[idx];
    let d = st >> 3;
    if (c & 4) d += st;
    if (c & 2) d += st >> 1;
    if (c & 1) d += st >> 2;
    pred += c & 8 ? -d : d;
    if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
    idx += MOVE[c & 7];
    if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
    out[i] = pred / 32768;
  }
  return out;
}

/** A spoken line (audio.js speakable) as words and the punctuation between. As tools/voice/lines.py tokens(). */
export function tokens(text) {
  return (String(text).toLowerCase().replace(/’/g, "'").replace(/-/g, ' ').match(/[a-z0-9]+(?:'[a-z]+)*|[.,!?]/g)) || [];
}

const isWord = (t) => !/^[.,!?]$/.test(t);

export class RadioVoice {
  constructor() {
    this.packs = new Map();
    this.buffers = new Map();
  }

  /** Fetch a pack ('common', or a map's road names) once; false if it is not there. */
  load(name) {
    if (!this.packs.has(name)) {
      this.packs.set(name, null);
      const p = fetch(`${FILES}${name}.bin?v=${VERSION}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
        if (!buf) return false;
        const b = new Uint8Array(buf);
        if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'PCV1') return false;
        const h = new DataView(buf).getUint32(4, true);
        const head = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + h)));
        this.packs.set(name, { head, data: b.subarray(8 + h) });
        return true;
      }).catch(() => false);
      this._loading = Promise.all([this._loading, p]);
    }
    return this._loading;
  }

  _find(voice, key) {
    for (const p of this.packs.values()) {
      const c = p && p.head.voices[voice] && p.head.voices[voice][key];
      if (c) return { p, at: c[0], n: c[1] };
    }
    return null;
  }

  /** Which of the voices a speaker ('control', 'unit', 'air') has for this line: two for the units, by callsign. */
  voiceOf(speaker, text) {
    if (speaker !== 'unit') return speaker;
    const m = /^unit (\d+)/i.exec(text);
    return m && +m[1] % 2 === 0 ? 'unitB' : 'unitA';
  }

  /** The pieces that say `text`, as few as will do: [{ voice, key, gap }], or null if they cannot. */
  plan(text, speaker) {
    const voice = this.voiceOf(speaker, text);
    // The second unit voice has no road names.
    return this._plan(text, voice) || (voice === 'unitB' ? this._plan(text, 'unitA') : null);
  }

  _plan(text, voice) {
    const tk = tokens(text), n = tk.length;
    // best[i]: the cheapest way to say the rest from token i, { cost, key, next }.
    const best = new Array(n + 1);
    best[n] = { cost: 0 };
    for (let i = n - 1; i >= 0; i--) {
      if (!isWord(tk[i])) { best[i] = best[i + 1] && { ...best[i + 1], skip: true }; continue; }
      let b = null, key = '';
      for (let j = i; j < n && j < i + 28; j++) {
        key = key ? `${key} ${tk[j]}` : tk[j];
        if (!isWord(tk[j])) continue;
        const rest = best[j + 1];
        if (!rest) continue;
        const after = tk[j + 1], want = after === undefined || /[.!?]/.test(after) ? 'f' : 'm';
        for (const c of [want, want === 'f' ? 'm' : 'f']) {
          const cost = rest.cost + 1 + (c === want ? 0 : 0.4);
          if (b && b.cost <= cost) continue;
          if (!this._find(voice, `${key}|${c}`)) continue;
          b = { cost, key: `${key}|${c}`, next: j + 1, gap: after === undefined ? 0 : after === ',' ? COMMA : want === 'f' ? STOP : RUN_ON };
        }
      }
      best[i] = b;
    }
    if (!best[0]) return null;
    const out = [];
    for (let i = 0; i < n;) {
      if (!isWord(tk[i])) { i++; continue; }
      const b = best[i];
      out.push({ voice, key: b.key, gap: b.gap });
      i = b.next;
    }
    return out;
  }

  _buffer(ctx, voice, key) {
    const id = `${voice}|${key}`;
    let b = this.buffers.get(id);
    if (!b) {
      const f = this._find(voice, key);
      const pcm = decode(f.p.data.subarray(f.at, f.at + ((f.n + 1) >> 1)), f.n);
      b = ctx.createBuffer(1, f.n, f.p.head.rate);
      b.copyToChannel(pcm, 0);
      // A minute or two of them kept: 8,000 floats a second.
      if (this.buffers.size > 80) this.buffers.delete(this.buffers.keys().next().value);
      this.buffers.set(id, b);
    }
    return b;
  }

  /** Play a plan into `dest` from `at` (ctx time), `gain` loud, `rate` fast (and high). { end, stop(when) }. */
  play(ctx, dest, plan, at, gain = 1, rate = 1) {
    const g = ctx.createGain(), srcs = [];
    g.gain.value = gain;
    g.connect(dest);
    let t = at;
    for (const p of plan) {
      const s = ctx.createBufferSource();
      s.buffer = this._buffer(ctx, p.voice, p.key);
      s.playbackRate.value = rate;
      s.connect(g);
      s.start(t);
      srcs.push(s);
      t += s.buffer.duration / rate + p.gap;
    }
    return { end: t, stop(when = ctx.currentTime) { for (const s of srcs) { try { s.stop(when); } catch (e) { /* over already */ } } } };
  }
}
