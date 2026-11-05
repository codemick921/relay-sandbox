// Compile-time check that the calls made by relay-sandbox/hosted/wallet-providers.mjs match the installed
// @circle-fin/user-controlled-wallets 10.8.1 types, and that the browser SDK has the challenge methods.
import {initiateUserControlledWalletsClient} from '@circle-fin/user-controlled-wallets';
import {W3SSdk} from '@circle-fin/w3s-pw-web-sdk';

const client = initiateUserControlledWalletsClient({apiKey: 'TEST_API_KEY:stubbed-not-a-credential'});
type P<K extends keyof typeof client> = Parameters<(typeof client)[K]>[0];

export const calls = {
  createUser: {userId: 'u'} satisfies P<'createUser'>,
  createUserToken: {userId: 'u'} satisfies P<'createUserToken'>,
  createUserPinWithWallets: {userToken: 't', blockchains: ['BASE'], accountType: 'SCA', idempotencyKey: '11111111-1111-4111-8111-111111111111'} satisfies P<'createUserPinWithWallets'>,
  listWallets: {userToken: 't', blockchain: 'BASE-SEPOLIA'} satisfies P<'listWallets'>,
  getWalletTokenBalance: {userToken: 't', walletId: 'w'} satisfies P<'getWalletTokenBalance'>,
  // Payment by exact token id, with explicit gas limits (the approved ceiling) and a reference.
  createTransaction: {
    userToken: 't', walletId: 'w', destinationAddress: '0x' + 'a'.repeat(40), amounts: ['1.000000'], tokenId: 'token-id',
    fee: {type: 'absolute', config: {gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1'}}, refId: 'r', idempotencyKey: '22222222-2222-4222-8222-222222222222',
  } satisfies P<'createTransaction'>,
  estimateTransferFee: {userToken: 't', walletId: 'w', tokenId: 'token-id', destinationAddress: '0x' + 'a'.repeat(40), amount: ['1.000000']} satisfies P<'estimateTransferFee'>,
  listTransactions: {userToken: 't', walletIds: ['w'], blockchain: 'BASE', destinationAddress: '0x' + 'a'.repeat(40), pageSize: 50} satisfies P<'listTransactions'>,
  // The two contract-execution calls the Base to Arc move makes (note source.walletId on the estimate, not a top-level walletId).
  estimateContractExecutionFee: {userToken: 't', source: {walletId: 'w'}, contractAddress: '0x' + 'b'.repeat(40), abiFunctionSignature: 'approve(address,uint256)', abiParameters: ['0x' + 'c'.repeat(40), '1']} satisfies P<'estimateContractExecutionFee'>,
  createUserTransactionContractExecutionChallenge: {
    userToken: 't', walletId: 'w', contractAddress: '0x' + 'b'.repeat(40), abiFunctionSignature: 'approve(address,uint256)', abiParameters: ['0x' + 'c'.repeat(40), '1'],
    fee: {type: 'level', config: {feeLevel: 'MEDIUM'}}, refId: 'b:approve', idempotencyKey: '33333333-3333-4333-8333-333333333333',
  } satisfies P<'createUserTransactionContractExecutionChallenge'>,
};

const web = new W3SSdk({appSettings: {appId: 'app'}});
export const device: Promise<string> = web.getDeviceId();
web.setAuthentication({userToken: 't', encryptionKey: 'k'});
web.execute('challenge-id', () => {});
