// A hash of every bit of the drawn world: each geometry's position, normal, colour and uv numbers, as float32 bits, in
// the scene's order; and, apart, every texture drawn on a canvas, by its pixels. For changes meant to leave the map
// exactly as it was ("the American map loads much worse": speeding up the load): equal before and after, or something
// moved. Vehicles are in the scene too, so compare loads in the same state (the car cards already taken, game/cards.js).
//   const m = await import('/tests/worldhash.js');  m.worldHash()      // { hash, verts, geometries, textures, texHash }
export function worldHash(scene = window.__game.scene) {
  let h = 0x811c9dc5 | 0, verts = 0, geometries = 0;
  const seen = new Set(), tex = new Set();
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const k of ['map', 'roughnessMap', 'normalMap', 'bumpMap']) if (m && m[k] && m[k].image) tex.add(m[k].image);
    if (!o.geometry || seen.has(o.geometry)) return;
    seen.add(o.geometry);
    geometries++;
    const A = o.geometry.attributes;
    for (const k of ['position', 'normal', 'color', 'uv']) {
      const at = A[k];
      if (!at || !at.array || !(at.array instanceof Float32Array)) continue;
      const u = new Uint32Array(at.array.buffer, at.array.byteOffset, at.array.length);
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
      if (k === 'position') verts += at.count;
    }
    const ix = o.geometry.index;
    if (ix) for (let i = 0; i < ix.array.length; i++) h = Math.imul(h ^ ix.array[i], 16777619);
  });
  let th = 0x811c9dc5 | 0, textures = 0;
  for (const img of tex) {
    if (!(img instanceof HTMLCanvasElement) || !img.width) continue;
    const d = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    const u = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
    for (let i = 0; i < u.length; i++) th = Math.imul(th ^ u[i], 16777619);
    textures++;
  }
  return { hash: (h >>> 0).toString(16), verts, geometries, textures, texHash: (th >>> 0).toString(16) };
}
