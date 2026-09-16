// Does an imported body land on the road in the right place?
//
// Builds a .glb in memory rather than keeping a binary fixture in the repo: a
// box the shape of a car, plus a node called "Wheel_FL", deliberately modelled
// in centimetres and three times life size, facing the wrong way. All four of
// those are things a downloaded model does, and all four are things the fitter
// is supposed to absorb.
//
//   fitted       the size the body ends up, against the generated body it
//                replaces -- these should match to a few centimetres
//   wheelsGone   the file's own wheels are dropped; the game supplies its own
//   lamps        where the flashing lights sit, which must be above the roof
//   fallback     with no file there at all, the generated body is still used
window.__runCarModel = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const THREE = window.__modules.THREE;
    const { loadCarModel } = await import('/src/game/carmodel.js');

    // ---- a car-shaped box, in centimetres, three times too big ----
    const glb = (() => {
      const S = 300;                                   // wrong scale on purpose
      const hx = 0.33 * S, hy = 0.27 * S, hz = 0.85 * S;
      const c = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]];
      const v = [];
      for (const p of c) v.push(p[0], p[1], p[2]);
      const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
        3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];
      const pos = new Float32Array(v), ind = new Uint16Array(idx);
      const pad = (n) => (4 - (n % 4)) % 4;
      const indOff = pos.byteLength + pad(pos.byteLength);
      const binLen = indOff + ind.byteLength + pad(indOff + ind.byteLength);
      const bin = new Uint8Array(binLen);
      bin.set(new Uint8Array(pos.buffer), 0);
      bin.set(new Uint8Array(ind.buffer), indOff);
      const min = [-hx, -hy, -hz], max = [hx, hy, hz];
      const json = {
        asset: { version: '2.0', generator: 'tests/carmodel.js' },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        // The body, and a wheel the game should throw away.
        nodes: [{ mesh: 0, name: 'Body' }, { mesh: 0, name: 'Wheel_FL' }],
        meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
        materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.25, 0.7, 1] } }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min, max },
          { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
          { buffer: 0, byteOffset: indOff, byteLength: ind.byteLength, target: 34963 },
        ],
        buffers: [{ byteLength: binLen }],
      };
      let s = JSON.stringify(json);
      while (s.length % 4) s += ' ';
      const jb = new TextEncoder().encode(s);
      const total = 12 + 8 + jb.length + 8 + bin.length;
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
      dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4E4F534A, true);
      out.set(jb, 20);
      const bh = 20 + jb.length;
      dv.setUint32(bh, bin.length, true); dv.setUint32(bh + 4, 0x004E4942, true);
      out.set(bin, bh + 8);
      return out;
    })();

    const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    const target = g._geometryFor('suv', 'suv', true, false);
    target.computeBoundingBox();
    const want = target.boundingBox;

    // Modelled facing backwards, so the fitter is asked to turn it round.
    const model = await loadCarModel(url, target, { yaw: Math.PI });
    URL.revokeObjectURL(url);
    if (!model) return 'the model did not load';

    const box = new THREE.Box3().setFromObject(model.scene);
    let wheels = 0;
    model.scene.traverse((o) => { if (/wheel/i.test(o.name || '')) wheels++; });

    // ---- and with nothing there at all ----
    const missing = await loadCarModel('assets/models/definitely-not-here.glb', target, {});

    const r3 = (n) => +n.toFixed(2);
    return {
      fittedLength: r3(box.max.z - box.min.z), bodyLength: r3(want.max.z - want.min.z),
      fittedWidth: r3(box.max.x - box.min.x), bodyWidth: r3(want.max.x - want.min.x),
      fittedBottom: r3(box.min.y), bodyBottom: r3(want.min.y),
      lampY: r3(model.lamps[0].y), roofY: r3(box.max.y),
      lampsClearTheRoof: model.lamps[0].y > box.max.y,
      wheelsGone: wheels === 0,
      fallbackUsed: missing === null,
      scale: +model.scale.toFixed(4),
    };
  } catch (e) {
    return 'EX ' + e.message + ' ' + String(e.stack).slice(0, 300);
  }
};
