import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {pkgDir, pkgFile} from './fixtures/pkg.mjs';

const run = promisify(execFile), root = new URL('../', import.meta.url).pathname;

// The calls the REAL adapter makes (recorded by driving every adapter method) are compiled against the SDK's own input types.
test('every call the Circle adapter makes type-checks against the installed SDK (a wrong field name or shape fails here)', { timeout: 120_000 }, async () => {
  assert.ok(pkgDir('typescript'), 'typescript is a dev dependency of this repository; install it (npm ci)');
  assert.ok(pkgDir('@circle-fin/user-controlled-wallets'), 'the Circle SDK must be installed');
  const rec = await run(process.execPath, ['typecheck/circle/callsites.mjs'], {cwd: root});
  assert.match(rec.stdout, /adapter calls recorded \((\d+) SDK methods\)/);
  assert.ok(Number(/\((\d+) SDK methods\)/.exec(rec.stdout)[1]) >= 10, 'every SDK method the adapter uses is exercised');
  await run(process.execPath, [pkgFile('typescript', 'bin/tsc'), '-p', 'typecheck/circle/tsconfig.json'], {cwd: root});   // throws (non-zero exit) on any type error
  const gen = readFileSync(new URL('../typecheck/circle/callsites.generated.ts', import.meta.url), 'utf8');
  for (const m of ['createUser', 'createUserToken', 'createUserPinWithWallets', 'listWallets', 'getWalletTokenBalance', 'estimateTransferFee', 'createTransaction', 'listTransactions', 'createUserTransactionContractExecutionChallenge', 'estimateContractExecutionFee'])
    assert.match(gen, new RegExp(`satisfies P<'${m}'>`), m);
});
