# session-permissioned-intents

This example demonstrates how to use **smart sessions** with the **Biconomy Supertransaction API** to execute cross-chain intent flows (bridging) without requiring the owner to sign every transaction.

## What it does

The example bridges 1 USDC from **Base → Optimism** via Across in two phases:

**Phase 1 – Session setup (owner signs once)**
- Creates a multichain Nexus smart account on Base and Optimism
- Generates an ephemeral **redeemer** key
- Enables a smart session on-chain that grants the redeemer key limited permissions:
  - Transfer up to 5 USDC per call (to cover Supertransaction fees)
  - Approve up to 10 USDC to the Across SpokePool (lifetime cap: 100 USDC, max 10 calls)
  - Call `depositV3` on the Across SpokePool, with calldata rules enforcing:
    - Input token must be USDC on Base
    - Output token must be USDC on Optimism
    - Amount per bridge call capped at 10 USDC
    - Max 10 bridge calls

**Phase 2 – Bridge execution (redeemer signs, no owner needed)**
- Fetches a bridge intent quote from the Biconomy quote API
- Executes the bridge using the session key (redeemer)
- Waits for the supertransaction receipt on both chains

## Prerequisites

- [Bun](https://bun.sh) installed
- A wallet private key with some USDC on Base (or leave balance low — the trigger will fund it)
- A Biconomy API key with sponsorship enabled

## Setup

1. Clone the repo and install dependencies:

```bash
bun install
```

2. Open `index.ts` and replace the placeholder values:

```ts
const PRIVATE_KEY = "0x...";   // Your EOA private key
const API_KEY = "...";         // Your Biconomy MEE API key
```

## Run

```bash
bun run index.ts
```

The script will log explorer links for both the session setup transaction and the bridge transaction.