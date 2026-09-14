// What does hitting a bollard at speed actually do?
//
// "I can do 200 miles an hour and they'll just stop me dead." A bollard is
// meant to be knocked over for a shove and a little damage. This takes one real
// bollard off its kerb, stands it out past the edge of the map on flat forced
// tarmac, and drives the player's car straight into it at a range of speeds,
// throttle holding the speed, through the game's own update.
//
//   before    speed a few metres short of it
//   after     slowest speed in the half second after reaching it
//   damage    damage taken, in percent
//   knocked   whether it went over or stayed standing
window.__runBollard = async function (speeds = [50, 100, 150, 200, 250], kind = 'bollard', frame = 1 / 60, offset = 0) {
  try {
    for (let i = 0; i < 300 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game, p = g.player, props = g.props;
    if (g.audio) g.audio.muted = true;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.heat.value = 0;
    const realSurface = g.sim.surfaceAt, realHeight = g.sim.heightAt;
    g.sim.surfaceAt = () => 1;
    g.sim.heightAt = () => 0;

    // Move one bollard to the test spot, out past the map edge.
    const prop = props.props.find((x) => x.kind === kind && !x.down && x.collider);
    const X = 1100, Z = 400;
    const oldKey = props._key(prop.x, prop.z);
    props.grid.set(oldKey, props.grid.get(oldKey).filter((x) => x !== prop));
    g.world.removeRigidBody(prop.collider);
    prop.x = X; prop.z = Z; prop.base = 0;
    const key = props._key(X, Z);
    if (!props.grid.has(key)) props.grid.set(key, []);
    props.grid.get(key).push(prop);
    prop.down = true;          // so reset() rebuilds its collider where it now is
    props.reset();

    const rows = [];
    for (const kph of speeds) {
      props.reset();
      p.repair();
      const v0 = kph / 3.6;
      // Far enough back to settle at speed before it arrives.
      const back = Math.max(60, v0 * 1.6);
      p.teleport({ x: X + offset, y: 0.9, z: Z - back }, 0);
      p.setVelocity({ x: 0, y: 0, z: v0 });
      let before = null, after = Infinity, t = 0, reached = null, lift = 0;
      const dmg0 = p.damage;
      while (t < 6) {
        const err = v0 - p.forwardSpeed;
        g.stepHeadless(frame, { throttle: err > 0 ? 1 : 0, brake: 0, steer: 0, handbrake: 0 }, frame);
        t += frame;
        const ahead = Z - p.position.z;
        if (before === null && ahead < 8) before = p.speed * 3.6;
        if (reached === null && ahead < 0) reached = t;
        if (reached !== null) {
          after = Math.min(after, p.speed * 3.6);
          lift = Math.max(lift, p.position.y);
          if (t - reached > 0.5) break;
        }
      }
      rows.push(`${String(kph).padStart(3)} km/h  before ${before === null ? '  -' : before.toFixed(0).padStart(3)}`
        + `  after ${after === Infinity ? '  - (never reached it)' : after.toFixed(0).padStart(3)}`
        + `  lost ${before === null || after === Infinity ? '-' : (before - after).toFixed(0)} km/h`
        + `  damage ${((p.damage - dmg0) * 100).toFixed(1)}%  knocked ${prop.down}`
        + `  impactDv ${(p.lastImpact || 0).toFixed(1)}`);
    }

    g.sim.surfaceAt = realSurface;
    g.sim.heightAt = realHeight;
    props.reset();
    window.__res = rows.join('\n');
  } catch (e) {
    window.__res = 'EX ' + e.message + '\n' + String(e.stack).slice(0, 500);
  }
};
