// WebGL against WebGPU: the same scene, drawn by both, timed to the end of the GPU's work.
//
// "Please can you switch over to WebGPU because I suppose that is just upsides, right?" Measured before
// switching. A WebGPURenderer (vendor/three.webgpu.min.js, the same three.js r185 and the same core file
// as the game) is made beside the game's own renderer, given the same size, shadows and tone mapping, and
// the scene the game has built is drawn by each in turn: a WebGL frame ends with a one-pixel readPixels
// (which waits for the GPU), a WebGPU frame with queue.onSubmittedWorkDone(). Turns alternate which goes
// first, so warming up and the laptop's clocks do not favour one.
//
//   const m = await import('/tests/webgpu.js');  await m.compare(6, 25)
//
//   gl, gpu   ms per frame, each turn; meanGL, meanGPU; calls/tris, what the scene is
//   shots     window.__shotGL / __shotGPU, a JPEG of each, to compare by eye
export async function compare(turns = 6, frames = 25) {
  const g = window.__game;
  const was = g.paused;
  g.paused = true;
  const W = await import('/vendor/three.webgpu.min.js');
  const R0 = g.renderer;
  const w = R0.domElement.width, h = R0.domElement.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const R1 = new W.WebGPURenderer({ canvas: c, antialias: true });
  await R1.init();
  R1.setPixelRatio(1);
  R1.setSize(w, h, false);
  R1.shadowMap.enabled = R0.shadowMap.enabled;
  R1.shadowMap.type = R0.shadowMap.type;
  R1.toneMapping = R0.toneMapping;
  R1.toneMappingExposure = R0.toneMappingExposure;
  await R1.renderAsync(g.scene, g.camera);
  const gl = R0.getContext(), dev = R1.backend.device;
  const px = new Uint8Array(4);
  const tGL = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { R0.render(g.scene, g.camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return (performance.now() - t0) / n;
  };
  const tGPU = async (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { R1.render(g.scene, g.camera); await dev.queue.onSubmittedWorkDone(); }
    return (performance.now() - t0) / n;
  };
  tGL(5);
  await tGPU(5);
  const r = { map: g.mapDef.id, size: [w, h], webgpu: !!R1.backend.isWebGPUBackend, gl: [], gpu: [] };
  for (let k = 0; k < turns; k++) {
    if (k % 2) { r.gl.push(+tGL(frames).toFixed(1)); r.gpu.push(+(await tGPU(frames)).toFixed(1)); } else { r.gpu.push(+(await tGPU(frames)).toFixed(1)); r.gl.push(+tGL(frames).toFixed(1)); }
  }
  const mean = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  r.meanGL = mean(r.gl);
  r.meanGPU = mean(r.gpu);
  r.calls = R0.info.render.calls;
  r.tris = R0.info.render.triangles;
  R1.render(g.scene, g.camera);
  await dev.queue.onSubmittedWorkDone();
  window.__shotGPU = c.toDataURL('image/jpeg', 0.8);
  R0.render(g.scene, g.camera);
  window.__shotGL = R0.domElement.toDataURL('image/jpeg', 0.8);
  R1.dispose();
  g.paused = was;
  return r;
}
