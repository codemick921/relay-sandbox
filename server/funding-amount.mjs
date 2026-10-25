import {InputError} from './validation.mjs';
import {supportsFunding,minimumMinor} from '../shared/fiat.mjs';
export function fundingPence(value,rail,currency='GBP'){
 if(!supportsFunding(rail,currency))throw new InputError('This payment method and currency are not connected to Eupova checkout.');
 if(typeof value!=='string'||!/^\d{1,4}(\.\d{1,2})?$/.test(value))throw new InputError('Enter an exact amount with up to two decimal places.');
 const [whole,fraction='']=value.split('.'),n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(n<minimumMinor(rail,currency)||n>100000)throw new InputError(`Enter between ${(minimumMinor(rail,currency)/100).toFixed(2)} and 1,000 ${currency}.`);
 return n;
}
