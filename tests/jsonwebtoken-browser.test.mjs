import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decode, verify, sign} from '../src/vendor/jsonwebtoken-browser.mjs';

// A JWT shaped like the one a social login provider returns. Signature is not verified by decode, which is the point.
const payload = {sub: 'abc123', aud: 'eupova-app-id', iss: 'https://accounts.google.com', exp: 1900000000};
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const token = `${b64({alg: 'RS256', typ: 'JWT'})}.${b64(payload)}.c2lnbmF0dXJl`;

test('the browser stand-in decodes a token payload but refuses to sign or verify', () => {
  assert.deepEqual(decode(token), payload);
  assert.equal(decode(''), null);
  assert.equal(decode('not-a-token'), null);
  assert.equal(decode('a.b'), null, 'a malformed payload is not trusted');
  assert.throws(() => verify(token), /server-side/);
  assert.throws(() => sign(payload), /server-side/);
});

test('the client build points jsonwebtoken at the stand-in, so Circle\'s SDK chunk can load in a browser', () => {
  const config = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(config, /alias:\s*\{\s*jsonwebtoken:/, 'jsonwebtoken is aliased for the browser build');
  assert.match(config, /jsonwebtoken-browser\.mjs/);
  const shim = readFileSync(new URL('../src/vendor/jsonwebtoken-browser.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(shim, /from 'node:|require\(/, 'the stand-in itself pulls in nothing');
});
