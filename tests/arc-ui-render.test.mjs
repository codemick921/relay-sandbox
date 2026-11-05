import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fixture} from './fixtures/account-store.mjs';
import {createArcFunding} from '../hosted/arc-funding.mjs';
import {seedArcFixtures} from '../hosted/arc-fixtures.mjs';

// Server-renders the real React page against real (fixture) state, so a broken component, a
// missing field or a wording regression fails here rather than in the browser.
test('Arc page renders every state with the required wording and no unsupported claims', async () => {
  const vite = await createServer({root: new URL('..', import.meta.url).pathname, configFile: false, logLevel: 'silent', server: {middlewareMode: true, hmr: false, watch: null}, appType: 'custom', optimizeDeps: {noDiscovery: true, include: []}});
  const f = await fixture();
  try {
    const arc = createArcFunding({store: f.store});
    await arc.migrate();
    const owner = 'customer:' + randomUUID();
    await seedArcFixtures(arc, owner, {tag: 'Test'});
    const state = {arcFunding: await arc.state(owner)};
    const {default: ArcWallets, ArcFigures} = await vite.ssrLoadModule('/src/ArcWallets.jsx');
    const html = renderToStaticMarkup(React.createElement(ArcWallets, {state, act: async () => null, busy: false, error: ''}));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /Test-data simulation/);
    assert.match(text, /Customer-controlled wallet/);
    assert.match(text, /Simulated address \(exists on no network\)/);
    for (const label of ['Settled on Arc', 'Burned on Base: resume to finish on Arc', 'Burn did not happen: USDC still on Base', 'Payment failed. No money moved', 'Waiting for the simulated payment', 'Setup failed (simulated)', 'Setting up (simulated)']) assert.match(text, new RegExp(label.replace(/[()]/g, '\\$&')), label);
    // Pay and receive figures: estimate and settled output are distinct rows.
    const settled = state.arcFunding.transfers.find(t => t.status === 'settled' && t.quote.pence === 2500);
    const figures = renderToStaticMarkup(React.createElement(ArcFigures, {quote: settled.quote, transfer: settled})).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(figures, /You pay \(simulated\)\s+£25\.00/);
    assert.match(figures, /USDC received on Base \(verified in simulation\)\s+30\.625/);
    assert.match(figures, /Arc USDC, estimated before settlement/);
    assert.match(figures, /Arc USDC, settled \(simulation\)/);
    assert.ok(figures.includes(Number(settled.settled.arcOutputUsdc).toLocaleString('en-GB', {minimumFractionDigits: 3, maximumFractionDigits: 6})));
    const pending = state.arcFunding.transfers.find(t => t.status === 'awaiting_payment');
    const unsettled = renderToStaticMarkup(React.createElement(ArcFigures, {quote: pending.quote, transfer: pending})).replace(/<[^>]+>/g, ' ');
    assert.match(unsettled, /Not settled yet/);
    // Recovery controls follow the real state: keep-on-Base only before the burn.
    // Keep-on-Base only where nothing was burned: waiting, declined, cancelled approval, and the pre-burn failure.
    assert.equal((html.match(/Keep USDC on Base/g) ?? []).length, 4);
    // Pre-burn and post-burn failures are different states with different wording and controls.
    assert.equal((html.match(/Try the burn again \(uses your approval\)/g) ?? []).length, 1);
    assert.equal((html.match(/Resume attestation and mint \(no new burn\)/g) ?? []).length, 1);
    assert.match(text, /Failure before the burn\. No burn record exists, so nothing left your Base wallet/);
    assert.match(text, /Failure after the burn\. The burn on Base is confirmed and cannot be undone/);
    assert.match(text, /Burn record \(simulated, permanent\)/);
    assert.match(text, /A confirmed burn cannot be undone\. Resuming continues from the attestation for this record; it never burns again/);
    const cards = html.split('<article').slice(1);
    const post = cards.find(c => c.includes('Burned on Base: resume to finish on Arc'));
    const pre = cards.find(c => c.includes('Burn did not happen: USDC still on Base'));
    assert.ok(post && pre, 'both failure cards are present');
    const postText = post.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(postText, /Keep USDC on Base|still on Base|still in your wallet|is safe|Cancel/, 'a burned transfer never claims spendable Base funds or offers to keep them');
    assert.match(postText, /Spendable on Base\s+No: already burned/);
    assert.match(postText, /not spendable on Base and cannot be kept there/);
    const preText = pre.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(preText, /Spendable on Base\s+Yes: nothing burned/);
    assert.match(preText, /Keep USDC on Base/);
    assert.doesNotMatch(preText, /Burn record \(simulated/, 'no burn record before the burn');
    // Customer approval and rejection, preserved pending / denied / cancelled states, and the binding shown to the customer.
    for (const label of ['Waiting for your approval', 'You declined. Nothing was burned', 'Approval cancelled: details changed']) assert.match(text, new RegExp(label), label);
    assert.equal((html.match(/Approve in my wallet \(simulated\)/g) ?? []).length, 1, 'one transfer is waiting for a decision');
    assert.equal((html.match(/>Decline</g) ?? []).length, 1);
    assert.match(text, /Ask for approval again/);
    assert.match(text, /Review updated details and ask again/);
    for (const label of ['What you are approving', 'Source account', 'Amount to burn', 'Approval fingerprint', 'Any change to the above cancels this approval']) assert.match(text + html, new RegExp(label), label);
    assert.match(text, /You approve every transfer in your own wallet/);
    assert.match(text, /Eupova holds no keys and has no authority to sign or move funds/);
    // Source signs, destination only receives; external destinations are always labelled TEST, format-only, network confirmed by the customer.
    assert.match(text, /Where the USDC lands on Arc/);
    assert.match(text, /TEST destination/);
    assert.match(text, /Network confirmed by you: Arc Testnet/);
    assert.match(text, /Network support, ability to receive, ownership: not checked/);
    assert.match(text, /I confirm this address is on Arc Testnet \(chain id 5042002\), a test network/);
    assert.match(text, /It needs no signature, so it can be your wallet\S{1,8}s own address on Arc or any address you save here/);
    assert.match(text, /Same address as my wallet, on Arc/);
    assert.doesNotMatch(text, /cannot bridge to an address it does not control|cannot be funded in this build|custody (is )?(still )?undecided|developer-controlled/i);
    assert.match(text, /only checks its format/);
    assert.doesNotMatch(text, /paypal/i);
    assert.doesNotMatch(text, /(is|are) (a )?(supported|verified|owned by you)/i);
    assert.match(text, /Mainnet USDC cannot be bridged to Arc Testnet/);
    // Disabled when the server does not provide the feature.
    const off = renderToStaticMarkup(React.createElement(ArcWallets, {state: {}, act: async () => null, busy: false, error: ''}));
    assert.match(off, /not available in this environment/);
  } finally {
    await f.close();
    await vite.close();
  }
});
