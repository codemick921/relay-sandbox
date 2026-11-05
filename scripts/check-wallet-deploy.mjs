// Read-only production credential check before replacing the running release.
import {runReadiness, formatReadiness} from '../hosted/wallet-readiness.mjs';
if (process.env.EUPOVA_WALLET_MODE === 'live') {
  const report = await runReadiness({env: process.env, online: true});
  console.log(formatReadiness(report));
  if (!report.ready || !report.online?.ok) process.exitCode = 1;
} else console.log('Live wallet not requested; wallet credential check skipped.');
