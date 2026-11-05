# Arc funding: customer-controlled Base-to-Arc transfers (simulated)

> The everyday wallet screen (create, balance, add money, send, approvals, connected tools) is described in `customer-wallet.md`. This page covers the Base-to-Arc bridge and recovery tools it links to.


Status: test-data simulation, local preview only. Branch `codex/arc-agentic-wallets`. Nothing here is
deployed, enabled in production, or connected to a provider. Last revised 5 Nov 2026.

## Decision: the customer approves transfers in their wallet

Decided by Mickel on 5 Nov 2026: **"The customer approves transfers in their wallet."**

* The custody model is **customer-controlled**. Eupova holds no keys, never signs, and has no authority
  to move funds. There is no Eupova-controlled or custodial transfer path in the code: the server has
  no wallet-creation adapter and no bridge adapter (the earlier gated developer-controlled adapters were
  removed, and a test fails if such code returns).
* Every transfer needs an explicit approval or rejection by the customer **before the burn**.
* This replaces the earlier open question about which wallet type to use. Nothing in this document is
  still waiting on a custody decision. What remains is configuration and review (see "Activation").

## Source signing is separate from destination receiving

This corrects an earlier version of this document, which said Eupova could not bridge to a pasted Arc
address because it could not sign for that address. That mixed up two different roles.

| Role | What it is | Who acts | Needs a signature? |
| --- | --- | --- | --- |
| Source | The customer's wallet on Base that holds the USDC and burns it | The customer, in their own wallet | Yes, from the customer |
| Destination | The Arc address that receives the minted USDC | Nobody | No |

