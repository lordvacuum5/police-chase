// A big static mesh as a grid of smaller ones, so what is off the screen, or outside the sun's shadow box,
// is not drawn.
//
// The trees showed what it was worth (README, "Trees"): one mesh for a whole map is drawn whole, twice a
// frame -- the picture and the shadows -- wherever you look. The buildings were four meshes a map, one a
// quarter, so most of the town was drawn every frame and all of a quarter for the shadow of one house.
// Material groups are kept (the walls and roofs of world/buildtex.js), each cell's in the same order.

import * as THREE from 'three';

/** Off, to compare: sessionStorage 'pc.nochunks' = 1 and reload (or window.__noChunks before load). */
const OFF = (() => { try { return window.__noChunks || sessionStorage.getItem('pc.nochunks') === '1'; } catch (e) { return !!window.__noChunks; } })();

/**
 * Split non-indexed `mesh` into cells of `cell` metres by where each triangle's middle is. Returns a group
 * under the mesh's name with one mesh a cell, sharing the material(s) and the shadow flags. Indexed
 * meshes, and `window.__noChunks`, are left as they are.
 */
export function chunkMesh(mesh, cell = 150) {
  if (OFF || !mesh || !mesh.geometry || mesh.geometry.index) return mesh;
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const tris = pos.count / 3;
  // Each triangle's group (material index), from the geometry's groups; 0 if it has none.
  const groupOf = new Int16Array(tris);
  for (const gr of geo.groups) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) groupOf[t] = gr.materialIndex;
  const cells = new Map();
  for (let t = 0; t < tris; t++) {
    const cx = (pos.getX(t * 3) + pos.getX(t * 3 + 1) + pos.getX(t * 3 + 2)) / 3 + mesh.position.x;
    const cz = (pos.getZ(t * 3) + pos.getZ(t * 3 + 1) + pos.getZ(t * 3 + 2)) / 3 + mesh.position.z;
    const key = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(t);
  }
  const group = new THREE.Group();
  group.name = mesh.name;
  group.position.copy(mesh.position);
  const names = Object.keys(geo.attributes);
  for (const list of cells.values()) {
    // In material order, so each material is one run.
    list.sort((a, b) => groupOf[a] - groupOf[b] || a - b);
    const g = new THREE.BufferGeometry();
    for (const name of names) {
      const a = geo.attributes[name], n = a.itemSize;
      const out = new Float32Array(list.length * 3 * n);
      let o = 0;
      for (const t of list) for (let k = 0; k < 3 * n; k++) out[o++] = a.array[t * 3 * n + k];
      g.setAttribute(name, new THREE.BufferAttribute(out, n));
    }
    if (geo.groups.length) {
      let start = 0;
      while (start < list.length) {
        const mi = groupOf[list[start]];
        let end = start;
        while (end < list.length && groupOf[list[end]] === mi) end++;
        g.addGroup(start * 3, (end - start) * 3, mi);
        start = end;
      }
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mesh.material);
    m.castShadow = mesh.castShadow;
    m.receiveShadow = mesh.receiveShadow;
    m.renderOrder = mesh.renderOrder;
    m.name = mesh.name;
    group.add(m);
  }
  geo.dispose();
  return group;
}
