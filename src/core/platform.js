// What the game is being played on.
//
// Two different questions live here, and they want different answers, which is
// why they are two exports rather than one:
//
//   appleMobile   an iPhone or an iPad, which cannot put a page full screen
//                 and has to be told about the home screen instead
//   APPLE         anything with an Apple badge on it, phone, tablet or Mac
//
// Neither is reliable and neither can be. iPads have claimed to be Macs since
// iPadOS 13, which is what the touch-point test is for; any user agent can be
// changed by whoever is holding the device; and a Mac running something that
// says otherwise will be missed. Nothing here is load-bearing enough to care
// -- one picks the wording of a hint, the other picks a joke.
//
// The trap worth knowing about: every Chrome and every Safari on every
// platform has the word "AppleWebKit" in its user agent, Windows included, so
// anything matching on "Apple" catches the whole web. The tests are on the
// device words only, and tests/apple.js keeps a table of real user agents to
// make sure it stays that way.
//
// Both take their inputs as arguments so they can be tested against strings
// other than this machine's.

const LIVE_UA = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '';
const LIVE_TOUCHES = (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints) || 0;

/** An iPhone or iPad, including an iPad pretending to be a Mac. */
export function appleMobile(ua = LIVE_UA, touches = LIVE_TOUCHES) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touches > 1);
}

/** Anything with an Apple badge on it. */
export function isApple(ua = LIVE_UA, touches = LIVE_TOUCHES) {
  return appleMobile(ua, touches) || /Macintosh|Mac OS X/.test(ua);
}

export const APPLE = isApple();
