# session-permissioned-intents

This repo demonstrates how to use **smart sessions** with the **Biconomy Supertransaction API** to execute cross-chain and single-chain intent flows without requiring the owner to sign every transaction.

Three examples are included:

| File | What it does |
|------|-------------|
| `bridge.ts` | Bridges 1 USDC from **Base → Optimism** via Across |
| `swap.ts` | Swaps 0.2 USDC → USDT on **Base** via Odos |
| `autonomous-trade.ts` | One session enables an agent to **buy AND sell arbitrary tokens** on Base via Odos, without per-token approval from the owner |

All three follow the same two-phase pattern: the owner signs once to enable a session, then an ephemeral redeemer key executes the intent autonomously.

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

---

## autonomous-trade.ts — Agent-driven trading on Base

This example is for the "user is asleep, agent autonomously buys and sells memecoins" scenario. The challenge with that flow is that smart-session policies are normally keyed on `(target, selector)`, but for `approve()` the target is the token contract — and an arbitrary memecoin's address isn't known when the user signs the session.

It solves this with a **fallback action policy**: smart-sessions natively supports a sentinel `(FALLBACK_TARGET_FLAG, FALLBACK_TARGET_SELECTOR_FLAG)` registration that applies whenever no specific `(target, selector)` policy matches. The policy inspects calldata and accepts `approve(spender == OdosRouter, amount ≤ cap)` on **any** ERC20 — including tokens that don't exist yet at session-creation time.

**Phase 1 — Session setup (owner signs once)**

The owner enables a session granting the redeemer:
- Transfer USDC up to 5 per call (Supertransaction fees)
- Approve USDC → Odos Router (per-call cap + cumulative budget)
- **Fallback approve policy**: approve(any token → Odos Router, ≤ cap) — authorizes selling whatever the agent bought
- Call Odos `swap` (`0x30f80b4c`) with `inputAmount` capped per call
- Global guardrails: trade count limit, cumulative USDC budget

**Phase 2 — Agent trades autonomously (no owner signature)**

- **Buy**: USDC → DEGEN (any non-USDC token, used here as a stand-in for a memecoin)
- **Sell**: DEGEN → USDC — this is the path that exercises the fallback policy, because the SCA must approve DEGEN to Odos and DEGEN was not whitelisted at session-creation time.

### Limitations and notes

- **Locked to Odos.** Odos has flat, static-offset swap calldata that smart-session calldata rules can constrain. LiFi / 0x / 1inch use dynamic-array calldata that can't be locked down with static-offset rules. Multi-aggregator support requires a custom routing proxy that normalizes the calldata layout — not included here.
- **Permissive swap rule.** For brevity the example only caps `inputAmount` on the swap call. In production, add an OR-rule enforcing that at least one leg of every swap is USDC (so the agent can't chain token→token swaps that bypass the budget). Requires `ArgPolicy` expression-tree support exposed through the SDK.
- **SDK compatibility.** Registering a fallback action via `buildSessionAction({ type: "custom", contractAddress: 0x...01, functionSignature: 0x00000001 })` depends on the high-level abstractjs builder passing those sentinel values through unchanged. If the builder rejects them, drop to lower-level smart-session encoding for this action.

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

# Buy + sell an arbitrary token autonomously on Base
bun run autonomous-trade.ts
```

Each script logs explorer links for both the session setup transaction and the intent execution transaction.
