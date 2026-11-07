// Whether agent payments are offered at all.
//
// Two ways on, and one of them already exists: an explicit EUPOVA_X402_ENABLED=true, or a live customer wallet, which
// this deployment only runs when it is genuinely configured for real money. There is no third way: a simulated wallet,
// a preview build or a half-configured deployment never reaches this.
//
// The switch is the least interesting control here. Even switched on, a tool needs an enrolment the owner approved, an
// allowance the owner set, and the owner's approval and PIN for every single payment.
export function x402Enabled(env = process.env) {
  if (env.EUPOVA_X402_ENABLED === 'true') return true;
  return env.EUPOVA_WALLET_MODE === 'live';
}
