// Busted for sitting on the quarry's ledges (Heat._checkLedges). Haldon Vale.
//
// "If you stay on any of those ledges for like 10 seconds, then a warning
// starts appearing. And even if you're on any other ledge ... the countdown
// will still be going, and it'll be 10, 9, until you just get busted ... I
// want that to reset, so if the person ... goes ... off all the ledges resets
// every ... one minute."
//
// The player's car parked in turn at places in and round the quarry, one star,
// the ordinary pinned arrest switched off so only this one can land, and the
// game stepped headless. Each case says when the warning came up (`warn`) and
// when the arrest landed (`bust`), seconds from the start, or null:
//
//   ledge k     parked on ledge k (0 the lowest), 25 s
//   floor, rim, cutting   not ledges: nothing should happen, 25 s
//   hop         5 s on ledge 0, then ledge 2: one clock across both
//   back        8 s on a ledge, 30 s on the floor, back on: still counting
//   reset       8 s on a ledge, 61 s on the floor, back on: from nothing
window.__runLedgeBust = async function () {
  window.__res = null;
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player && window.__game.heat && window.__game.world.__map); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const q = g.world.__map.quarry;
    // A step first: on a fresh page the ray below meets nothing until the
    // physics has stepped once, and the first car went in under the rock.
    g.stepHeadless(0.5);
    const { RAPIER } = await import('/src/physics/world.js');
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const top = (x, z) => {
      ray.origin.x = x; ray.origin.y = 90; ray.origin.z = z;
      const h = g.world.castRay(ray, 200, true, undefined, (0xFFFF0000 | 0x2 | 0x40) >>> 0);
      return h ? 90 - (h.timeOfImpact !== undefined ? h.timeOfImpact : h.toi) : g.sim.heightAt(x, z);
    };
    // Round the back wall, away from the cutting.
    const at = (r, a = q.high) => ({ x: q.x + Math.cos(a) * r, z: q.z + Math.sin(a) * r });
    const ledge = (k) => at(q.inner + q.bench * (k + 0.5));
    const places = {
      floor: at(q.inner - 20), rim: at(q.rimOut + 15),
      cutting: at(q.r + 2, q.open),
    };
    let bustAt = null;
    g.onBusted = () => { if (bustAt === null) bustAt = t; };
    g.heat._checkBust = () => {};
    const p = g.player;
    let t = 0;
    const park = (pos) => {
      p.repair();
      p.teleport({ x: pos.x, y: top(pos.x, pos.z) + 0.8, z: pos.z }, q.high + Math.PI / 2);
      p.setVelocity({ x: 0, y: 0, z: 0 });
    };
    const step = async (secs) => {
      for (let i = 0; i < secs * 30; i++) {
        g.heat.value = 1; g.heat.evadeTimer = 0;
        p.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
        // Keep the police off, so none of them is in the way of anything.
        for (const u of g.dispatcher.units) {
          if (u.vehicle && Math.hypot(u.vehicle.position.x - p.position.x, u.vehicle.position.z - p.position.z) < 60) {
            u.vehicle.teleport({ x: q.x + 400, y: g.sim.heightAt(q.x + 400, q.z) + 1, z: q.z }, 0);
          }
        }
        g._update(1 / 30);
        t += 1 / 30;
        if (warnAt === null && g.heat.ledgeRemaining !== null) warnAt = t;
        if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    };
    let warnAt = null;
    const rows = [];
    const run = async (name, plan) => {
      g.heat.reset();
      g.heat.value = 1;
      t = 0; warnAt = null; bustAt = null;
      await plan();
      rows.push(`${name}: warn ${warnAt === null ? null : warnAt.toFixed(1)}, bust ${bustAt === null ? null : bustAt.toFixed(1)}`);
    };
    for (let k = 0; k < q.tiers - 1; k++) await run(`ledge ${k}`, async () => { park(ledge(k)); await step(25); });
    for (const name of ['floor', 'rim', 'cutting']) await run(name, async () => { park(places[name]); await step(25); });
    await run('hop', async () => { park(ledge(0)); await step(5); park(ledge(2)); await step(20); });
    await run('back', async () => { park(ledge(1)); await step(8); park(places.floor); await step(30); park(ledge(1)); await step(15); });
    await run('reset', async () => { park(ledge(1)); await step(8); park(places.floor); await step(61); park(ledge(1)); await step(15); });
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
