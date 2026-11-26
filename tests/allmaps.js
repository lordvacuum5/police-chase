// Does the map that is loaded (or today's daily) come up and run? Before every push, on all three and the daily.
//   const m = await import('/tests/allmaps.js');  m.goTo('wexbury')  ('city', 'haldon', 'daily'), then once loaded  await m.allOk()   // window.__ok
// Ten seconds at no stars, ten at two, ten at five: anything thrown, anything below the ground, and what is about.
export async function goTo(what) {
  const D = await import('/src/game/daily.js');
  if (what === 'daily') { D.setDaily(D.dayKey()); sessionStorage.setItem('pc.map', D.dailyPlan(D.dayKey()).mapId); } else { sessionStorage.removeItem('pc.daily'); sessionStorage.setItem('pc.map', what); }
  location.reload();
}

export async function allOk() {
  window.__ok = null;
  const g = window.__game;
  if (!g) { window.__ok = document.body.innerText.slice(0, 300); return; }
  g.paused = true;
  const rows = [];
  try {
    for (const star of [0, 2, 5]) {
      if (star && !g.daily) g.heat.value = star + 0.05;
      for (let i = 0; i < 40; i++) {
        g.stepHeadless(0.25, { throttle: 0.5, brake: 0, steer: Math.sin(i * 0.4) * 0.15, handbrake: 0 });
        if (i % 4 === 0) { g._render(0.016); await new Promise((r) => setTimeout(r)); }
      }
      rows.push([star, g.traffic.cars.length, g.dispatcher.units.length, g.outcome]);
      g.outcome = null;
    }
  } catch (e) { window.__ok = e.stack; return; }
  window.__ok = { map: g.mapDef.id, daily: g.daily && `${g.daily.type} ${g.daily.state}`, errors: g.updateErrors || 0, error: g.updateError || null, rows };
}
