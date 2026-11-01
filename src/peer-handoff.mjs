// The server verifies ownership, current status and the stored provider link first.
// Keep the automatic browser handoff on the known HTTPS Peer checkout origin.
export function peerHandoffUrl(result,requestId){
 let url;try{url=new URL(result?.checkoutUrl);}catch{throw Error('The Peer checkout link could not be checked. Your request is saved; try opening it again.');}
 if(result?.id!==requestId||typeof result.checkoutUrl!=='string'||result.checkoutUrl.length>4096||url.origin!=='https://pay.peer.xyz'||url.pathname!=='/'||url.username||url.password||url.hash||!url.searchParams.get('order')||!url.searchParams.get('token')||!url.searchParams.get('method'))throw Error('The Peer checkout link could not be checked. Your request is saved; try opening it again.');
 return url.href;
}
