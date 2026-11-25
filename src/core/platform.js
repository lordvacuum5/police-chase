// What the game is being played on: whether a page can be put full screen, or has to be told about the home screen instead.
//
// Not reliable and cannot be: iPads have claimed to be Macs since iPadOS 13, which is what the touch-point test is for. Nothing
// here is load-bearing: it picks the wording of a hint. (There was an "Apple mode" that played harder on one of their devices:
// "remove Apple mode. I don't like it anymore. I'll just remove it completely.")

const LIVE_UA = (typeof navigator === 'undefined' ? '' : navigator.userAgent) || '';
const LIVE_TOUCHES = (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints) || 0;

/** An iPhone or iPad, including an iPad pretending to be a Mac. */
export function appleMobile(ua = LIVE_UA, touches = LIVE_TOUCHES) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touches > 1);
}
