import {pence,InputError} from './validation.mjs';
// Exact-pence input validation. Legacy test policies enforce their own £10 cap.
export function fundingPence(value,rail){
 if(rail!=='revolut')return pence(value);
 if(typeof value!=='string'||!/^\d{1,4}(\.\d{1,2})?$/.test(value))throw new InputError('Enter an exact GBP amount.');
 const [whole,fraction='']=value.split('.'),n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(n<1||n>100000)throw new InputError('Enter between £0.01 and £1,000 for Revolut.');
 return n;
}