A CCTP transfer burns USDC on the source chain with the source wallet's signature. The mint on Arc
goes to a `recipientAddress` that is only a parameter. With Circle's Forwarding Service
(`useForwarder: true`), Circle submits the mint, so no destination wallet, signature or polling loop is
needed. A user-authorised Base source signer can therefore burn to a **different** recipient address on
Arc: the customer's own address on Arc, or any other address they choose. Eupova cannot and need not
sign for the recipient. (Source: Circle bridge skill, `forwarding-events-recovery.md`, "Without a
destination adapter"; and https://developers.circle.com/cctp/concepts/forwarding-service.md.)

What this build does with that:

* A quote names a **source** (one of the customer's wallets, on Base Sepolia) and a **destination** (the
  same address on Arc, or a saved external test destination on Arc Testnet).
* An external destination is saved with **format-only validation**, an **explicit confirmation of the
  network** (Arc Testnet, chain id 5042002, not mainnet), and **owner-scoped persistence**. It is always
  labelled `TEST destination`. Eupova does not claim it is supported on Arc, can receive, or who controls it.
* Funds sent to the wrong address cannot be recovered. That is why the approval screen shows the full
  destination address and why the customer confirms the network when saving it.

## Approval, and what it is bound to

When the USDC reaches the customer's wallet on Base, the customer is asked to approve the burn. The
approval is bound (SHA-256) to everything that matters:

* source account and chain (wallet id, address, `Base Sepolia`, signer `customer-wallet`);
* destination (mode, id, revision, label, address, chain, chain id, delivery by Forwarding Service);
* amount to burn and token (USDC);
* quote (id, speed, bridge fees, estimated Arc output).

The fingerprint is shown to the customer, re-computed from the **stored rows** when they decide, and
again before the (simulated) burn. If anything differs, the approval is cancelled and nothing burns.

| State | Meaning | Customer can |
| --- | --- | --- |
| Waiting for your approval (`approval_pending`) | Nothing burned. The exact binding is on screen | Approve, Decline, or keep USDC on Base |
| Approved | Recorded; the burn follows | (the simulated burn runs) |
| Declined (`approval_denied`) | Kept in history. Nothing burned; USDC stays on Base | Ask again, or keep USDC on Base |
| Cancelled because details changed (`approval_invalidated`) | An edit or mismatch cancelled it. Nothing burned | Review the updated details and ask again, or keep USDC on Base |

**Edits invalidate approvals.** Editing a saved destination (name or address) bumps its revision and
cancels every approval for it that has not burned yet, whether pending or already approved. An edit
needs the revision the customer saw and the network confirmation again. A transfer whose burn is already
confirmed keeps the recipient it was approved for. Approve and Decline carry the fingerprint the customer
saw; a stale one is refused. Repeating the same decision is a harmless no-op.

## Failures before the burn and after the burn

CCTP burns USDC on the source chain and mints it on the destination. A failure means very different
things on each side of the burn, so they are separate states with separate wording and controls.

| | Before the burn: `burn_failed` | After the burn: `burned_resume_required` |
| --- | --- | --- |
| Burn record | None | Exists, permanent, shown on screen |
| USDC | Still in the customer's Base wallet, spendable | Burned on Base, in transit to Arc, **not spendable on Base** |
| Keep it on Base | Allowed (`Keep USDC on Base`) | **Not possible**: refused by the server |
| Cancel, ask for a new approval | Not applicable | Refused |
| Way forward | Try the burn again under the existing approval | **Resume only**: continue from the attestation using the burn record; never burn again |
| Approval | Still open (not spent) | Spent by the burn |

The simulated burn record (`reference`, amount, source, recipient, time) is created in the same step that
confirms the burn. The database enforces it: a transfer past the burn must have a record, a transfer
before the burn or kept on Base must not, and a record cannot be changed or removed once written.
Rows from the earlier single `bridge_failed` status are split by their stored failure code on upgrade;
post-burn rows get a marked legacy record so they can never be treated as unburned.

## Same address on Arc: what it does and does not show

"Same address as my wallet" only reuses the customer's address as the recipient. The customer's wallet is
one key; an EVM address derived from it is the same on every EVM chain. That does **not** prove that
anything is set up or usable on Arc, and Eupova checks nothing on Arc. The screen says so. A provider
that creates separate wallets per chain would need to be treated differently: every requested chain
must be returned with its own identity and provider id, and matching addresses alone prove nothing about
whether each wallet exists. The earlier custodial wallet adapter that did this has been removed, and a
test fails if any wallet-provisioning code is added to the Arc modules.

## What was built

Everything is persistent in PostgreSQL and scoped to the signed-in owner.

1. **Customer-controlled wallets** (simulated): create, setup pending, setup failed, retry. A synthetic
   `0x51ed...` address that exists on no network. No key exists anywhere.
2. **Test destinations**: save, edit, remove (blocked while a transfer in progress uses it), history.
3. **Quotes** with matching pay and receive figures for Base USDC and the estimated Arc output, itemised
   bridge fees (illustrative), and separate settled output.
4. **Approval** (above) and the **Base-to-Arc state machine**: payment recorded, Base receipt, approval
   request, approval, burn, attestation, forwarded mint, settled. Pending-attestation variant, declined
   payment, failure before the burn (`burn_failed`: retry under the existing approval, or keep on Base), failure
   after the burn (`burned_resume_required`: burn record kept, resume only; the USDC cannot return to Base). Every step is in a history that survives restarts.
5. **Address-format check**: format only; always states network support and ownership were not checked.

## Customer-controlled wallet and browser signing (complete, gated, not wired)

`src/arc-customer-signing.mjs` is the finished integration code. Nothing in the app imports it, it imports
no SDK itself (the wallet, the adapter factory and Bridge Kit are injected), it reads no configuration, and
its gate is closed. It reuses Eupova's existing Privy architecture rather than replacing authentication:

* **Wallet**: the customer's Privy embedded Ethereum wallet. It is user-controlled (the wallet setup
  adapter already requires `userCanSign`, not delegated, not imported). Creation stays behind the
  existing one-attempt guard (`docs/privy-wallet-setup-adapter.md`); this build does not create one.
* **Signing**: `useWallets()` provides the wallet; `wallet.switchChain(84532)` and
  `await wallet.getEthereumProvider()` give an EIP-1193 provider (installed `@privy-io/react-auth` 3.51.0
  type definitions).
* **Bridge**: Circle Bridge Kit 1.17.0 with the Viem adapter 1.20.0 (both now pinned exactly in
  `package.json`): `createAdapterFromProvider({ provider })`, then
  `kit.bridge({ from: { adapter, chain: "Base_Sepolia" }, to: { chain: "Arc_Testnet", recipientAddress, useForwarder: true }, amount, config })`.
