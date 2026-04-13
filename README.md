# session-permissioned-intents

This repo demonstrates how to use **smart sessions** with the **Biconomy Supertransaction API** to execute cross-chain and single-chain intent flows without requiring the owner to sign every transaction.

Two examples are included:

| File | What it does |
|------|-------------|
| `bridge.ts` | Bridges 1 USDC from **Base → Optimism** via Across |
| `swap.ts` | Swaps 0.2 USDC → USDT on **Base** via Odos |

Both follow the same two-phase pattern: the owner signs once to enable a session, then an ephemeral redeemer key executes the intent autonomously.

---

## bridge.ts — USDC Bridge (Base → Optimism)

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

---

## swap.ts — USDC → USDT Swap (Base)

**Phase 1 – Session setup (owner signs once)**
- Creates a multichain Nexus smart account on Base and Optimism
- Generates an ephemeral **redeemer** key
- Enables a smart session on-chain that grants the redeemer key limited permissions:
  - Transfer up to 5 USDC per call (to cover Supertransaction fees)
  - Approve up to 10 USDC to the Odos Router (lifetime cap: 100 USDC, max 10 calls)
  - Call the Odos swap function (`0x30f80b4c`) on the Odos Router, with calldata rules enforcing:
    - Input token must be USDC on Base
    - Input amount capped at 10 USDC per swap
    - Output token must be USDT on Base
    - Max 10 swap calls

**Phase 2 – Swap execution (redeemer signs, no owner needed)**
- Fetches a swap intent quote from the Biconomy quote API using `intent-simple` with `allowSwapProviders: "odos"`
- Executes the swap using the session key (redeemer)
- Waits for the supertransaction receipt on Base

---

## Prerequisites

- [Bun](https://bun.sh) installed
- A wallet private key with some USDC on Base (or leave balance low — the trigger will fund it)
- A Biconomy API key with sponsorship enabled

## Setup

1. Clone the repo and install dependencies:

```bash
bun install
```

2. Open the example file you want to run and replace the placeholder values:

```ts
const PRIVATE_KEY = "0x...";   // Your EOA private key
const API_KEY = "...";         // Your Biconomy MEE API key
```

## Run

```bash
# Bridge USDC from Base to Optimism
bun run bridge.ts

# Swap USDC to USDT on Base
bun run swap.ts
```

Each script logs explorer links for both the session setup transaction and the intent execution transaction.
