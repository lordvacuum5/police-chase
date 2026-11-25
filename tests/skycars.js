// Civilian cars in the sky. "I've seen some civilian cars still in the sky, certain positions when they're on the highway and I'm
// beneath."
//   const m = await import('/tests/skycars.js');  await m.skyCars({ spots: 8, secs: 25 })      // window.__sk
// The player stood on the street under the raised roads, a spot at a time, for `secs` each. Every half second, every civilian car:
//   air      what is under it, by a ray down from its roof to anything solid: more than 1.2 m below its wheels, in the air
//   by       those by what it is: asleep or awake, the edge its route is on (kind, deck or not), where the route's own level is
//   snap     the most any sleeping car's heading changed in a frame, degrees, and how many frames of over 8
//   still    of them, stood still; worst and where; seen: in the picture from under there
import { RAPIER, GROUP, groups } from '/src/physics/world.js';
const breathe = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });

export async function skyCars(opts = {}) {
  const g = window.__game, G = g.graph, p = g.player, W = g.world;
  g.paused = true;
  g.onBusted = () => { g.outcome = null; };
  const decks = G.edges.filter((e) => e.deck && e.length > 80);
  const out = window.__sk = { spots: 0, looks: 0, snap: 0, snaps: 0, frames: 0, onDeck: 0, air: 0, still: 0, seen: 0, by: {}, rows: [] };
  const SOLID = groups(0xFFFF, GROUP.TERRAIN | GROUP.HILL | GROUP.BUILDING | GROUP.RAMP | GROUP.PROP);
  const n = opts.spots || 8;
  for (let s = 0; s < n; s++) {
    const e = decks[Math.floor((s + 0.5) / n * decks.length)], q = G.pointAt(e, e.length / 2);
    const road = G.edges.filter((o) => !o.elevated && !o.deck && o.kind === 'street').map((o) => ({ o, d: Math.hypot(o.points[0].x - q.x, o.points[0].z - q.z) })).sort((a, b) => a.d - b.d)[0].o;
    const at = G.pointAt(road, road.length / 2);
    p.teleport({ x: at.x, y: g.sim.heightAt(at.x, at.z) + 0.7, z: at.z }, Math.atan2(q.x - at.x, q.z - at.z));
    const cam = g.camera;
    for (let t = 0; t < (opts.secs || 25) * 2; t++) {
      for (let k = 0; k < 2; k++) {
        cam.position.set(p.position.x - p.forward.x * 8, p.position.y + 3, p.position.z - p.forward.z * 8);
        cam.lookAt(q.x, p.position.y + 6, q.z);
        cam.updateMatrixWorld(true);
        for (let f = 0; f < 15; f++) {
          const was = new Map(g.traffic.cars.filter((c) => c.v.dormant).map((c) => [c.v, Math.atan2(c.v.forward.x, c.v.forward.z)]));
          g.stepHeadless(1 / 60, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
          for (const [v, h] of was) {
            if (!v.dormant || v.removed) continue;
            const b = Math.atan2(v.forward.x, v.forward.z), d = Math.abs(Math.atan2(Math.sin(b - h), Math.cos(b - h))) * 57.3;
            out.frames++;
            if (d > out.snap) out.snap = +d.toFixed(1);
            if (d > 8) out.snaps++;
          }
        }
      }
      for (const c of g.traffic.cars) {
        const v = c.v, o = v.position;
        out.looks++;
        const ground = g.sim.heightAt(o.x, o.z);
        if (o.y - ground < 2.5) continue;
        out.onDeck++;
        const hit = W.castRay(new RAPIER.Ray({ x: o.x, y: o.y + 0.9, z: o.z }, { x: 0, y: -1, z: 0 }), 60, true, undefined, SOLID, undefined, v.body);
        const toi = hit ? (hit.timeOfImpact !== undefined ? hit.timeOfImpact : hit.toi) : 60;
        const under = Math.min(o.y + 0.9 - ground, toi) - 0.9 - c.rideY;
        if (under < 1.2) continue;
        out.air++;
        const pts = c.driver.path || [], pt = pts[Math.min(c.driver.pathIndex, pts.length - 1)], ed = pt && pt.edge;
        const key = `${v.dormant ? 'asleep' : 'awake'} ${ed ? `${ed.kind}${ed.deck ? ' deck' : ''}${ed.bridge ? ' bridge' : ''}${ed.elevated ? ' up' : ''}` : 'no edge'}`;
        out.by[key] = (out.by[key] || 0) + 1;
        if (v.speed < 0.5) out.still++;
        const seen = g.inView(o);
        if (seen) out.seen++;
        if (out.rows.length < 25 && !out.rows.some((r) => r.id === c.id)) out.rows.push({ id: c.id, key, x: Math.round(o.x), y: +o.y.toFixed(1), z: Math.round(o.z), ground: +ground.toFixed(1), under: +under.toFixed(1), speed: +v.speed.toFixed(1), far: Math.round(Math.hypot(o.x - p.position.x, o.z - p.position.z)), level: ed ? +G.levelOn(ed, o.x, o.z).toFixed(1) : null, seen });
      }
      if (t % 2 === 0) await breathe();
    }
    out.spots++;
  }
  out.done = true;
  return out;
}