* **Speed**: the approved speed is mapped explicitly, `fast` to `FAST` and `standard` to `SLOW`, and passed as
  `config.transferSpeed`. Any other value fails closed instead of falling back to the SDK default (`FAST`).
* **Fee cap and minimum output**: the approved bridge fee goes to the SDK as `config.maxFee`. Bridge Kit has no
  minimum-output setting, so `execute()` first asks the SDK for a live fee quote **without** the cap (the SDK
  uses a supplied `maxFee` as the provider fee, so an estimate that carried the cap would only echo it back),
  and refuses before any wallet prompt if any fee cannot be read exactly, a fee has an error, an unapproved
  application fee appears, the total is above the approved cap, or the amount received would fall below the
  approved minimum. Base gas is paid in ETH by the customer's wallet and is outside this USDC cap. No custom
  fee is ever set and batching is off, so the customer sees the approve and the burn as separate steps.
* **Retry**: `retry(approval, result)` refuses, before the wallet or the SDK is touched, any result that is not
  the approved transfer: another source account or chain, destination chain, recipient, delivery method,
  amount, token, speed, a higher or missing fee cap, a custom fee, or a transfer that already completed.
  Only the source adapter is passed to `kit.retry`; the SDK types make `RetryContext.to` optional for
  forwarder-only destinations.
* **Order of events**: verify the approval fingerprint, check the connected wallet is the approved source,
  estimate and check the fee, then switch chain, then bridge. `execute()` runs only from the customer's own
  Approve click, and a used approval cannot start a second bridge.

`preview-setup/signing-typecheck/run.sh` compiles the seam against the pinned, installed packages, and
`tests/arc-signing-sdk.test.mjs` exercises the real Bridge Kit and adapter with a stub provider that refuses to
sign or send. Neither uses a key, a wallet, a network or a transaction.

### Provider configuration and permissions that are still missing (nothing was created or requested)

1. **Privy**: an app configured for embedded Ethereum wallets, with `supportedChains` including Base
   Sepolia (use `arcSigningPrivyConfig`), the exact allowed origin, and wallet creation approved under the
   existing guard. A Privy app ID and the read-only credential for the observer are not set here.
2. **Lockfile**: the two Circle packages are pinned in `package.json`, but `package-lock.json` has not been
   regenerated (the sandbox forbids npm). Run `npm install` once in `relay-sandbox/` before `npm ci` or a deploy.
   Bridge operations need no Circle API key or kit key.
3. **Gas**: the customer's wallet pays gas on Base Sepolia in ETH. Destination gas is covered by the
   Forwarding fee. A gas sponsor is not built.
4. **Server-side verification**: after the browser reports transaction hashes, the server must confirm the
   burn and mint on chain before showing "settled". That needs an RPC configuration and is not built.
5. **Network pairing**: Peer checkout delivers USDC on Base **mainnet**. This route is Base Sepolia to Arc
   Testnet. The mainnet pair is listed and disabled; enabling it needs the mainnet warning, an independent
   audit and its own approval.

Still unverified against a live network: the real fee numbers (the SDK cannot quote offline, so the guards were
tested with stand-in quotes and by confirming the real SDK fails closed without a network), the Privy
`walletClientType` value for embedded wallets, and a funded end-to-end burn and mint on Base Sepolia and Arc
Testnet. Fee amounts shown to users in the simulation are illustrative.

## Implemented, simulated, blocked

| Area | State |
| --- | --- |
| Tables, quotes, destinations, approvals, state machine, history, recovery, isolation, idempotency, limits | Implemented and tested |
| Wallet creation, the customer's approval signature, Base receipt, burn, attestation, mint, all fee amounts | Simulated |
| Customer-wallet signing with Privy and Bridge Kit | Prepared, gated, tested with fakes, not wired |
| Real wallet creation, signatures, permissions, bridging | Blocked: needs dependencies, Privy configuration and review |
| Base mainnet to Arc mainnet | Blocked: not built; mainnet warning and audit required |
| Arc transfers in statements and the existing funding history | Not included on purpose, to keep simulated records apart from real paid-request tracking |

## Production safety

