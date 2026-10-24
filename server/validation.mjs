export const TOKEN='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export class InputError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function pence(value){if(typeof value!=='string'||!/^\d{1,4}(\.\d{1,2})?$/.test(value))throw new InputError('Enter a pound amount with up to two decimal places.');const [a,b='']=value.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(n<200||n>100000)throw new InputError('Choose between £2 and £1,000 for this prototype.');return n;}
export function address(value){if(typeof value!=='string'||!/^0x[\da-f]{40}$/i.test(value)||/^0x0{40}$/i.test(value))throw new InputError('Enter a non-zero EVM wallet address.');return value;}
