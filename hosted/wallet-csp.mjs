// Content security policy for the page that hosts the customer wallet.
//
// Circle's browser SDK (@circle-fin/w3s-pw-web-sdk 1.1.11) loads one hosted step in an iframe from `https://pw-auth.circle.com`
// (its `serviceUrl`) and talks to it with postMessage. The page itself makes no request to Circle in PIN mode, so the only
// addition is that one exact origin in `frame-src`. tests/wallet-csp.test.mjs reads the installed SDK and fails if its
// origin ever differs from this list. No wildcard, no other directive, no other scheme.
// Pages that carry their own policy (the Privy pages) set it themselves and are unaffected.
export const CIRCLE_WEB_SDK_FRAME_ORIGINS = Object.freeze(['https://pw-auth.circle.com']);

export const BASE_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(value)) throw new Error('A policy origin must be an exact https origin: no wildcard, path or other scheme.');
  return value;
}

export function contentSecurityPolicy({walletFrames = []} = {}) {
  if (walletFrames.length === 0) return BASE_POLICY;
  return BASE_POLICY.replace("frame-src 'self'", "frame-src 'self' " + walletFrames.map(exactHttpsOrigin).join(' '));
}
