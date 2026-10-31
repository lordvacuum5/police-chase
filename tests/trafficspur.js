// Traffic out of nowhere: cars up and down lanes that only go to a farm.
//
// "I was just like driving over a hill, and suddenly there were like a line of
// cars, civilian cars, seemingly all come from this farm building ... it's
// fine if there's a big line of cars on a normal road, but ... if it's a tiny
// road, and the only place that road leads it to was a farm building, like,
// that's not very realistic."
//
// A spur is road that leads only to dead ends: what is left of the graph's
// leaves pruned away until none are left is the through road, and anything
// pruned is spur. The player parked at `at` (a node) while the game is stepped
// headless for `minutes`, no wanted level:
//
//   spawned   traffic cars made, and how many of them on a spur
//   onSpur    share of traffic car-seconds spent on a spur
window.__runTrafficSpur = async function (minutes = 5) {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.traffic && window.__game.heat); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, gr = g.graph;
    g.onBusted = () => { g.outcome = null; };
    // The pruning, independently of game/traffic.js.
    const deg = new Map();
    const live = (e) => !e.cut && !e.quarry;
    for (const n of gr.nodes) deg.set(n.id, n.edges.filter((id) => live(gr.edges[id])).length);
    const spurNode = new Set();
    let leaves = gr.nodes.filter((n) => deg.get(n.id) === 1);
    while (leaves.length) {
      const next = [];
      for (const n of leaves) {
        if (spurNode.has(n.id)) continue;
        spurNode.add(n.id);
        for (const id of n.edges) {
          const e = gr.edges[id];
          if (!live(e)) continue;
          const o = e.a === n.id ? e.b : e.a;
          if (spurNode.has(o)) continue;
          deg.set(o, deg.get(o) - 1);
          if (deg.get(o) === 1) next.push(gr.nodes[o]);
        }
      }
      leaves = next;
    }
    const spurEdge = (e) => live(e) && (spurNode.has(e.a) || spurNode.has(e.b));
    const onSpur = (v) => {
      const s = gr.nearestEdge(v.position.x, v.position.z, 30);
      return !!(s && spurEdge(s.edge));
    };
    const seen = new Set();
    let spawned = 0, spurSpawned = 0, carSec = 0, spurSec = 0;
    const steps = minutes * 60 * 30;
    const p = g.player;
    for (let i = 0; i < steps; i++) {
      g.heat.value = 0;
      p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
      g._update(1 / 30);
      if (i % 15 !== 0) continue;
      for (const c of g.traffic.cars) {
        if (!seen.has(c)) {
          seen.add(c);
          spawned++;
          if (onSpur(c.v)) spurSpawned++;
        }
        carSec += 0.5;
        if (onSpur(c.v)) spurSec += 0.5;
      }
      if (i % 600 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const spurLen = gr.edges.filter(spurEdge).reduce((s, e) => s + e.length, 0);
    const allLen = gr.edges.filter(live).reduce((s, e) => s + e.length, 0);
    window.__res = JSON.stringify({
      spawned, spurSpawned, onSpur: +(spurSec / Math.max(1, carSec)).toFixed(3),
      spurRoad: Math.round(spurLen) + ' of ' + Math.round(allLen) + ' m',
    });
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
