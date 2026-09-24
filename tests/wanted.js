// How long does each wanted level take to earn?
//
// "It goes to level one, level two, and then suddenly it jumps up to five --
// there isn't much time between three and four." The climb is pure book-
// keeping, so this drives it directly rather than through a chase: hold the
// player in sight and count the seconds across each tier boundary.
//
// Two ways of driving, because the rate follows what you are doing:
//
//   steady   in sight, under 137 km/h, both hands on the wheel
//   hard     over 137 km/h and drifting, which is the fastest it can be earned
//
// The arrest check inside heat.update wants a dispatcher with units, so it
// gets one with none: nothing is close enough to pin the car.
window.__runWanted = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.heat); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const g = window.__game;
    const heat = g.heat;
    const seen = { knowledge: { seen: true }, units: [] };

    const run = (fast, drifting) => {
      const player = {
        forwardSpeed: fast ? 42 : 18,
        isDrifting: drifting,
        position: { x: 0, y: 0, z: 0 },
        spec: { dims: { l: 4.6 } },
      };
      heat.value = 1;
      heat.bustTimer = 0;
      const at = {};
      let t = 0;
      const step = 1 / 30;
      while (t < 3600 && heat.value < 5) {
        heat.update(step, player, seen);
        t += step;
        for (const tier of [2, 3, 4, 5]) {
          if (at[tier] === undefined && heat.value >= tier) at[tier] = t;
        }
      }
      return {
        '1-2': +(at[2] || 0).toFixed(1),
        '2-3': +((at[3] - at[2]) || 0).toFixed(1),
        '3-4': +((at[4] - at[3]) || 0).toFixed(1),
        '4-5': +((at[5] - at[4]) || 0).toFixed(1),
        total: +(at[5] || 0).toFixed(1),
      };
    };

    const rows = { steady: run(false, false), hard: run(true, true) };
    heat.value = 0;
    heat.bustTimer = 0;
    window.__res = JSON.stringify(rows, null, 1);
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
