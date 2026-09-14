// Photographs of the roads from fixed places, for comparing versions.
//
// Every view is a camera position and a point to look at, in map coordinates,
// so the same shots can be taken of any version of the game -- or of the same
// version before and after a change -- and laid side by side. Saved through
// the dev server's /__shot endpoint into shots/<prefix>_<map>_<view>.jpg.
const ROAD_VIEWS = {
  wexbury: [
    { name: 'start', eye: [3.7, 3.2, -235.9], at: [-28.7, 0.5, -246.3] },
    { name: 'market', eye: [114.9, 40, 18], at: [89.9, 0, -7] },
    { name: 'sackville', eye: [-240.5, 40, 11.7], at: [-265.5, 0, -13.3] },
    { name: 'a361', eye: [60.3, 40, 653.9], at: [35.3, 0, 628.9] },
    { name: 'a361eye', eye: [9.7, 3, 652.8], at: [35.3, 0.3, 628.9] },
    { name: 'beech', eye: [-117.6, 40, 583.4], at: [-142.6, 0, 558.4] },
    { name: 'meadow', eye: [127.3, 40, 679], at: [102.3, 0, 654] },
    { name: 'high', eye: [0, 260, 200], at: [0, 0, 330] },
  ],
  city: [
    { name: 'kingsway', eye: [-590, 45, 30], at: [-620, 0, 0] },
    { name: 'halloway', eye: [-290, 45, -50], at: [-320, 0, -80] },
    { name: 'marlow', eye: [270, 45, -370], at: [240, 0, -400] },
    { name: 'marloweye', eye: [240, 3, -435], at: [240, 0.3, -400] },
    { name: 'high', eye: [-300, 300, 300], at: [-300, 0, 0] },
  ],
};

window.__roadShots = async function (prefix = 'now', W = 1280, H = 720) {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, r = g.renderer, cam = g.camera;
    const map = g.mapDef.id;
    const views = ROAD_VIEWS[map] || [];
    r.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
    g._render(1 / 60);
    const saved = [];
    for (const v of views) {
      cam.position.set(...v.eye);
      cam.lookAt(...v.at);
      cam.updateMatrixWorld(true);
      r.setRenderTarget(null);
      r.render(g.scene, cam);
      const data = r.domElement.toDataURL('image/jpeg', 0.9);
      const name = `${prefix}_${map}_${v.name}`;
      await fetch('/__shot?name=' + name, { method: 'POST', body: data });
      saved.push(name);
    }
    window.__res = saved.join(' ');
  } catch (e) {
    window.__res = 'EX: ' + e.message;
  }
};
