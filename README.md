# Smart-session redemption fails on MEE 2.2.3 — minimal reproduction

This branch reduces the examples to a **single minimal reproduction** of one problem:
on `@biconomy/abstractjs` **2.0.0** with MEE **2.2.3**, a session key cannot redeem.

| File | What it does |
|------|--------------|
| `transfer.ts` | Enables a session allowing **USDC transfer** on Base, then has the session key perform that transfer |

There is no swap, no bridge, no aggregator and no third-party router involved — just a
session key moving an ERC-20. That keeps the failure unambiguous.

## What happens

| Phase | Result |
|-------|--------|
| 1. Owner enables the session (owner-signed, sponsored supertransaction) | ✅ `MINED_SUCCESS`, and `isPermissionEnabled` reads `true` on-chain |
| 2. Session key transfers 0.01 USDC via `getSessionQuote({ mode: "USE" })` | ❌ quote returns, supertransaction is submitted, then the MEE node rejects it: **`Error: [0] Invalid signature`** |

Observed run on Base mainnet (2026-09-01), account `0x9Cd6D8a41F4D341f70fedC68eAA24070d3b7A7f6`:

```
[1] PREPARE: owner enables a USDC-transfer session...
  status          : MINED_SUCCESS
  permissionId    : 0xb8412808fc379a9681afa5df2e8a4578b48a80a3863bca756dbd7be1cdfe0f33

[2] USE: redeemer transfers 0.01 USDC with the session...
  quote obtained (quote-time simulation passes)
  supertransaction: 0x7080cc514e1a85a6ff6f0d68780c925227d2c8461d53db8479d276e6d6fde951
error: [0] Invalid signature
```

The transfer is fully funded and well inside the session's cap, and the session is live
on-chain — the only thing that fails is the signature check on redemption.

## Why 2.2.3 specifically

On SDK 2.0.0, `getMEEVersion` accepts **only** `MEEVersion.V2_2_3` for new accounts
(`SAFE_MEE_VERSIONS = ["2.2.3"]`). Passing `V2_1_0` is a compile-time error and throws at
runtime:

```
MEE version 2.1.0 cannot be used to create new accounts. Use 2.2.3.
```

So 2.2.3 is the default stack for anyone starting today — and session redemption does not
work on it.

## What has been ruled out

- **Not the policies.** A session whose only policy is `getSudoPolicy()` fails identically.
- **Not the signature-format branch.** `signQuote` picks EIP-712 SuperTx typed data for MEE
  ≥ 2.2.1 and personal-sign below it; both branches were forced, same rejection.
- **Not the SDK.** This same 2.0.0 SDK redeems successfully against MEE **2.1.0** via
  `getLegacyMEEVersion(MEEVersion.V2_1_0)` — enable and redeem both mine, on Base and on
  Robinhood Chain (4663).
- **Not the redemption surface.** Posting the quote request directly to
  `https://api.biconomy.io/v1/quote` with `meeVersion: "2.2.3"` is rejected at input
  validation, because that API's accepted values are `3.0.0, 2.3.0, 2.2.1, 2.1.0, 2.0.0,
  1.1.0, 1.0.0` — `2.2.3` is not among them. Both surfaces fail on 2.2.3; both work on 2.1.0.

One supporting detail on why this is easy to miss: the quote-time simulation that "passes"
before the rejection uses a **mock** signature — and mocks it with
`getOwnableValidatorMockSignature` even though the session validator is MEE K1 — so the real
signature path is never simulated before the quote is accepted.

## Questions for the Biconomy team

1. When will session redemption on MEE 2.2.3 be supported (node validation + the
   `/v1/quote` accepted-version list)?
2. Until then, what is the recommended stack for **new** accounts that need sessions? Is
   `getLegacyMEEVersion(MEEVersion.V2_1_0)` safe for new accounts, despite its
   "existing accounts" documentation note?

## Prerequisites

- [Bun](https://bun.sh)
- An EOA private key, with a little USDC on Base for the smart account
- A Biconomy MEE API key with sponsorship enabled

## Run

```bash
bun install

PRIVATE_KEY=0x... \
MEE_API_KEY=mee_... \
BASE_RPC_URL=https://... \
bun run transfer.ts
```

`BASE_RPC_URL` is optional but recommended — the default public Base endpoint rate-limits the
account-deployment simulation.
