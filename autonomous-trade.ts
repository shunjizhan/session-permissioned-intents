import {
  concat,
  erc20Abi,
  type Hex,
  http,
  type LocalAccount,
  pad,
  parseUnits,
  stringify,
  toHex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { base } from "viem/chains";
import {
  calldataArgument,
  createMeeClient,
  type GetQuotePayload,
  getMEEVersion,
  mcUSDC,
  MEEVersion,
  type SessionDetail,
  toMultichainNexusAccount,
  type Trigger,
} from "@biconomy/abstractjs";

// =========================================================================
// Autonomous-trade example — single session, buy ANY token + sell ANY token.
//
// The owner signs once. After that, an ephemeral redeemer key ("the agent")
// can both buy and sell arbitrary tokens on Base via Odos, bounded by:
//   - per-call USDC notional cap
//   - cumulative USDC budget (lifetime of the session)
//   - max trade count
//
// The trick that makes "sell an arbitrary token the agent just bought"
// possible without per-token session updates is a FALLBACK action policy
// that authorizes approve(spender == OdosRouter, amount <= cap) on ANY
// target contract. Smart-sessions supports this natively via the
// FALLBACK_TARGET_FLAG / FALLBACK_ACTIONID sentinels — see
// rhinestone smart-sessions DataTypes.sol and PolicyLib.sol.
//
// Aggregator is fixed to Odos. Odos has flat, static-offset swap calldata,
// which is what smart-session calldata rules need. Supporting LiFi / 0x /
// 1inch in the same session would require a custom routing proxy contract
// that normalizes the calldata layout — out of scope here.
// =========================================================================

async function main() {
  const PRIVATE_KEY = "PRIVATE_KEY" as Hex;
  const API_KEY = "API_KEY";

  // ---------- Constants ----------
  const ODOS_ROUTER = "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05" as Hex;
  const USDC_BASE = mcUSDC.addressOn(base.id);
  // Any non-USDC ERC20 the agent might want to buy. DEGEN on Base used as a
  // stand-in for an "arbitrary memecoin the agent picked autonomously".
  const TARGET_TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" as Hex;
  const USDC_DECIMALS = 6;
  const ODOS_SWAP_SELECTOR = "0x30f80b4c" as Hex;
  const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as Hex;

  // Smart-sessions fallback-action sentinels.
  // (target == address(1) && selector == 0x00000001) registers a policy under
  // FALLBACK_ACTIONID — applied when no specific (target, selector) policy
  // is matched. See rhinestone/smartsessions DataTypes.sol.
  const FALLBACK_TARGET_FLAG =
    "0x0000000000000000000000000000000000000001" as Hex;
  const FALLBACK_TARGET_SELECTOR_FLAG = "0x00000001" as Hex;

  // Session economics.
  const PER_SWAP_CAP = parseUnits("10", USDC_DECIMALS);
  const SESSION_BUDGET = parseUnits("100", USDC_DECIMALS);
  const SESSION_TRADE_COUNT = 20n;

  // The amount the agent's first trade will sell.
  const BUY_AMOUNT = parseUnits("0.2", USDC_DECIMALS);

  // ---------- Keys ----------
  // Owner EOA — signs the session enable tx exactly once.
  const signer = privateKeyToAccount(PRIVATE_KEY);
  // Ephemeral key the agent will use to sign every subsequent trade.
  const redeemerAccount: LocalAccount = privateKeyToAccount(generatePrivateKey());

  // ---------- Smart account ----------
  const mcNexus = await toMultichainNexusAccount({
    signer,
    chainConfigurations: [
      {
        chain: base,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
      },
    ],
  });

  const meeClient = await createMeeClient({
    account: mcNexus,
    apiKey: API_KEY,
  });

  // =====================================================================
  // Build session policies
  // =====================================================================

  // ERC20.approve(address spender, uint256 amount) calldata layout:
  //   bytes  0..3  selector       (0x095ea7b3)
  //   bytes  4..35 spender        (left-padded address, 32 bytes)
  //   bytes 36..67 amount         (uint256)
  //
  // To pin the selector with ArgPolicy/UniActionPolicy (which only does
  // 32-byte EQUAL comparisons against a bytes32 ref), we read bytes [0, 32)
  // and compare against a constructed bytes32:
  //   selector (4B) || zero padding (12B) || first 16 bytes of OdosRouter (16B)
  //
  // Combined with a second rule pinning the full spender field at offset 4,
  // this fully constrains the call to "approve(OdosRouter, ?)".
  const selectorAndSpenderPrefix = concat([
    ERC20_APPROVE_SELECTOR,
    "0x000000000000000000000000",
    `0x${ODOS_ROUTER.slice(2, 2 + 32)}` as Hex,
  ]) as Hex;

  const actions = [
    // 1) Cover Supertransaction fees in USDC.
    mcNexus.buildSessionAction({
      type: "transfer",
      data: {
        chainIds: [base.id],
        contractAddress: USDC_BASE,
        amountLimitPerAction: parseUnits("5", USDC_DECIMALS),
      },
    }),

    // 2) Buy-side approve: USDC -> Odos. Standard per-target approve policy.
    mcNexus.buildSessionAction({
      type: "approve",
      data: {
        chainIds: [base.id],
        contractAddress: USDC_BASE,
        recipientAddress: ODOS_ROUTER,
        amountLimitPerAction: PER_SWAP_CAP,
        maxAmountLimit: SESSION_BUDGET,
        usageLimit: SESSION_TRADE_COUNT,
      },
    }),

    // 3) FALLBACK approve policy — the key piece.
    //    Authorizes approve(OdosRouter, <= PER_SWAP_CAP) on ANY ERC20 contract.
    //    Without this, the agent can't sell the tokens it bought (because the
    //    SCA would need to approve(<bought_token>, OdosRouter, ...) and that
    //    token's address wasn't known at session-creation time).
    //
    //    NOTE: passes the sentinel target/selector that smart-sessions treats
    //    as "register this under FALLBACK_ACTIONID". Whether the high-level
    //    abstractjs builder lets these sentinel values through unchanged
    //    depends on the SDK version. If it rejects them, drop to lower-level
    //    smart-session encoding for this action.
    mcNexus.buildSessionAction({
      type: "custom",
      data: {
        chainIds: [base.id],
        contractAddress: FALLBACK_TARGET_FLAG,
        functionSignature: FALLBACK_TARGET_SELECTOR_FLAG,
        policies: [
          {
            type: "universal",
            rules: [
              // (a) Pin selector + first 16 bytes of spender by checking
              //     bytes [0, 32) against the constructed prefix.
              {
                calldataOffset: 0n,
                condition: "equal",
                comparisonValue: selectorAndSpenderPrefix,
              },
              // (b) Pin the full spender field at offset 4 (bytes [4, 36)).
              {
                calldataOffset: 4n,
                condition: "equal",
                comparisonValue: pad(ODOS_ROUTER) as Hex,
              },
              // (c) Cap the approved amount.
              {
                calldataOffset: 36n,
                condition: "lessThanOrEqual",
                comparisonValue: toHex(PER_SWAP_CAP),
              },
            ],
          },
          { type: "usageLimit", limit: SESSION_TRADE_COUNT },
        ],
      },
    }),

    // 4) Odos swap action.
    //    Caps per-call inputAmount. inputToken / outputToken are intentionally
    //    left unconstrained: the approve policies above are what gate which
    //    tokens can actually flow (USDC pre-approved + arbitrary tokens
    //    approvable via the fallback policy). For a production deployment,
    //    additionally enforce "inputToken == USDC OR outputToken == USDC" via
    //    ArgPolicy's expression tree (AND/OR), so the agent can't chain
    //    token->token swaps that bypass the USDC budget.
    mcNexus.buildSessionAction({
      type: "custom",
      data: {
        chainIds: [base.id],
        contractAddress: ODOS_ROUTER,
        functionSignature: ODOS_SWAP_SELECTOR,
        policies: [
          {
            type: "universal",
            rules: [
              {
                calldataOffset: calldataArgument(2), // inputAmount
                condition: "lessThanOrEqual",
                comparisonValue: toHex(PER_SWAP_CAP),
              },
            ],
          },
          { type: "usageLimit", limit: SESSION_TRADE_COUNT },
        ],
      },
    }),
  ];

  // =====================================================================
  // Phase 1 — Owner signs the session enable transaction
  // =====================================================================

  const { publicClient } = mcNexus.deploymentOn(base.id, true);
  const scaBalance = await publicClient.readContract({
    abi: erc20Abi,
    functionName: "balanceOf",
    address: USDC_BASE,
    args: [mcNexus.addressOn(base.id, true)],
  });

  const trigger: Trigger = {
    tokenAddress: USDC_BASE,
    chainId: base.id,
    amount: BUY_AMOUNT,
  };
  const isFundingRequired = scaBalance < BUY_AMOUNT;

  const prepareQuote = await meeClient.getSessionQuote({
    mode: "PREPARE",
    enableSession: {
      redeemer: redeemerAccount.address,
      actions,
    },
    simulation: { simulate: true },
    ...(isFundingRequired ? { trigger } : {}),
    sponsorship: true,
  });

  let sessionDetails: SessionDetail[] = [];
  if (prepareQuote) {
    const { hash } = await meeClient.executeSessionQuote(prepareQuote);
    const { explorerLinks } = await meeClient.waitForSupertransactionReceipt({
      hash,
    });
    console.log("Session enabled:", { explorerLinks });
    if (!prepareQuote.sessionDetails) {
      throw new Error("Missing session details");
    }
    sessionDetails = prepareQuote.sessionDetails;
  }

  // =====================================================================
  // Phase 2 — Agent executes trades (no owner involvement)
  // =====================================================================

  const redeemerMcNexus = await toMultichainNexusAccount({
    chainConfigurations: [
      {
        chain: base,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
        accountAddress: mcNexus.addressOn(base.id, true),
      },
    ],
    signer: redeemerAccount,
  });
  const redeemerMeeClient = await createMeeClient({
    account: redeemerMcNexus,
    apiKey: API_KEY,
  });

  // ---------- 2a. BUY USDC -> TARGET_TOKEN ----------
  // The buy uses the pre-known USDC->Odos approve policy (#2 above).
  console.log(`Agent buying ${TARGET_TOKEN} with ${BUY_AMOUNT} USDC...`);
  const buyQuote = await fetchSwapQuote({
    apiKey: API_KEY,
    signer,
    sessionDetails,
    srcToken: USDC_BASE,
    dstToken: TARGET_TOKEN,
    amount: BUY_AMOUNT,
  });
  const { hash: buyHash } = await redeemerMeeClient.executeSessionQuote({
    quoteType: "simple",
    quote: buyQuote,
  });
  const buyReceipt = await redeemerMeeClient.waitForSupertransactionReceipt({
    hash: buyHash,
  });
  console.log("Buy complete:", { explorerLinks: buyReceipt.explorerLinks });

  // ---------- 2b. SELL TARGET_TOKEN -> USDC ----------
  // This call sequence emits:
  //   approve(TARGET_TOKEN, OdosRouter, <= cap)   <- gated by FALLBACK policy
  //   swap(...) on OdosRouter                     <- gated by action #4
  // Neither was specifically whitelisted at session-creation time; both pass
  // because TARGET_TOKEN was unknown then, and that's the entire point of
  // the fallback policy.
  const targetBalance = await publicClient.readContract({
    abi: erc20Abi,
    functionName: "balanceOf",
    address: TARGET_TOKEN,
    args: [mcNexus.addressOn(base.id, true)],
  });
  console.log(`Agent selling ${targetBalance} of ${TARGET_TOKEN} -> USDC...`);

  const sellQuote = await fetchSwapQuote({
    apiKey: API_KEY,
    signer,
    sessionDetails,
    srcToken: TARGET_TOKEN,
    dstToken: USDC_BASE,
    amount: targetBalance,
  });
  const { hash: sellHash } = await redeemerMeeClient.executeSessionQuote({
    quoteType: "simple",
    quote: sellQuote,
  });
  const sellReceipt = await redeemerMeeClient.waitForSupertransactionReceipt({
    hash: sellHash,
  });
  console.log("Sell complete:", { explorerLinks: sellReceipt.explorerLinks });
  console.log("\nRound-trip done. Session is still live for further trades.");
}

async function fetchSwapQuote(args: {
  apiKey: string;
  signer: LocalAccount;
  sessionDetails: SessionDetail[];
  srcToken: Hex;
  dstToken: Hex;
  amount: bigint;
}): Promise<GetQuotePayload> {
  const res = await fetch("https://api.biconomy.io/v1/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": args.apiKey },
    body: stringify({
      mode: "smart-account",
      ownerAddress: args.signer.address,
      sessionDetails: args.sessionDetails,
      meeVersion: MEEVersion.V2_1_0.toString(),
      routeSelectionMode: "fast-quote",
      composeFlows: [
        {
          type: "/instructions/intent-simple",
          data: {
            srcChainId: base.id,
            dstChainId: base.id,
            srcToken: args.srcToken,
            dstToken: args.dstToken,
            amount: args.amount,
            slippage: 0.01,
            allowSwapProviders: "odos",
          },
        },
      ],
    }),
  }).then((r) => r.json());

  if (!res.quote) {
    throw new Error(`Quote failed: ${stringify(res, null, 2)}`);
  }
  return res.quote as GetQuotePayload;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
