// Browser stand-in for `jsonwebtoken`.
//
// Circle's user-controlled-wallet browser SDK (`@circle-fin/w3s-pw-web-sdk`) `require`s `jsonwebtoken`, a Node-only
// package, and Vite bundles it. Loading that package in a browser throws before a single Circle call is made:
// `Object.create(undefined)` inside the `inherits` shim, surfaced to the customer as
// "Object prototype may only be an Object or null: undefined". Every PIN step failed for that reason.
//
// The SDK uses the package in exactly one place: `checkSocialLoginNonce`, which decodes the `id_token` returned by a
// social login provider. Eupova does not offer Google, Apple or Facebook sign-in, so that path never runs. This module
// implements the `decode` call faithfully enough for it, and refuses to sign or verify, because a browser must never
// hold a signing secret or treat an unverified token as trusted.
const SEGMENT = /^[A-Za-z0-9_-]+$/;

function base64UrlToText(segment) {
  if (!SEGMENT.test(segment)) throw new Error('Malformed token segment.');
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((segment.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Returns the payload of a well-formed JWT, or null. Never verifies a signature: callers must not treat the result as trusted.
export function decode(token) {
  if (typeof token !== 'string' || token === '') return null;
  const parts = token.split('.');
  if (parts.length !== 2 && parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlToText(parts[1]));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function verify() {
  throw new Error('Token verification is a server-side operation and is not available in the browser.');
}

export function sign() {
  throw new Error('Token signing is a server-side operation and is not available in the browser.');
}

export default {decode, verify, sign};
