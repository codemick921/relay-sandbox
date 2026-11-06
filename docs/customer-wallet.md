# Customer wallet (Circle user-controlled, Base)

The customer wallet is the everyday wallet inside Eupova. After signing in, a customer can **Create my wallet** (no external
wallet, app or browser extension), see a wallet card with name, balance, network and address, **Add money** with Pay on
Eupova into that same wallet, **Receive**, **Send**, read their activity and decide **Pending approvals**. The earlier
Arc bridge and recovery screens are kept (see "Arc"). The original Eupova screens, navigation and styles are unchanged; the
wallet adds one navigation item ("My wallet") and its own `.cw-*` styles.

## Who controls the wallet

The customer. Eupova holds no key and cannot move money on its own. Two things can ask the wallet to pay:

* **The customer** (Send): approves the exact request.
* **A connected tool** (for example the command-line client) needs both controls, every time: an **allowance** the customer
  chose (amount and expiry, default none, confirmed with an explicit statement) **and** the customer's **individual approval**
  of that one payment. An allowance without approval pays nothing; an approval without an allowance is refused.

In a live wallet the approval is two steps by design: the customer approves the exact request in Eupova (a fingerprint
over wallet, network, token, recipient, amount, fee ceiling, tool and allowance revision), then approves the transaction
in Circle's hosted PIN step. Eupova cannot do the second step for them.

## Live and simulated are separate

| | Simulated (local preview) | Live (production) |
| --- | --- | --- |
| Where it exists | `hosted/tracking-preview.mjs` only; refused anywhere else | `hosted/server.mjs` production entry only |
| Provider | none (fake address `0x51ed…`, test money) | Circle user-controlled wallets |
| Test money / `add-money` route | yes | **not mounted** |
| Balance | ledger | the provider's USDC balance for the exact token |
| A payment counts as paid | simulated receipt | only when the network record matches the approval field by field |

A live wallet never falls back to the simulation. If the settings are incomplete the wallet is **not offered** (customers see
"not available right now" when it was requested but misconfigured, nothing when it was never requested).

## Settings (all required for a live wallet; nothing is read from code)

`EUPOVA_WALLET_MODE` must be exactly `live`. Each field is checked on its own, and the log names the setting and the reason, never the value.

