import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress, checkTarget, fetchPaidResource} from '../hosted/x402-fetch.mjs';
import {BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64');
const resolver = async () => [{address: '93.184.216.34', family: 4}];
const goodAccepts = {
  scheme: 'exact', network: BASE_MAINNET, amount: '10000', asset: BASE_USDC,
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 60,
  extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'},
};
const paidResponse = () => new Response('', {status: 402, headers: {'PAYMENT-REQUIRED': b64({x402Version: 2, resource: {url: 'https://api.example.com/x'}, accepts: [goodAccepts]})}});
const fakeFetch = response => { const calls = []; const f = async (url, init) => { calls.push({url, init}); return response(); }; f.calls = calls; return f; };

test('private, loopback, link-local and metadata addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false, 'an IPv4 loopback hidden in IPv6 is still loopback');
});

test('only https, on the standard port, without credentials in the address', () => {
  assert.equal(checkTarget('https://api.example.com/x').ok, true);
  assert.equal(checkTarget('http://api.example.com/x').ok, false);
  assert.equal(checkTarget('https://user:pw@api.example.com/x').ok, false);
  assert.equal(checkTarget('https://api.example.com:8443/x').ok, false);
  assert.equal(checkTarget('https://localhost/x').ok, false);
  assert.equal(checkTarget('https://box.internal/x').ok, false);
  assert.equal(checkTarget('not a url').ok, false);
});

test('a host that resolves to a private address is refused before any request is made', async () => {
  const f = fakeFetch(paidResponse);
  const out = await fetchPaidResource({url: 'https://evil.example/x', fetchImpl: f, resolver: async () => [{address: '127.0.0.1', family: 4}]});
  assert.equal(out.ok, false);
  assert.match(out.reason, /public address/);
  assert.equal(f.calls.length, 0, 'nothing was requested');
});

test('a 402 is read and the requirement returned, with redirects refused and a bounded wait', async () => {
  const f = fakeFetch(paidResponse);
  const out = await fetchPaidResource({url: 'https://api.example.com/x', fetchImpl: f, resolver});
  assert.equal(out.ok, true);
  assert.equal(out.status, 402);
  assert.equal(out.requirement.amountRaw, '10000');
  assert.equal(out.host, 'api.example.com');
  assert.equal(f.calls[0].init.redirect, 'error', 'a redirect must not be followed');
  assert.ok(f.calls[0].init.signal, 'the request has a timeout');
});

test('a free 200 comes back as the resource, and nothing is charged', async () => {
  const f = fakeFetch(() => new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}}));
  const out = await fetchPaidResource({url: 'https://api.example.com/free', fetchImpl: f, resolver});
  assert.equal(out.ok, true);
  assert.equal(out.free, true);
  assert.equal(out.body, '{"ok":true}');
});

test('a 402 asking for something we cannot pay is refused with the reasons, not passed on', async () => {
  const wrong = {...goodAccepts, network: 'eip155:84532'};
  const f = fakeFetch(() => new Response('', {status: 402, headers: {'PAYMENT-REQUIRED': b64({x402Version: 2, resource: {url: 'https://api.example.com/x'}, accepts: [wrong]})}}));
  const out = await fetchPaidResource({url: 'https://api.example.com/x', fetchImpl: f, resolver});
  assert.equal(out.ok, false);
  assert.match(out.reason, /Base mainnet/);
});

test('a 402 for a different host than the allowance covers is refused', async () => {
  const f = fakeFetch(() => new Response('', {status: 402, headers: {'PAYMENT-REQUIRED': b64({x402Version: 2, resource: {url: 'https://other.example/x'}, accepts: [goodAccepts]})}}));
  const out = await fetchPaidResource({url: 'https://api.example.com/x', fetchImpl: f, resolver, allowedHost: 'api.example.com'});
  assert.equal(out.ok, false);
  assert.match(out.reason, /not the host/);
});

test('an error status is reported plainly, and a slow service is not waited on forever', async () => {
  const f = fakeFetch(() => new Response('nope', {status: 500}));
  const out = await fetchPaidResource({url: 'https://api.example.com/x', fetchImpl: f, resolver});
  assert.equal(out.ok, false);
  assert.match(out.reason, /500/);
  const timeout = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const slow = await fetchPaidResource({url: 'https://api.example.com/x', fetchImpl: timeout, resolver});
  assert.match(slow.reason, /in time/);
});

test('a GET cannot carry a body, and odd verbs are refused', async () => {
  const f = fakeFetch(paidResponse);
  assert.equal((await fetchPaidResource({url: 'https://api.example.com/x', body: {a: 1}, fetchImpl: f, resolver})).ok, false);
  assert.equal((await fetchPaidResource({url: 'https://api.example.com/x', method: 'DELETE', fetchImpl: f, resolver})).ok, false);
  const post = await fetchPaidResource({url: 'https://api.example.com/x', method: 'POST', body: {q: 1}, fetchImpl: f, resolver});
  assert.equal(post.ok, true);
  assert.equal(f.calls.at(-1).init.method, 'POST');
  assert.equal(f.calls.at(-1).init.body, '{"q":1}');
});
