// Do police cars appear where you can see them?
//
// Drives a chase like tests/harness.js and, every time a police car is created,
// asks whether the player's camera could see the spot at that moment: inside
// the view (with a margin, since half a car coming into shot is still a car
// appearing), not hidden behind a building, and close enough to be more than a
// speck in the fog. Counts those, split by how the car was put there.
window.__runPopIn = async function (seconds = 120) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, M = window.__modules, p = g.player, gr = g.graph, THREE = M.THREE;
    const { hasLineOfSight } = await import('/src/physics/world.js');
    if (g.audio) g.audio.muted = true;

    const frustum = new THREE.Frustum(), mat = new THREE.Matrix4(), sphere = new THREE.Sphere();
    const eye = new THREE.Vector3(), at = new THREE.Vector3();
    const visible = (pos) => {
      const cam = g.camera;
      cam.updateMatrixWorld(true);
      const d = cam.position.distanceTo(at.set(pos.x, pos.y || 0, pos.z));
      if (d > 700) return { seen: false, d };
      mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(mat);
      sphere.center.set(pos.x, 1, pos.z);
      sphere.radius = 3;
      if (!frustum.intersectsSphere(sphere)) return { seen: false, d };
      eye.copy(cam.position);
      at.set(pos.x, 1.2, pos.z);
      return { seen: hasLineOfSight(g.world, eye, at, 0.3), d };
    };

    // Which spawn path created a car.
    let source = 'other';
    const wrap = (name) => {
      const real = g[name].bind(g);
      g[name] = (...args) => { const prev = source; source = name; try { return real(...args); } finally { source = prev; } };
      return real;
    };
    const realNear = wrap('spawnPoliceNear');
    const realAhead = wrap('spawnPoliceAhead');
    const realAt = g.spawnPoliceAt ? wrap('spawnPoliceAt') : null;

    const tally = {};
    const realCreate = g.createVehicle.bind(g);
    g.createVehicle = (spec, livery, pos, heading, opts = {}) => {
      const v = realCreate(spec, livery, pos, heading, opts);
      if (opts.police) {
        const r = visible(pos);
        const t = tally[source] || (tally[source] = { spawned: 0, inView: 0, dists: [] });
        t.spawned++;
        if (r.seen) { t.inView++; t.dists.push(Math.round(r.d)); }
      }
      return v;
    };

    // A quarry that drives itself.
    const auto = new M.Driver(p, M.SKILL.pursuit);
    auto.limitScale = 1.6;
    const route = () => {
      const to = gr.randomNode(g.rng);
      const pts = gr.pathFromPosition(p.position.x, p.position.z, p.forward.x, p.forward.z, to.id, 2.5);
      if (pts.length > 1) auto.setPath(pts);
    };
    const origU = g._update.bind(g);
    g.onBusted = () => { g.outcome = null; g.heat.bustTimer = 0; };
    g._update = (dt) => {
      if (p.damage > 0.5) p.repair();
      if (g.heat.value < 3.5) g.heat.value = 3.8;
      if (!auto.hasPath || auto.remaining() < 120) route();
      auto.avoid(g.vehicles, dt);
      g.forceControls = Object.assign({}, auto.followPath(dt, 50));
      origU(dt);
    };
    route();
    g.heat.value = 0; g.heat.bump(1, 'a test'); g.heat.value = 3.8;

    for (let i = 0; i < Math.round(seconds / 0.1); i++) {
      g.stepHeadless(0.1);
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    g._update = origU;
    g.createVehicle = realCreate;
    g.spawnPoliceNear = realNear;
    g.spawnPoliceAhead = realAhead;
    if (realAt) g.spawnPoliceAt = realAt;
    if (g.audio) g.audio.muted = false;

    window.__res = JSON.stringify(Object.fromEntries(Object.entries(tally).map(([k, t]) => [k, {
      spawned: t.spawned, inView: t.inView,
      inViewDistances: t.dists.sort((a, b) => a - b),
    }])));
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
