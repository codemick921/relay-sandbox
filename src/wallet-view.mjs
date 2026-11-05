// Pure display helpers for the customer wallet. No money maths happens here: amounts arrive as exact decimal
// strings from the server and are only trimmed for display.
export const trimUsdc = text => {
  if (typeof text !== 'string' || !/^\d+\.\d{6}$/.test(text)) return text ?? '';
  const [whole, frac] = text.split('.');
  const cut = frac.replace(/0+$/, '');
  return `${whole}.${cut.length < 2 ? cut.padEnd(2, '0') : cut}`;
};
export const shortAddress = a => (typeof a === 'string' && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? '');
export const whenText = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
};
export const newRequestId = () => (globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12));
export const HOUR_CHOICES = [[1, '1 hour'], [24, '24 hours'], [168, '7 days'], [720, '30 days']];
export const activityTone = row => (row.direction === 'in' ? 'in' : row.status && !['posted'].includes(row.status) ? 'wait' : 'out');

// Which funding request "Add money" opens. A NEW request always targets this wallet's own saved-wallet record. An already
// open request (one that may belong to any saved wallet) is offered separately and labelled, never substituted.
export function fundingTarget(entry, savedWalletId) {
  if (!entry?.kind || entry.disabled) return null;
  if (entry.existing) return {mode: 'existing', kind: entry.kind, id: entry.id};
  if (typeof savedWalletId !== 'string' || savedWalletId.length === 0) return {mode: 'unlinked'};
  return {mode: 'new', kind: entry.kind, id: savedWalletId};
}
