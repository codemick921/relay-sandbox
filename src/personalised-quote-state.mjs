// Client scope guard: the server remains responsible for wallet/session verification.
export function matchesAddressContext(response,expected,now){
 const c=response?.addressContext;
 return Boolean(expected&&response.addressBinding==='server_resolved'&&response.eligibility==='not_verified'&&c?.status==='addresses_ready'&&
  c.contextId===expected.contextId&&c.buyer?.address===expected.buyer?.address&&c.recipient?.id===expected.recipient?.id&&c.recipient?.address===expected.recipient?.address&&
  c.buyer.chainId===8453&&c.recipient.chainId===8453&&c.recipient.token===expected.recipient.token&&Number.isFinite(now)&&c.validUntil>now&&c.canCreatePayment===false&&response.canCreatePayment===false);
}
