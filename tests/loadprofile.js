// Where a map's load goes, by function. "The American map loads much worse."
//   Served with the JS Self-Profiling API allowed and a Profiler started first thing on the page (a header,
//   `Document-Policy: js-profiling`, and `window.__prof = new Profiler({ sampleInterval: 1, maxBufferSize: 2e6 })`
//   at the top of index.html), then once the game is up:
//   const m = await import('/tests/loadprofile.js');  await m.loadProfile({ top: 40 })     // window.__lp
// Each sample's own function (self) and every function on its stack (total), in ms, up to the game being ready.
export async function loadProfile(opts = {}) {
  for (let i = 0; i < 900 && !(window.__game && window.__game.loadTimes && window.__game.loadTimes.ready); i++) await new Promise((r) => setTimeout(r, 100));
  const tr = window.__trace = window.__trace || await window.__prof.stop();
  const until = (window.__game.loadTimes.ready || Infinity);
  const name = (f) => {
    const fr = tr.frames[f];
    const res = fr.resourceId !== undefined ? tr.resources[fr.resourceId].replace(/^.*\/(src|vendor)\//, '') : '';
    return `${fr.name || '(anon)'} ${res}:${fr.line || 0}`;
  };
  const self = new Map(), total = new Map();
  let prev = null, idle = 0, gaps = 0, n = 0;
  for (const s of tr.samples) {
    if (s.timestamp > until) break;
    const raw = prev === null ? 0 : s.timestamp - prev, dt = Math.min(raw, 20);
    if (raw > 20) gaps += raw - 20;
    n++;
    prev = s.timestamp;
    if (s.stackId === undefined || s.stackId === null) { idle += dt; continue; }
    let id = s.stackId, first = true;
    const seen = new Set();
    while (id !== undefined && id !== null) {
      const st = tr.stacks[id], nm = name(st.frameId);
      if (first) { self.set(nm, (self.get(nm) || 0) + dt); first = false; }
      if (!seen.has(nm)) { seen.add(nm); total.set(nm, (total.get(nm) || 0) + dt); }
      id = st.parentId;
    }
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, opts.top || 40).map(([k, v]) => `${Math.round(v)} ${k}`);
  return (window.__lp = { samples: n, idle: Math.round(idle), gaps: Math.round(gaps), self: top(self), total: top(total) });
}
