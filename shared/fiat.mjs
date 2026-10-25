import catalog from './funding-catalog.json' with {type:'json'};
export const fundingCatalog=catalog;
export const checkoutRails=catalog.methods.filter(m=>m.checkoutSupported).map(m=>m.id);
export const currencyCode=value=>value===undefined?'GBP':value;
export const knownCurrency=value=>catalog.currencies.some(c=>c.code===value);
export const methodLabel=id=>catalog.methods.find(m=>m.id===id)?.label??id;
export const supportsFunding=(rail,currency)=>catalog.methods.some(m=>m.id===rail&&m.checkoutSupported&&m.currencies.includes(currency));
// Existing `pence` fields are integer hundredths of the explicitly saved currency.
// Legacy records without currency are GBP. No FX conversion or implicit rounding.
export const fiatDecimal=n=>{if(!Number.isSafeInteger(n)||n<0)return null;return (n/100).toFixed(2);};
export const formatFiat=(n,currency='GBP')=>knownCurrency(currency)&&fiatDecimal(n)!==null?new Intl.NumberFormat('en-GB',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(n/100):'Not available';
export const minimumMinor=(rail,currency='GBP')=>currency==='GBP'&&rail==='wise'?200:1;
