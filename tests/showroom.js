// A line-up of cars out past the edge of the map, for looking at bodywork.
//
//   __showroom([['patrol', {police: true}], ['interceptor', {police: true}]], view)
//
// view: 'front3q' | 'rear3q' | 'side' | 'top'. The game is paused so the chase
// camera leaves the view alone; call __showroomClear() to put everything back.
window.__showroom = function (cars, view = 'front3q', spacing = 6.5, heat = 1) {
  const g = window.__game, THREE = window.__modules.THREE;
  window.__showroomClear();
  g.paused = true;
  g.heat.value = heat;
  const X = 1080, Z = 300;
  const made = [];
  cars.forEach(([kind, opts], i) => {
    const x = X + (i - (cars.length - 1) / 2) * spacing;
    const livery = (opts && opts.livery) || kind;
    const v = g.createVehicle(kind, livery, { x, y: 0.9, z: Z }, 0, Object.assign({}, opts));
    v.setVelocity({ x: 0, y: 0, z: 0 });
    v.lampPhase = i * 0.37;
    made.push(v);
  });
  // Let them settle on their springs.
  const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
  g.sim.surfaceAt = () => 1; g.sim.heightAt = () => 0;
  for (let i = 0; i < 90; i++) {
    for (const v of made) v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: 1 });
    g.world.timestep = 1 / 120;
    for (const v of g.vehicles) v.prepare(1 / 120);
    g.world.step();
    for (const v of g.vehicles) v.postStep(1 / 120);
  }
  g.sim.surfaceAt = realSurface; g.sim.heightAt = realHeight;
  window.__showroomCars = made;

  const span = spacing * cars.length;
  const cam = g.camera;
  const d = Math.max(9, span * 0.75);
  if (view === 'front3q') cam.position.set(X + d * 0.55, 2.6, Z + d * 0.9);
  else if (view === 'rear3q') cam.position.set(X - d * 0.55, 2.8, Z - d * 0.9);
  else if (view === 'side') cam.position.set(X + d * 1.25, 1.4, Z + 0.3);
  else if (view === 'front') cam.position.set(X, 1.5, Z + d * 1.2);
  else cam.position.set(X + 0.1, d * 1.6, Z + 0.1);
  cam.fov = view === 'side' ? 40 : 45;
  cam.updateProjectionMatrix();
  cam.lookAt(X, 0.7, Z);
  // The sun's shadow box follows the player; bring the player along.
  g.player.teleport({ x: X, y: 0.9, z: Z - 40 }, 0);
  g._render(0);
  return made.length;
};

window.__showroomClear = function () {
  const g = window.__game;
  for (const v of window.__showroomCars || []) g.removeVehicle(v);
  window.__showroomCars = [];
};
