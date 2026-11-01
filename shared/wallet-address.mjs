import {getAddress} from 'viem';
// Offline input checks only. An EVM address does not identify a network or prove ownership.
export function walletAddressCheck(value){
 const fail=(code,message)=>({valid:false,code,message});
 if(typeof value!=='string'||!value)return fail('empty','Paste your receiving address to check its format.');
 if(!/^0x[0-9a-fA-F]{40}$/.test(value))return fail('format','Use a full 0x address with 40 letters and numbers after 0x. Copy it from your wallet; do not enter a private key or recovery phrase.');
 const lower=value.toLowerCase();
 if(lower==='0x'+'0'.repeat(40)||lower==='0x'+'0'.repeat(36)+'dead')return fail('unusable','This is a zero or burn address. Copy your own receiving address from your wallet.');
 if(lower==='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')return fail('token','This is the USDC token contract on Base, not your receiving wallet. Copy your wallet’s receive address.');
 const body=value.slice(2),mixed=/[a-f]/.test(body)&&/[A-F]/.test(body);
 if(mixed&&getAddress(lower)!==value)return fail('checksum','The address checksum does not match. Copy the full address again from your wallet.');
 return {valid:true,code:'format-checked',message:'Address format checked'};
}
