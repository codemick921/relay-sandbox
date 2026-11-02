# Receiving guides

The destination profiles extend the existing Base-USDC receiving guide. They appear in My agents, the wallet editor, funding requests and the three-step funding journey. Choices and answers remain in React memory. No saved wallet field, customer row, payment setting or provider configuration changes.

Profiles cover a Base wallet, another hosted platform and Tempo Wallet. The generic platform checklist is not a claim that every platform accepts this route. Tempo's guide explicitly separates Base delivery from Tempo account credit; there is no Tempo bridge or deposit API call. The optional receiving checklist summarises the user's answers, not verified eligibility. It cannot enable payment, bypass address validation or submit any form.

Changing profile clears answers. Unknown answers never produce a completed checklist. Native USDC/Base mismatch and extra transfer requirements produce a specific unsupported result. Existing server/client address guards, password confirmation and final destination acknowledgement remain unchanged.

Provider documentation checked 2 November 2026: Circle USDC contract list and Tempo getting-funds/Accounts deposit documentation. Source links are in the profile data. No customer address is sent to these sources. Review the guides when provider instructions change; account-specific minimums, expiry and sender rules must always be read in the receiving platform.

Future saved destination profiles need immutable revision binding to agent requests and payments. This first release deliberately stores no extra customer data. Do not infer a platform from a saved wallet name or 0x address.
