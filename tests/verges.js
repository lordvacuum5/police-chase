// Where the verge grass ended up: how much of it is in a house, on a pavement, on a drive.
//
// "The greenery at the side of the road looks amazing, but it shouldn't be on the pavement ... it should only
// be in the green, and obviously it shouldn't then be inside houses."
//
//   const m = await import('/tests/verges.js');  m.vergeCheck()
//
//   tufts        how many were planted
//   inHouse      with a building's collider at a metre up (Rapier's own answer, not the list they were kept out by)
//   onPavement   nearer a road than its edge plus its footway (edge.pave)
//   onRoad       nearer a road than its edge
import { GROUP } from '../src/physics/world.js';

export function vergeCheck(name = 'verges') {
  const g = window.__game, root = g.scene.getObjectByName(name);
  if (!root) return 'no verges';
  g.world.step();      // fills the query pipeline
  let tufts = 0, inHouse = 0, onPavement = 0, onRoad = 0;
  for (const lod of root.children) {
    const im = lod.levels[0].object, a = im.instanceMatrix.array;
    for (let i = 0; i < im.count; i++) {
      const x = a[i * 16 + 12] + lod.position.x, y = a[i * 16 + 13], z = a[i * 16 + 14] + lod.position.z;
      tufts++;
      let hit = false;
      g.world.intersectionsWithPoint({ x, y: y + 1, z }, (c) => {
        const grp = c.collisionGroups() >>> 16;
        if (grp & GROUP.BUILDING) { hit = true; return false; }
        return true;
      });
      if (hit) inHouse++;
      for (const e of g.graph.edgesNear(x, z, 24)) {
        let best = Infinity;
        for (const sg of e.segs) {
          const dx = sg.b.x - sg.a.x, dz = sg.b.z - sg.a.z, l2 = dx * dx + dz * dz;
          let t = l2 > 1e-9 ? ((x - sg.a.x) * dx + (z - sg.a.z) * dz) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(sg.a.x + dx * t - x, sg.a.z + dz * t - z));
        }
        if (best < e.width * 0.5) { onRoad++; break; }
        if (e.pave && best < e.width * 0.5 + e.pave) { onPavement++; break; }
      }
    }
  }
  return { map: g.mapDef.id, tufts, inHouse, onPavement, onRoad };
}