| Setting | Rule |
| --- | --- |
| `EUPOVA_WALLET_NETWORK` | exactly `base` (Base mainnet, real money) or `base_sepolia` (test network) |
| `EUPOVA_CIRCLE_UCW_API_KEY` | `TEST_API_KEY:…:…` for Sepolia, `LIVE_API_KEY:…:…` for mainnet; the other environment is refused |
| `EUPOVA_CIRCLE_UCW_APP_ID` | the User-Controlled Wallets application id (a UUID) |
| `EUPOVA_CIRCLE_UCW_USER_ID_SECRET` | random, at least 32 characters; derives each customer's opaque Circle user id |
| `EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE` | exactly `EOA` or `SCA` (Circle advises EOA on Ethereum mainnet and SCA on L2s such as Base) |
| `EUPOVA_CIRCLE_UCW_GAS_MODEL` | `wallet` (default: the wallet pays network fees in ETH) or `sponsored` (needs `SCA` and a Circle Gas Station policy) |
| `EUPOVA_CIRCLE_UCW_GAS_DAILY_USD` | required with `sponsored`: the same daily limit (US dollars) as the Gas Station policy in the Circle Console, for example `5`. Eupova's own tally of it |
| `EUPOVA_CIRCLE_UCW_GAS_PER_TX_USD` | required with `sponsored`: the most one sponsored transaction is expected to cost (US dollars, for example `0.05`); a payment reserves one, an Arc move two |
| `EUPOVA_BRIDGE_BASE_RPC_URL`, `EUPOVA_BRIDGE_ARC_RPC_URL` | optional https overrides for the chain reads behind the Arc move (defaults are in Circle's Bridge Kit chain data) |
| `EUPOVA_CIRCLE_UCW_BASE_URL` | optional https URL |

These names are already in `render.yaml` (values in the dashboard, mode defaults to `off`).

## Page security policy

Only the app page (not `/api/` responses, and not the Privy pages, which set their own isolated policy) changes, and only on a
deployment that has a live wallet. The base policy is exactly the one served at the base commit `4fd9dc9`. The wallet adds one
exact origin to `frame-src`: `https://pw-auth.circle.com`, the hosted PIN step that Circle's web SDK (1.1.11) puts in an iframe and
talks to with `postMessage`. No wildcard, no `connect-src` addition (the page itself makes no request to Circle in PIN mode), no
`unsafe-inline`, no other directive. `tests/wallet-csp.test.mjs` reads the installed SDK and fails if it uses any other Circle host or
the pinned version changes, and checks the real production responses (page, API, wallet-less deployment). Social login and email OTP
would need further origins and are not offered.

## Networks, tokens and fees

* **Base mainnet** (chain 8453, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and **Base Sepolia** (84532, USDC
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`), taken from the installed Bridge Kit 1.17.0. A deployment serves one of them.
  Mainnet is labelled "Real money"; the test network is labelled as a test network. The other network, other tokens and
  lookalike tokens are refused.
* **Token identity** is chain plus contract address (and 6 decimals, non-native). The balance and the payment use the token
  id found that way; a symbol or name is never matched.
* **Network fee.** On Base it is paid in **ETH** from the wallet (Circle: "your wallet needs enough of the blockchain's
  native asset to cover the fees"). It is never shown or charged as USDC. Before a request is saved, Eupova asks Circle for a
  fee estimate (`estimateTransferFee`), takes the **high** tier, and binds its gas limit, max fee, priority fee and `networkFee`
  ceiling into what the customer approves; the same limits are sent with the transaction. The customer's ETH balance must
  cover it. Allowances count USDC only. If the fee cannot be worked out, no request is made. If the final network fee
  exceeds the approved ceiling the payment is shown with a warning. `sponsored` shows "network fee sponsored" and invents no ceiling.
  Not built: paying gas in USDC through a Paymaster.

## Lists are read to the end

Circle returns lists one page at a time. Wallets, token balances and the transaction lookup follow the cursor until the last page; a
page that does not advance or a list beyond 2,000 records is an error ("balance unavailable", or "outcome unknown" for a payment)
and never a silently partial answer. Recent history reads up to four pages and says if it was cut short. The cursor id used for
token balances (the token id) is not verified against the live API.

## Payment lifecycle (live)

1. A request is saved as *waiting for approval* (tool requests also pass the allowance checks). Nothing external happens.
2. The customer approves. In one transaction: every limit is re-checked, the USDC and ETH reservations are taken under the wallet lock,
   and the payment is saved as *executing*. **Only then** is the provider asked (`createTransaction`, idempotent by payment id) and
   a challenge goes back to the browser once; tokens are never stored or logged.
3. The customer completes the PIN step (`getDeviceId`, `setAuthentication`, `execute`, as Circle documents).
4. The transaction is found by its reference (the payment id) and accepted as **paid only** when it is `COMPLETE` and its
   owner, wallet, network, recipient, single amount, token id, reference and direction all equal the approval. `FAILED`,
   `DENIED` and `CANCELLED` release the reservation. `INITIATED`, `QUEUED`, `CLEARED`, `SENT`, `CONFIRMED` and `STUCK` keep waiting.
   A mismatch, a duplicate, a full page of results or a failed lookup is **outcome unknown**: funds stay reserved, nothing is retried.
5. A crash between steps 2 and 3 is detected (executing, no provider state, two minutes) and becomes *unknown*, never re-sent.
6. The customer cannot declare a live payment settled. "Not sent" is accepted only when the network lookup positively finds no transaction.

The browser sequences (`src/wallet-flow.mjs`) are covered end to end by `tests/wallet-flow.test.mjs`: Circle's step runs in the documented order, a reservation is already saved when it opens, and an abandoned step is resumable.

Setup is saved first (*pending setup*), then Circle is asked (`createUser`, repeat `155101` tolerated; `createUserToken`;
`createUserPinWithWallets`, `155106` meaning already initialised). The PIN step can be resumed; "Check again" reads the wallet back
and only then opens it. Exactly one live wallet per customer on the deployment's network.

## Add money

The wallet's address is also saved as a receiving wallet in the customer's saved wallets, so Pay on Eupova targets this exact
address. **Add money** opens that exact saved wallet, never another one; an already open request is offered separately. Real
Pay on Eupova funding is the existing funding flow, which stays subject to its own configuration (`RELAY_LIVE_PAYMENTS` and Peer credentials).

## Connected tools and the command-line client

`scripts/eupova-tool-cli.mjs` is a request-only client. Enrolment is a device flow (the tool shows a code, the signed-in customer
enters it, the credential is collected once and stored only as a hash). The tool API (`/api/wallet-tool/v1/`) accepts a bearer
credential only: no cookie, origin or fetch-metadata header is accepted, and it has no approval, allowance or revoke route.
A live wallet's tools may not set a USDC fee (the CLI sends none unless `--max-fee` is given).

```
node scripts/eupova-tool-cli.mjs enrol --url https://YOUR-HOST --name "My CLI"
node scripts/eupova-tool-cli.mjs enrol-wait
node scripts/eupova-tool-cli.mjs pay --service "Weather API" --to 0x... --amount 1.25
node scripts/eupova-tool-cli.mjs wait <payment-id>
```

## Arc (the Base to Arc move)

Arc has a mainnet (chain 5042, CCTP domain 26, RPC `https://rpc.mainnet.arc.io/`) and a testnet (5042002, `https://rpc.testnet.arc.io`) in Circle's
current documentation, in Circle's supported-blockchains page (user-controlled EOA and SCA wallets: `ARC`, `ARC-TESTNET`, `BASE`, `BASE-SEPOLIA`) and in the
installed Bridge Kit (`getSupportedChains`), which lists the forwarder as a supported **destination** on all four chains. `shared/wallet-bridge-route.mjs` pins
those values and a test compares them with the installed kit (resolved the way Node resolves packages, and failing if absent). Mainnet and testnet are separate
routes and are never mixed: a deployment's Base network fixes its Arc network.

**The move is implemented and wired** (`hosted/wallet-bridge.mjs` state machine, `hosted/wallet-bridge-transport.mjs` transport, started by
`hosted/live-wallet.mjs`, mounted at `/api/wallet/bridge/{request,decide,continue,refresh}`, shown in the wallet as "Move USDC to Arc"). It follows Circle's
Forwarding Service how-to: the customer's own wallet approves USDC use for the TokenMessengerV2 contract (skipped if the allowance already covers it), then
calls `depositForBurnWithHook` with Circle's forwarding hook; Circle's forwarder mints on Arc, so the customer needs no Arc gas.

* **Fees, read fresh each time** from `GET /v2/burn/USDC/fees/{src}/{dst}?forward=true` (never cached or hardcoded): the protocol fee is quoted in basis points and
  can be fractional (observed 0.325 bps fast, 0 standard), the forwarding fee in USDC minor units at low/med/high. Exact integer arithmetic; protocol fee rounded up;
  forwarding fee at its **high** level; `maxFee` = both. The quote is repeated at approval and a higher schedule cancels the approval.
* **Steps are saved before they are asked for**, under the wallet lock, each with a durable reference (`<bridgeId>:approve`, `<bridgeId>:burn`). A lost answer is
  found again by that reference; the burn is looked up first even if the saved step is missing. Nothing is sent twice: refresh only reads, and "Continue" replays the
  same idempotent request (customer-started, unverified live).
* **The burn is proven from the chain's own logs, never from the outer transaction.** A smart-contract account (ERC-4337) sends through a bundler and the
  EntryPoint, so the receipt's `from`/`to` are neither the customer nor the TokenMessenger. Accepted only when: Circle's record says this wallet's step is
  `COMPLETE` and names the depositor; the receipt succeeded on the checked chain; it holds exactly **one `DepositForBurn`** from the TokenMessengerV2 and exactly
  **one `MessageSent`** from the MessageTransmitterV2 in the same receipt; the two agree (domains, sender, burn token, recipient, amount, depositor, max fee,
  destination caller) and match the approval; and Circle's attested message for that transaction agrees. The event ABIs are those of Circle's `evm-cctp-contracts`
  and the `MessageSent`/`MessageReceived` topics are pinned in a test to the selectors Circle publishes. Anything missing, duplicated or different is "uncertain".
* **The arrival is proven from THIS transaction's receipt on Arc.** Circle must report the message attested and the forward `COMPLETE`; then the destination
  receipt must be successful and **finalised** and contain exactly one **`MessageReceived`** from the destination MessageTransmitterV2 whose own nonce equals the
  burn's nonce and whose source domain, sender (the source TokenMessenger) and burn body (token, recipient, amount, depositor) equal the approval, with the fee executed
  within the approved maximum; the USDC **mint** (a transfer from the zero address) to the recipient in the same receipt must equal exactly amount minus fee executed.
  No global "is this nonce used" read and no unrelated transfer can stand in for it. Anything else is "left Base but the arrival is not confirmed"; it recovers if the
  right record appears.
* **One reservation ledger**: USDC and ETH reservations are shared with payments in both directions (8 of 10 USDC reserved for a payment leaves too little for a 5 USDC move).
* The earlier simulated Arc bridge on the "Bridge and recovery" page stays a clearly labelled **test network** simulation in the local preview only.

## Network fees: sponsored (production) and wallet-paid

Production is configured **SCA + sponsored**: network fees are meant to be covered through a Circle Gas Station policy. The owner reports the policy as **active**
for Base: US$5 per day and US$1 per transaction, with a smart account's initial deployment exempt from the per-transaction cap. That is the owner's statement about
the Console; nothing in this code can read or prove the policy. Because the per-transaction limit does not apply to a smart account's first transaction, the
**daily cap is the essential limit**. The wallet-paid (ETH) path is kept and tested.

* **What Eupova adds is its own local pacing limit** (`GAS_DAILY_USD`, `GAS_PER_TX_USD`): each sponsored payment reserves one transaction and each Arc move two against
  the current UTC day, and when the day's figure is used up new requests are refused up front ("Eupova's own daily limit for sponsored network fees has been reached,
  nothing was charged"). The per-transaction figure is a **planning estimate** used only to pace requests. It cannot prove that a transaction is eligible for
  sponsorship, and neither figure measures what Circle actually spent or invoiced. Circle's window may not be a UTC day and other uses of the policy are invisible here.
* **A network fee on a record is not evidence that the customer paid.** For a sponsored transaction Circle's record can report the network's cost. The receipt
  therefore shows it as "network cost reported" without claiming who paid. Only **payer-specific evidence** flags a problem and pauses sponsorship for the day:
  the wallet's own ETH balance (read before the request and after completion) fell by about the reported fee. If the balances cannot be compared, nothing is concluded
  and nothing pauses. A failed sponsored payment is never described as having cost the customer a fee.
* Nothing silently falls back to charging the customer's ETH. Sponsored payments are described as meant to be covered, never "free": Circle decides whether each
  transaction qualifies, and the USDC fees of an Arc move are still the customer's and are shown first.

## Database

Additive only (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, relaxed `network` and added `fee_asset` checks). Lock order is
owner, then wallet, then rows. Provider reads are made outside open transactions where possible (state, setup, fee estimates);
the approval step reads the balance inside the wallet lock on purpose, so two approvals cannot both spend one balance.

## Activation (owner) and read-only readiness

The API key, the user-id secret and the application id belong in Render only (set by the owner, never in code). The remaining values
are not secret. Suggested first activation, in this order:

1. Deploy this code with `EUPOVA_WALLET_MODE` still `off` (the render.yaml default). Nothing changes for customers.
2. Set these in the Render dashboard:

```
EUPOVA_WALLET_MODE=live
EUPOVA_WALLET_NETWORK=base
EUPOVA_CIRCLE_UCW_ACCOUNT_TYPE=EOA
EUPOVA_CIRCLE_UCW_GAS_MODEL=wallet
```

   * `base` is Base mainnet: real money, and the page says so. Use `base_sepolia` with a TEST key to rehearse first.
   * `EOA` keeps first use simple: the wallet pays its own network fee in ETH and nothing is deployed on first payment. Circle
     advises smart-contract accounts (`SCA`) on L2s mainly for Gas Station sponsorship, which is not configured. The account type
     is fixed per customer once their wallet exists.
   * No page-policy setting exists. `https://pw-auth.circle.com` is built in (see "Page security policy"). If the browser console ever reports
     another blocked Circle origin on the first PIN step, that is a code change to `hosted/wallet-csp.mjs` with its test, never a wildcard.
3. Before and after switching on, in a shell where the service's settings are loaded, run the read-only checks:

```
node scripts/check-wallet-readiness.mjs            # names and status only; exit 0 only when ready
node scripts/check-wallet-readiness.mjs --online   # plus one read-only Circle call (list users, page size 1)
```

   Neither prints a secret, creates anything or moves money. The service also logs one line at start
   ("Customer wallet started on …" or "NOT started: fix …" with setting names only). A customer sees the wallet only when it started.
4. The key must be allowed to create users, issue user tokens, initialise wallets, list wallets and balances, estimate fees,
   create transactions and list transactions. If `--online` fails with 401/403, check the key's type and permissions in the Console first.

First owner test with real money (small amounts): sign in as a customer, Create my wallet and finish the PIN step; the address
appears; send a little ETH (fees) and a little USDC to it on Base; balance appears; Send 1 USDC to an address you control and read the
approval (recipient, amount, ETH fee ceiling, token, network, fingerprint), approve in the PIN step, wait for *Paid* and compare
the receipt's transaction with a block explorer; then enrol the CLI, give it a small allowance, request a payment and approve it.
Anything marked *outcome unknown* stays reserved until the network record settles it; do not retry it.

## Owner setup still needed (not done by this change)

1. A Circle Developer Console account (the owner is completing billing details for mainnet) and a **Standard API key** with User-Controlled Wallets for each environment (TEST for Base Sepolia, LIVE for Base mainnet; confirm in the Console what mainnet access needs).
2. In the Console, **Wallets → User Controlled → Configurator**: the application id, PIN authentication enabled, and the app settings the SDK requires (allowed domains). Acceptance of Circle's developer terms by the account owner.
3. Nothing for the page policy: the one Circle frame origin is built in and checked against the installed SDK (see "Page security policy").
4. The **Gas Station policy** in the Circle Console (Base, daily cap US$5), `SCA` accounts, and `EUPOVA_CIRCLE_UCW_GAS_MODEL=sponsored` with `GAS_DAILY_USD=5` and a `GAS_PER_TX_USD` (for example `0.05`). Or, for the wallet-paid path, ETH in each wallet.
5. The remaining settings above, set in the Render dashboard, and `EUPOVA_WALLET_MODE=live`. Start with `base_sepolia` and a TEST key.
6. Regenerate `package-lock.json` (two new packages, below) outside this workspace.
7. Real Pay on Eupova funding, enabled by its own existing configuration.

## Not verified against Circle (do before real money)

Live API responses and error codes beyond `155101` / `155106`; the units of `maxFee` / `priorityFee` when sent back as explicit gas limits and whether `networkFee`
is a ceiling (it is treated as an estimate only; Base may add a data fee); `listTransactions` fields for PIN-approved transfers and contract calls (including `userId`,
`tokenId`, `contractAddress`); Gas Station behaviour for a first SCA transaction and when the daily cap is hit; that contract-execution challenges accept the
parameter encodings used (`bytes32`, `bytes`) and the idempotent replay of a challenge; the forwarded-mint fields (`forwardState`, `destinationMintTxHash`) and
Arc's `finalized` block tag (a depth fallback is used if the RPC lacks it). All of these were checked only against the installed SDK types (including the real
adapter's own call sites), Circle's published documents and an in-memory stub of the transports.

### First live attempt, 6 November 2026

`Create my wallet` failed with the generic 503 and showed no reason. The cause was the derived Circle user id: `eupova-ucw-`
plus a 40-character digest is 51 characters, one over the 50-character `ExternalUserId` limit in Circle's OpenAPI document,
so every `createUser` was rejected before a wallet could exist. The digest now keeps 39 characters and the id lands on 50.
The adapter test asserts the limit, so it cannot drift back unnoticed.

Wallet steps now return the provider's HTTP status and numeric code with the failure, and log the same line, so the next
rejection names itself instead of reading as an outage.

## Packaging

`package.json` pins `@circle-fin/user-controlled-wallets` 10.8.1 and `@circle-fin/w3s-pw-web-sdk` 1.1.11 (plus the Bridge Kit packages
added earlier). `package-lock.json` was regenerated and committed so the Render build's `npm ci` resolves these versions.
