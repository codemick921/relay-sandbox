import {spawnSync} from 'node:child_process';
const value=process.env.TEST_DATABASE_URL;
if(!value){console.error('TEST_DATABASE_URL is required: PostgreSQL concurrency tests must not silently skip.');process.exit(1);}
const url=new URL(value);
if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.search){console.error('Use a dedicated local PostgreSQL test database on 127.0.0.1 without query options.');process.exit(1);}
const result=spawnSync(process.execPath,['--import','./tests/fixtures/offline-guard.mjs','--test','tests/hosted.test.mjs','tests/hosted-live.test.mjs','tests/accounts.test.mjs','tests/account-mail.test.mjs','tests/funding-journey.test.mjs','tests/wallet-balances.test.mjs','tests/payment-resume.test.mjs','tests/account-security.test.mjs','tests/payment-records.test.mjs','tests/payment-health.test.mjs','tests/funding-history.test.mjs'],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
