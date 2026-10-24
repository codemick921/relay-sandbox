import {pence,InputError} from './validation.mjs';
// Preserve Wise's prototype range. Only the restricted Revolut route permits
// sub-£2 offers, in exact pennies, with a £10 source cap.
export function fundingPence(value,rail){
 if(rail!=='revolut')return pence(value);
 if(typeof value!=='string'||!/^\d{1,2}(\.\d{1,2})?$/.test(value))throw new InputError('Enter an exact GBP amount for the test.');
 const [whole,fraction='']=value.split('.'),n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(n<1||n>1000)throw new InputError('The private Revolut test must be between £0.01 and £10.');
 return n;
}
