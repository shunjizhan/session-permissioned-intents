import {
  erc20Abi,
  type Hex,
  http,
  type LocalAccount,
  parseUnits,
  stringify,
} from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey
} from "viem/accounts";
import { base, optimism } from "viem/chains";
import {
  createMeeClient,
  getMEEVersion,
  mcUSDC,
  toMultichainNexusAccount,
  MEEVersion,
  type SessionDetail,
  type GetQuotePayload,
  type Trigger,
  calldataArgument,
  mcUSDT
} from "@biconomy/abstractjs";

async function main() {
  const PRIVATE_KEY = "PRIVATE_KEY" as Hex;
  const API_KEY = "API_KEY";
  const ODOS_ROUTER_ADDRESS =
    "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05";
  const USDC_BASE = mcUSDC.addressOn(base.id);
  const USDT_BASE = mcUSDT.addressOn(base.id);
  const USDC_DECIMALS = 6;

  // 1. EOA signer – owner of the smart account. Signs the session setup once.
  const signer = privateKeyToAccount(PRIVATE_KEY);
  // Redeemer – Temporary ephemeral key that executes bridge transactions using the session.
  // The owner never needs to sign again after the session is enabled.
  let redeemerAccount: LocalAccount = privateKeyToAccount(generatePrivateKey());

  // Amount to bridge: 0.2 USDC (6 decimals)
  const SWAP_AMOUNT = parseUnits("0.2", 6)

  // 2. Multichain Nexus account – same deterministic address on Base and Optimism.
  //    Both chains are required: Base is the deposit chain, Optimism is the receive chain.
  const mcNexus = await toMultichainNexusAccount({
    signer,
    chainConfigurations: [
      {
        chain: base,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
      },
      {
        chain: optimism,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
      },
    ],
  });

  // 3. MEE client – owner's client used only for Phase 1 (session setup).
  const meeClient = await createMeeClient({
    account: mcNexus,
    apiKey: API_KEY, // Sponsorship enabled api key
  });

  // Trigger: funds the smart account with USDC on Base before enabling the session.
  // Only used when the account balance is below the required threshold (see isFundingRequired).
  const trigger: Trigger = {
    tokenAddress: USDC_BASE,
    chainId: base.id,
    amount: SWAP_AMOUNT,
  };

  // Session actions define exactly what the redeemer key is allowed to do.
  // Each action compiles down to a session policy enforced on-chain by the smart account.
  const actions = [
    // Action 1 – Transfer: lets the redeemer transfer up to 5 USDC per call (Supertransaction bps fee).
    mcNexus.buildSessionAction({
      type: "transfer",
      data: {
        chainIds: [base.id],
        contractAddress: USDC_BASE,
        amountLimitPerAction: parseUnits("5", USDC_DECIMALS),
      },
    }),
    // Action 2 – Approve: lets the redeemer approve USDC to the Odos Router.
    //   • amountLimitPerAction: single approval capped at 10 USDC
    //   • maxAmountLimit: lifetime approval ceiling of 100 USDC
    //   • usageLimit: approval call allowed at most 10 times
    mcNexus.buildSessionAction({
      type: "approve",
      data: {
        chainIds: [base.id],
        contractAddress: USDC_BASE,
        recipientAddress: ODOS_ROUTER_ADDRESS,
        amountLimitPerAction: parseUnits("10", USDC_DECIMALS),
        maxAmountLimit: parseUnits("100", USDC_DECIMALS),
        usageLimit: 10n,
      },
    }),
    // Action 3 – Custom: lets the redeemer call the Odos swap function (0x30f80b4c) on the Odos Router.
    //   Policies applied:
    //   • universal – calldata rules that lock down the call arguments:
    //       - arg[1] (inputToken)  must equal USDC on Base  → prevents draining other tokens
    //       - arg[2] (inputAmount) must be ≤ 10 USDC        → caps the per-swap amount
    //       - arg[4] (outputToken) must equal USDT on Base  → enforces the correct output token
    //   • usageLimit – the redeemer can call the swap function at most 10 times with this session
    mcNexus.buildSessionAction({
      type: "custom",
      data: {
        chainIds: [base.id],
        contractAddress: ODOS_ROUTER_ADDRESS,
        functionSignature: "0x30f80b4c",
        policies: [
          {
            type: "universal",
            rules: [
              {
                calldataOffset: calldataArgument(1),
                condition: "equal",
                comparisonValue: USDC_BASE as Hex,
              },
              {
                calldataOffset: calldataArgument(2),
                condition: "lessThanOrEqual",
                comparisonValue: parseUnits("10", USDC_DECIMALS),
              },
              {
                calldataOffset: calldataArgument(4),
                condition: "equal",
                comparisonValue: USDT_BASE as Hex,
              },
            ],
          },
          {
            type: "usageLimit",
            limit: 10n,
          },
        ],
      },
    })
  ];

  // Check current USDC balance of the smart account on Base.
  // If it is below 1 USDC the trigger will fund it as part of the session setup tx.
  const { publicClient } = mcNexus.deploymentOn(base.id, true);

  const scaBalance = await publicClient.readContract({
    abi: erc20Abi,
    functionName: "balanceOf",
    address: USDC_BASE,
    args: [mcNexus.addressOn(base.id, true)],
  });

  const isFundingRequired = scaBalance < SWAP_AMOUNT;

  // Phase 1 – PREPARE mode: builds and enables the smart session on-chain.
  // The owner EOA signs this once. After this tx is mined the redeemer key
  // can execute bridge calls autonomously without the owner's involvement.
  // sponsorship: true means Biconomy's gas tank covers the session setup fee.
  const prepareAndEnableSessionQuote = await meeClient.getSessionQuote({
    mode: "PREPARE",
    enableSession: {
      redeemer: redeemerAccount.address,
      actions,
    },
    simulation: {
      simulate: true,
    },
    ...(isFundingRequired ? { trigger } : {}),
    sponsorship: true,
  });

  let sessionDetails: SessionDetail[] = [];

  if (prepareAndEnableSessionQuote) {
    // Execute the session setup supertransaction (owner signs here).
    const { hash } = await meeClient.executeSessionQuote(
      prepareAndEnableSessionQuote
    );

    // Wait until the session is fully enabled on-chain before proceeding.
    const { explorerLinks } = await meeClient.waitForSupertransactionReceipt({
      hash: hash,
    });

    console.log("Prepare permissions and enable session: ", {
      explorerLinks,
    });

    if (!prepareAndEnableSessionQuote.sessionDetails) {
      throw new Error("Missing session details");
    }

    // sessionDetails carries the on-chain session proof sent to the quote API
    // so the MEE node knows which session key authorises the bridge userOps.
    sessionDetails = prepareAndEnableSessionQuote.sessionDetails;
  }

  // Phase 2 – Fetch a swap intent quote from the Supertransaction API.
  // Passes sessionDetails so the node builds userOps signed by the redeemer key.
  // intent-simple swaps USDC → USDT on Base via Odos (allowSwapProviders).
  // Odos is very well suited for smart session granualr permissions
  const quoteResult = await fetch("https://api.biconomy.io/v1/quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: stringify({
      mode: "smart-account",
      ownerAddress: signer.address,
      sessionDetails,
      meeVersion: MEEVersion.V2_1_0.toString(),
      routeSelectionMode: 'fast-quote', // 'cheap', 'fast-quote', 'fast-execution'
      composeFlows: [
        {
          type: "/instructions/intent-simple",
          data: {
            srcChainId: base.id,
            dstChainId: base.id,
            srcToken: USDC_BASE,
            dstToken: USDT_BASE,
            amount: SWAP_AMOUNT,
            slippage: 0.01,
            allowSwapProviders: "odos",
          },
        },
      ],
    }),
  }).then((response) => response.json());

  const quote = quoteResult.quote as GetQuotePayload;

  if (!quote) {
    console.log("Failed to get quote: ", stringify(quoteResult, null, 2));
  }

  // Build a separate mcNexus instance with signer as the redeemer account.
  // accountAddress is pinned to the owner's smart account so all actions
  // still target the same on-chain wallet, but signed by the redeemer key.
  const redeemerMcNexus = await toMultichainNexusAccount({
    chainConfigurations: [
      {
        chain: base,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
        accountAddress: mcNexus.addressOn(base.id, true),
      },
      {
        chain: optimism,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
        accountAddress: mcNexus.addressOn(optimism.id, true),
      },
    ],
    signer: redeemerAccount,
  });

  // Redeemer's MEE client – this is what signs and submits the bridge transaction.
  const redeemerMeeClient = await createMeeClient({
    account: redeemerMcNexus,
    apiKey: API_KEY,
  });

  // Execute the swap quote using the session key (no owner signature needed).
  const { hash } = await redeemerMeeClient.executeSessionQuote({
    quoteType: "simple",
    quote,
  });

  // Wait for the swap supertransaction to be mined on Base.
  const { explorerLinks } =
    await redeemerMeeClient.waitForSupertransactionReceipt({
      hash,
    });

  console.log("Use session swap transaction links: ", {
    explorerLinks,
  });

  return hash;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});