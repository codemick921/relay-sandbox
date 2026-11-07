import test from 'node:test';
import assert from 'node:assert/strict';
import {x402Enabled} from '../hosted/x402-switch.mjs';

test('agent payments are on with an explicit yes, or with a live wallet', () => {
  assert.equal(x402Enabled({EUPOVA_X402_ENABLED: 'true'}), true);
  assert.equal(x402Enabled({EUPOVA_WALLET_MODE: 'live'}), true, 'a live wallet is the deployment this feature belongs to');
});

test('anything else is off, including near-misses', () => {
  for (const env of [{}, {EUPOVA_X402_ENABLED: 'True'}, {EUPOVA_X402_ENABLED: 'yes'}, {EUPOVA_WALLET_MODE: 'test'}, {EUPOVA_WALLET_MODE: 'simulated'}, {EUPOVA_X402_ENABLED: '1'}]) {
    assert.equal(x402Enabled(env), false, JSON.stringify(env));
  }
});
