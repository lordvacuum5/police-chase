// Does the game know an Apple device when it sees one, and does the joke work?
//
// The game plays harder on Apple hardware -- double damage, and the wanted
// level climbing three times as fast -- and says nothing about it except over
// the radio. Nothing about that is subtle enough to get wrong quietly: a
// detector that fires on the wrong machines punishes people it was not aiming
// at, and one that never fires means the joke silently does not exist.
//
// The trap is that "Apple" appears in the user agent of every Chrome and every
// Safari on every platform, Windows and Android included -- AppleWebKit. A
// test matching on the word would catch the entire web. So the first half of
// this is a table of real user agent strings with what each one should say.
//
// The second half checks the two things the flag actually does, by doing them
// rather than by reading the code: a hit at a fixed speed with damageScale 2
// should cost twice what the same hit costs at 1, and the radio should be able
// to speak the lines.
window.__runApple = async function () {
  try {
    for (let i = 0; i < 200 && !(window.__game && window.__game.player); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const { isApple, appleMobile, APPLE } = await import('/src/core/platform.js');
    const rows = [];
    let bad = 0;

    // [ user agent, touch points, is it Apple, is it an Apple phone or tablet ]
    const CASES = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 5, true, true],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 5, true, true],
      // An iPad on iPadOS 13 and later, which says it is a Mac. The touch
      // points are the only thing that gives it away.
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15', 5, true, true],
      // A real Mac: Apple, but not a phone, so it gets the joke and not the
      // home-screen advice.
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36', 0, true, false],
      // Everything below must come back false. Note that all of them contain
      // the word Apple.
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36', 0, false, false],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 5, false, false],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36', 0, false, false],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        0, false, false],
    ];

    for (const [ua, touches, wantApple, wantMobile] of CASES) {
      const got = isApple(ua, touches);
      const gotMobile = appleMobile(ua, touches);
      const ok = got === wantApple && gotMobile === wantMobile;
      if (!ok) bad++;
      // Enough of the string to tell the cases apart.
      const name = (ua.match(/\((.*?)[;)]/) || [, ua])[1].slice(0, 26);
      rows.push(`${ok ? '  ok ' : 'FAIL '}${name.padEnd(28)}`
        + `apple ${String(got).padEnd(6)}mobile ${gotMobile}`);
    }

    // ---- what the flag does: damage ----
    const g = window.__game;
    g.onBusted = () => { g.outcome = null; };
    g.onEscaped = () => { g.outcome = null; };
    g.paused = true;
    const hit = (scale) => {
      const v = g.createVehicle('runner', 'runner',
        { x: g.player.position.x, y: 1.0, z: g.player.position.z + 70 }, 0, {});
      v.damageScale = scale;
      v.takeImpact(20);                     // the same shunt either way
      const d = v.damage;
      g.removeVehicle(v);
      return d;
    };
    const one = hit(1), two = hit(2);
    const ratio = one > 0 ? two / one : 0;
    const damageOk = Math.abs(ratio - 2) < 0.02;
    if (!damageOk) bad++;
    rows.push(`${damageOk ? '  ok ' : 'FAIL '}${'damage doubles'.padEnd(28)}`
      + `${(one * 100).toFixed(1)}% -> ${(two * 100).toFixed(1)}%  (x${ratio.toFixed(2)})`);

    // ---- and that the radio can say the lines ----
    const before = g.hud.messages.length;
    const said = g.say('apple-test', ['Control, test of the Apple line.'], {}, false);
    const spoke = g.hud.messages.length > before || said !== null;
    if (!spoke) bad++;
    rows.push(`${spoke ? '  ok ' : 'FAIL '}${'radio speaks a line'.padEnd(28)}`
      + `${g.hud.messages.length - before} added`);

    g.paused = false;
    window.__res = `this machine: APPLE ${APPLE}\n${rows.join('\n')}\n`
      + (bad ? `${bad} FAILED` : 'all good');
  } catch (e) {
    window.__res = 'EX: ' + e.message + ' | ' + (e.stack || '').slice(0, 300);
  }
};
