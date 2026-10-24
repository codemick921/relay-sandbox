// Operator-only, read-only queue. Run in Render Shell; no customer HTTP endpoint.
import {createPool,createStore} from '../hosted/db.mjs';
import {createFundingDrafts} from '../hosted/funding-drafts.mjs';
const pool=createPool();
try { console.log(JSON.stringify({requests:await createFundingDrafts(createStore(pool)).cancellationQueue()},null,2)); }
finally { await pool.end(); }
