// What makes a slow frame?
//
// "Try to stop it juddering so much." A smooth average with the odd long frame is what
// judder is, so this times each part of Game._update for every frame while something
// else (tests/soak.js, say) drives the game, and reports the slow frames and whose
// fault each one was. Headless: it cannot see the renderer, only the simulation.
//
//   __startHitches(); ...drive...; __stopHitches() -> window.__hitches
window.__startHitches = function () {
  const g = window.__game;
  const parts = {};
  const undo = [];
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name];
    parts[label] = 0;
    obj[name] = function (...a) {
      const t = performance.now();
      const r = orig.apply(this, a);
      parts[label] += performance.now() - t;
      return r;
    };
    undo.push(() => { obj[name] = orig; });
  };
  wrap(g.dispatcher, 'update', 'dispatcher');
  wrap(g.dispatcher, '_manageRoster', 'roster');
  wrap(g.traffic, 'update', 'traffic');
  wrap(g.suspects, 'update', 'suspects');
  wrap(g.helicopter, 'update', 'helicopter');
  wrap(g.roadblocks, 'update', 'roadblocks');
  wrap(g.hud, 'update', 'hud');
  wrap(g.world, 'step', 'physics');
  wrap(g.audio, 'update', 'audio');
  wrap(g, 'createVehicle', 'createVehicle');
  wrap(g, 'removeVehicle', 'removeVehicle');
  wrap(g, 'spawnPoliceNear', 'spawnPolice');
  const frames = [], slow = [];
  const origU = g._update;
  const self = g._update.bind(g);
  g._update = function (dt) {
    for (const k of Object.keys(parts)) parts[k] = 0;
    const t = performance.now();
    self(dt);
    const ms = performance.now() - t;
    frames.push(ms);
    if (ms > 12 && slow.length < 400) {
      const by = Object.keys(parts).filter((k) => parts[k] > 1).sort((a, b) => parts[b] - parts[a])
        .slice(0, 3).map((k) => `${k} ${parts[k].toFixed(1)}`).join(', ');
      slow.push(`${ms.toFixed(1)} ms: ${by}`);
    }
  };
  window.__stopHitches = function () {
    g._update = origU;
    for (const u of undo) u();
    frames.sort((a, b) => a - b);
    const at = (p) => +frames[Math.floor(frames.length * p)].toFixed(1);
    const blame = {};
    for (const line of slow) {
      const m = line.split(': ')[1].split(' ')[0] || 'other';
      blame[m] = (blame[m] || 0) + 1;
    }
    window.__hitches = {
      frames: frames.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), p999: at(0.999), max: +frames[frames.length - 1].toFixed(1),
      over12: frames.filter((f) => f > 12).length, over16: frames.filter((f) => f > 16).length, over33: frames.filter((f) => f > 33).length,
      blame, worst: slow.slice().sort((a, b) => parseFloat(b) - parseFloat(a)).slice(0, 12),
    };
    return window.__hitches;
  };
};
