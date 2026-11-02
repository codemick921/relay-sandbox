import {spawnSync} from 'node:child_process';
const value=process.env.WALLET_GUARD_TEST_DATABASE_URL;
if(!value){console.error('A new dedicated loopback PostgreSQL test cluster is required; refusing to silently skip.');process.exit(1);}
const url=new URL(value);
if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username!=='guardtest'||url.pathname!=='/postgres'||url.search){console.error('Refusing non-isolated test target.');process.exit(1);}
const r=spawnSync(process.execPath,['--import','./tests/fixtures/offline-guard.mjs','--test','tests/wallet-setup-claims-postgres.test.mjs'],{stdio:'inherit',env:process.env});process.exit(r.status??1);
