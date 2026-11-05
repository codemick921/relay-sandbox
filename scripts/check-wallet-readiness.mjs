#!/usr/bin/env node
// Usage: node scripts/check-wallet-readiness.mjs [--online]
// Read-only. Reads the wallet settings from the environment of THIS process (run it where the service's settings are loaded,
// for example in a Render shell), prints names and status only, and exits 0 only when the live wallet is ready.
import {runReadiness, formatReadiness} from '../hosted/wallet-readiness.mjs';
const online = process.argv.includes('--online');
const report = await runReadiness({env: process.env, online});
console.log(formatReadiness(report));
process.exit(report.ready && (!online || report.online?.ok) ? 0 : 1);
