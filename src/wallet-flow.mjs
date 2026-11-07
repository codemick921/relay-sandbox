// The browser-side sequences around Circle's hosted PIN step. Pure of React and of the SDK: `act` (a call to Eupova's wallet
// routes) and `runChallenge` (the Circle step) are passed in, so the same sequences run in the page and in tests.
//
//   create:   save the wallet (server) -> PIN step -> read back and open it (server)
//   approve:  approve the exact request (server saves the reservation FIRST) -> PIN step -> ask the network (server)
//   resume:   the same steps again for a wallet or payment left half way
//
// Nothing here marks anything paid or ready: only the server does that, after it has checked Circle's own record.
const STEP_PROBLEM = 'The wallet step was not completed, so nothing has been sent. You can continue where you left off.';

import {challengeSignature} from './circle-challenge.mjs';
export function createWalletFlow({act, runChallenge, newId = () => globalThis.crypto.randomUUID(), onProblem = () => {}}) {
  // Returns the completed challenge rather than a bare boolean: a signing challenge carries a signature the server
  // still has to verify, and throwing the result away would leave the payment stuck between approved and paid.
  const step = async challenge => {
    try { return {ok: true, result: await runChallenge(challenge)}; }
    catch (e) { onProblem(typeof e?.message === 'string' && e.message ? `${STEP_PROBLEM} (${e.message})` : STEP_PROBLEM); return {ok: false}; }
  };
  const finishSetup = async () => ({ok: !!(await act('wallet/finish-setup', {}))});
  return {
    async create(label) {
      onProblem('');
      const s = await act('wallet/create', {label, requestId: newId()});
      if (!s) return {ok: false, step: 'create'};
      if (s.walletChallenge && !(await step(s.walletChallenge)).ok) return {ok: false, step: 'challenge', resumable: true};
      return finishSetup();
    },
    async resumeSetup() {
      onProblem('');
      const s = await act('wallet/resume-setup', {});
      if (!s) return {ok: false, step: 'resume'};
      if (s.walletChallenge && !(await step(s.walletChallenge)).ok) return {ok: false, step: 'challenge', resumable: true};
      return finishSetup();
    },
    checkSetup: finishSetup,
    async decide(payment, decision) {
      onProblem('');
      const s = await act('wallet/payments/decide', {id: payment.id, decision, bindingHash: payment.fingerprint});
      if (!s) return {ok: false, step: 'decide'};
      if (decision !== 'approve') return {ok: true};
      if (s.walletChallenge) {
        const ran = await step(s.walletChallenge);
        if (!ran.ok) { await act('wallet/payments/refresh', {id: payment.id}); return {ok: false, step: 'challenge', resumable: true}; }
        // A signing challenge answers with a signature. It goes to the server, which checks it against the exact
        // authorization it prepared before anything is marked paid.
        const signature = challengeSignature(ran.result);
        if (signature) return {ok: !!(await act('wallet/x402/complete', {id: payment.id, signature}))};
      }
      return {ok: !!(await act('wallet/payments/refresh', {id: payment.id}))};
    },
    async resumePayment(payment) {
      onProblem('');
      const s = await act('wallet/payments/resume', {id: payment.id});
      if (!s) return {ok: false, step: 'resume'};
      if (s.walletChallenge) {
        const ran = await step(s.walletChallenge);
        if (!ran.ok) { await act('wallet/payments/refresh', {id: payment.id}); return {ok: false, step: 'challenge', resumable: true}; }
        // A signing challenge answers with a signature. It goes to the server, which checks it against the exact
        // authorization it prepared before anything is marked paid.
        const signature = challengeSignature(ran.result);
        if (signature) return {ok: !!(await act('wallet/x402/complete', {id: payment.id, signature}))};
      }
      return {ok: !!(await act('wallet/payments/refresh', {id: payment.id}))};
    },
    async check(payment) { return {ok: !!(await act('wallet/payments/refresh', {id: payment.id}))}; },
  };
}