* The hosted server imports no Arc module. The feature is injected by the local preview runner only.
* `createHostedServer` throws if an Arc feature is passed without `localPreview`; without injection the
  `/api/arc/*` routes return 404 and `/api/state` has no `arcFunding` key.
* No environment variable, config key or secret is read by any Arc module (a test enforces it).
* Database checks pin `provider='simulated'`, `simulated=true`, `custody='customer'` and
  `kind='external_test'` with `test_label=true`.
* The Base funding flow, currencies, payment methods, account isolation and paid-request tracking are untouched.

## Route verification (5 Nov 2026)

Arc is **not** testnet-only. Both networks exist for both chains, so nothing in this build assumes otherwise.
The route was checked against current documentation and the installed SDK rather than memory:

| Source | What it says |
| --- | --- |
| https://docs.arc.io/app-kit/quickstarts/bridge-tokens-across-blockchains (the old bridge docs redirect here) | App Kit plus the standalone `@circle-fin/bridge-kit`; browser-wallet adapter for client-side signing. |
| https://docs.arc.io/app-kit/references/supported-blockchains | Arc and Base both support Bridge; chain identifiers such as `Arc_Testnet`; `getSupportedChains` with environment filtering. |
| https://developers.circle.com/wallets/supported-blockchains | Circle Wallets chain codes `ARC` / `ARC-TESTNET` and `BASE` / `BASE-SEPOLIA`, user-controlled EOA supported on both. |
| Installed Bridge Kit 1.17.0 `getSupportedChains()` | Base 8453, Base_Sepolia 84532 (CCTP domain 6); Arc 5042, Arc_Testnet 5042002 (domain 26); CCTP v2 on all four; forwarder supported as a destination on all four. |

The installed SDK's `bridge()` throws `NetworkMismatchError` when source and destination are different network types.
The app enforces the same rule earlier: `assertRoute` in `shared/arc-funding.mjs` refuses any testnet and mainnet
mix, refuses an unknown chain, and refuses the mainnet route while it is disabled. Only the pair
**Base Sepolia to Arc Testnet** (kit ids `Base_Sepolia` and `Arc_Testnet`) is enabled in this build. The mainnet pair
(`Base` to `Arc`) is listed and disabled until the customer-wallet signing integration is configured and independently
reviewed. `tests/arc-integrity.test.mjs` checks these ids, flags and domains against the installed SDK whenever it
is present, and fails if the route table drifts.

Peer checkout delivers USDC on Base **mainnet**, so a real Peer payment can only ever feed the mainnet route. It can
never feed the testnet route, and testnet USDC is never presented as a Peer receipt.

## Documentation used (checked 5 Nov 2026)

* CCTP fees: https://developers.circle.com/cctp/concepts/fees.md (Standard free; Fast 0 to 13 bps, deducted at mint).
* Forwarding Service: https://developers.circle.com/cctp/concepts/forwarding-service.md (protocol fee plus a Forwarding fee).
* Supported chains and domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md (Base domain 6, Arc domain 26).
* Bridge Kit browser-wallet and forwarding patterns: Circle bridge skill references `adapter-wagmi.md` and
  `forwarding-events-recovery.md`; public docs https://docs.arc.io/app-kit/bridge and https://developers.circle.com/cctp.
* Arc: Arc Testnet chain id 5042002; ERC-20 USDC `0x3600000000000000000000000000000000000000` (6 decimals); mainnet chain id 5042.
* Privy: the installed `@privy-io/react-auth` 3.51.0 type definitions.
* Current Arc and Circle pages and the installed SDK for the exact route: see "Route verification" above.

## Activation checklist (not done)

1. Configure the Privy app (embedded Ethereum wallets, `supportedChains`, origin) and approve wallet
   creation under the existing guard.
2. Review the pinned Bridge Kit and Viem adapter dependencies, regenerate `package-lock.json`, and run `kit.estimate` on testnet.
3. Build server-side confirmation of burn and mint, and reconciliation, before anything is called settled.
4. Open `customerSigningGate` in code after review, wire the Approve button to `execute()`, and test
   with a funded Base Sepolia wallet.
5. Only then consider mainnet, with the mainnet warning and an independent audit.

## Try it

See `preview-setup/CHANGELOG.md` in the Arc project for the exact browser steps.
