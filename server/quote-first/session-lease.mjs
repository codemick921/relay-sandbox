// Normal idle renewal cannot extend an approved development lease.
export const sessionWithinLease=(session,enrollment)=>({...session,expiresAt:Math.min(session.expiresAt,enrollment.expiresAt)});
