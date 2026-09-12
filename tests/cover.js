// Where exactly is the carriageway still covered? Breaks the failures out of
// tests/surfaces.js down by road kind, how far across the lane the sample was,
// and what the surface grid thinks is there -- so a drawing fault can be told
// apart from a deliberate seam at the kerb.
window.__runCover = function () {
  try {
    var g = window.__game, gr = g.graph, THREE = window.__modules.THREE;
    var surfaces = ['roads', 'pavements', 'plates', 'ground']
      .map(function (n) { return g.scene.getObjectByName(n); })
      .filter(Boolean);
    var ray = new THREE.Raycaster(); ray.far = 200;
    var down = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
    var drivable = gr.edges.filter(function (e) { return !e.dead && !e.turningHead; });
    var sat = g.sim && g.sim.surfaceAt;
    var hat = g.sim && g.sim.heightAt;
    var clusters = {};
    var out = { n: 0, tot: 0, kinds: {}, tops: {}, grid: { road: 0, paved: 0, other: 0 }, ex: [] };
    var offs = [];
    for (var i = 0; i < 4000; i++) {
      var e = drivable[(i * 7919) % drivable.length];
      var along = ((i * 0.6180339887) % 1) * e.length;
      var p = gr.pointAt(e, along);
      var off = (((i * 0.4142) % 1) * 2 - 1) * (e.width * 0.5 - 1.2);
      var x = p.x - p.tz * off, z = p.z + p.tx * off;
      from.set(x, 60, z); ray.set(from, down);
      var hits = ray.intersectObjects(surfaces, false);
      if (!hits.length) continue;
      out.tot++;
      if (hits[0].object.name === 'roads') continue;
      out.n++;
      out.kinds[e.kind] = (out.kinds[e.kind] || 0) + 1;
      out.tops[hits[0].object.name] = (out.tops[hits[0].object.name] || 0) + 1;
      offs.push(+(Math.abs(off) / (e.width * 0.5)).toFixed(2));
      var sc = sat ? sat(x, z) : -1;
      if (sc === 1) out.grid.road++; else if (sc === 2) out.grid.paved++; else out.grid.other++;
      // 200 m buckets, so a handful of bad places can be told from a fault
      // spread over the whole map.
      var ck = Math.round(x / 200) * 200 + ',' + Math.round(z / 200) * 200;
      clusters[ck] = (clusters[ck] || 0) + 1;
      if (out.ex.length < 8) {
        out.ex.push({
          k: e.kind, w: +e.width.toFixed(1), off: +off.toFixed(2),
          x: +x.toFixed(1), z: +z.toFixed(1),
          top: hits[0].object.name, y: +hits[0].point.y.toFixed(3),
          grid: sc, h: hat ? +hat(x, z).toFixed(3) : null,
        });
      }
    }
    offs.sort(function (a, b) { return a - b; });
    out.offFrac = { min: offs[0], med: offs[offs.length >> 1], max: offs[offs.length - 1] };
    out.hasSurfaceAt = !!sat;
    out.clusters = Object.entries(clusters)
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
    window.__res = JSON.stringify(out);
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 400);
  }
};
