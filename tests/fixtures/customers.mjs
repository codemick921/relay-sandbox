// A customer row for an owner id ("customer:<uuid>"), so live code that checks the account (not disabled, setup finished, email verified) can run.
export async function addCustomer(f, owner, {verified = true, disabled = false, setupPending = false} = {}) {
  const id = owner.slice(9);
  await f.store.query(`INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash,disabled,setup_pending,email_verified_at) VALUES($1,$2,'Test',$3,$3,$4,$5,${verified ? 'now()' : 'NULL'}) ON CONFLICT (id) DO UPDATE SET disabled=$4, setup_pending=$5, email_verified_at=${verified ? 'now()' : 'NULL'}`,
    [id, `c-${id}@example.test`, 'x'.repeat(8), disabled, setupPending]);
}
