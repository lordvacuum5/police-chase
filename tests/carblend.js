// Can you see a far car become the real one? "It's very obvious to the human eye that it's suddenly becoming really detailed."
//   const m = await import('/tests/carblend.js');  await m.carBlend()      // window.__cb, and window.__cbPics
// Each kind of traffic car on its own, side on and three-quarters, drawn by the model and by its stand-in at the distance each
// stand-in comes in (farcars.js): how far apart the two pictures are, 0 to 255 a channel, averaged over the pixels the car
// covers. And for the size of a step: the real car at that distance against itself 0.3 m further off, which is what one frame
// of driving towards it at 65 km/h does anyway.
const breathe = () => new Promise((r) => setTimeout(r, 0));

export async function carBlend(opts = {}) {
  const g = window.__game, R = g.renderer, THREE = window.__modules.THREE || await import('three');
  g.paused = true;
  const W = 1280, H = 720, gl = R.getContext();
  R.setPixelRatio(1);
  R.setSize(W, H, false);
  g.camera.aspect = W / H;
  g.camera.updateProjectionMatrix();
  const { FADE0, FADE1 } = await import('/src/game/farcars.js');
  const out = window.__cb = {}, pics = window.__cbPics = [];
  const vis = g.scene.children.map((o) => [o, o.visible]);
  for (const o of g.scene.children) if (!o.isLight && o !== g.sun.target) o.visible = false;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x55585c }));
  ground.rotation.x = -Math.PI / 2;
  g.scene.add(ground);
  const hemi = g.scene.children.filter((o) => o.isLight);
  for (const l of hemi) l.visible = true;
  const f = g.farCars, c = g.camera;
  const grab = (d, cssW) => {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    void cssW;
    return px;
  };
  const diff = (a, b, bg) => {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const covered = Math.abs(a[i] - bg[i]) + Math.abs(a[i + 1] - bg[i + 1]) + Math.abs(a[i + 2] - bg[i + 2]) > 12
        || Math.abs(b[i] - bg[i]) + Math.abs(b[i + 1] - bg[i + 1]) + Math.abs(b[i + 2] - bg[i + 2]) > 12;
      if (!covered) continue;
      n++;
      sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    }
    return { mean: n ? +(sum / n).toFixed(1) : 0, px: n };
  };
  try {
    for (const kind of opts.kinds || ['hatchback', 'estate', 'civsuv']) {
      const { SPECS } = await import('/src/game/vehicles.js'), { standing } = await import('/src/game/carlod.js');
      const spec = SPECS[kind], st = standing(spec);
      const real = new THREE.Group();
      const model = g.carModels[kind].scene.clone(true);
      const hex = opts.paint || 0x9a2b25;
      model.traverse((o) => { if (o.isMesh && o.material.name === 'paint') { o.material = o.material.clone(); o.material.color.setHex(hex); } });
      real.add(model);
      for (const [x, y, z, front] of st.wheels) {
        const w = new THREE.Mesh(g.wheelMesh.geometry, g.wheelMesh.material);
        w.position.set(x, y, z);
        const rs = spec.wheelRadius / 0.34;
        w.scale.set((!front && spec.wheelWidthRear ? spec.wheelWidthRear : spec.wheelWidth) / 0.26, rs, rs);
        real.add(w);
      }
      real.position.set(0, st.bodyY, 0);
      g.scene.add(real);
      real.updateMatrixWorld(true);
      for (const [view, ang] of [['side', Math.PI / 2], ['quarter', 0.6], ['behind', Math.PI + 0.1]]) {
        for (const d of [FADE0 + 1, FADE1, 126, 231]) {
          const at = (dd) => { c.position.set(Math.sin(ang) * dd, 3, Math.cos(ang) * dd); c.lookAt(0, 1, 0); c.updateMatrixWorld(true); };
          const shot = (mode, dd) => {
            at(dd);
            f.begin(c, false, null);
            real.visible = mode === 'real' || mode === 'mix';
            const q = new THREE.Quaternion();
            if (mode !== 'real' && mode !== 'bg') f.add(kind, real.position, q, hex, Math.max(d, FADE0 + 0.01));
            f.end();
            if (mode === 'stand') for (const b of f.kinds[kind]) { b.fade.array.fill(1); b.fade.needsUpdate = true; }
            R.render(g.scene, c);
            return grab();
          };
          const bg = shot('bg', d), a = shot('real', d), b = shot('stand', d), a2 = shot('real', d + 0.3);
          out[`${kind} ${view} ${Math.round(d)}`] = { swap: diff(a, b, bg), step: diff(a, a2, bg) };
          if (opts.pics && view !== 'behind') pics.push({ name: `${kind} ${view} ${Math.round(d)}`, a, b });
          await breathe();
        }
      }
      g.scene.remove(real);
    }
  } finally {
    g.scene.remove(ground);
    for (const [o, v] of vis) o.visible = v;
  }
  out.done = true;
  return out;
}
