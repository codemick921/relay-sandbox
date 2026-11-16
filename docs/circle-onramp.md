# Circle Onramp (sandbox)

Customers can try buying USDC with a card or bank transfer in Circle's hosted checkout (Circle App Kit onramp). The USDC goes to one of the customer's saved Base USDC wallets. This release is **sandbox only**: no real money moves and no real USDC is delivered.

## Turning it on

Set one environment variable on the web service. Without it the option is hidden and the route returns 403.

- `EUPOVA_CIRCLE_ONRAMP_API_KEY`: a Circle **testnet** API key (`TEST_API_KEY:...`). Create it in the Circle Console with the toggle on Testnet. A mainnet key (`LIVE_API_KEY:...`) is refused at startup, the feature stays off and the reason is logged (never the key).
- `EUPOVA_CIRCLE_ONRAMP_ENV` (optional): only `sandbox` is accepted.

Restart the web service after changing it. The worker does not use it.

## What it does

- `POST /api/onramp/session` (customer session, same-origin JSON, rate limited to 10 per minute) takes only `{agentId}`. The server reads the receiving address from that saved wallet, so the browser cannot choose or change where funds go. Anything else in the body is rejected.
- The session is minted with Circle's server kit, scoped to USDC on Base, and `appUserId` is the opaque account id (no email or personal data). Only the session is returned; the API key never reaches the browser.
- The browser opens Circle's checkout in a separate window. The page policy is unchanged (no new frame or connect origin).
- `state.circleOnramp` is added for signed-in customers when the feature is on.

## Limits

- Browser events from the checkout are hints only. Eupova does not confirm delivery for this option; the wallet balance on Base is the evidence. Circle sends no onramp webhooks.
- Sandbox test deposits can be limited to Ethereum by Circle's sandbox, so a Base-scoped test may offer fewer payment options than production would.
- Going live needs a mainnet key, Circle business verification (KYB) for card payments, `referrerDomain` if the widget is ever embedded, onchain delivery verification, and a separate review. None of that is enabled here.

## Install note

`@circle-fin/app-kit` 1.21.0 was added to `package.json`. Run `npm install` once to refresh `package-lock.json` before the next deploy (`npm ci` fails until it is refreshed).
