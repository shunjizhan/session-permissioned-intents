// Minimal reproduction: smart-session REDEMPTION fails on MEE 2.2.3.
//
// Stack: @biconomy/abstractjs 2.0.0 (current release) on Base mainnet. On this SDK,
// getMEEVersion accepts ONLY MEEVersion.V2_2_3 for new accounts (SAFE_MEE_VERSIONS =
// ["2.2.3"]); passing V2_1_0 is a compile-time error and throws at runtime with
// "MEE version 2.1.0 cannot be used to create new accounts. Use 2.2.3." So this is the
// default stack for anyone starting today.
//
// The session grants exactly one permission — transfer USDC — so there is no swap, no
// bridge, no aggregator and no third-party router involved. Nothing but a session key
// moving an ERC-20.
//
//   Phase 1  owner enables the session (owner-signed supertransaction)  ✅ mines
//   Phase 2  redeemer transfers USDC using that session                 ❌ MEE node rejects
//
// The identical flow works end to end on MEE 2.1.0, so the account, the policies and the
// session key are all fine — only redemption on 2.2.3 is rejected.
//
//   PRIVATE_KEY=0x... MEE_API_KEY=... bun run transfer.ts
//
// BASE_RPC_URL is optional but recommended — the default public Base endpoint rate-limits
// the account-deployment simulation.
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
  type LocalAccount,
  parseUnits,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import {
  buildSessionAction,
  createMeeClient,
  getMEEVersion,
  mcUSDC,
  toMultichainNexusAccount,
  MEEVersion,
  type SessionDetail,
} from "@biconomy/abstractjs";

async function main() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
  const API_KEY = process.env.MEE_API_KEY as string;
  const RPC_URL = process.env.BASE_RPC_URL; // optional; undefined => viem's public default
  if (!PRIVATE_KEY || !API_KEY) {
    throw new Error("Set PRIVATE_KEY and MEE_API_KEY (a sponsorship-enabled MEE key).");
  }
  const transport = http(RPC_URL);

  const USDC_BASE = mcUSDC.addressOn(base.id);
  const USDC_DECIMALS = 6;
  // Session cap, and the amount the session key actually moves.
  const TRANSFER_LIMIT = parseUnits("1", USDC_DECIMALS);
  const TRANSFER_AMOUNT = parseUnits("0.01", USDC_DECIMALS);

  // 1. EOA signer – owner of the smart account. Signs the session setup once.
  const signer = privateKeyToAccount(PRIVATE_KEY);
  // Redeemer – ephemeral key that spends through the session. The owner never signs again.
  const redeemerAccount: LocalAccount = privateKeyToAccount(generatePrivateKey());

  // 2. Nexus account on Base. V2_2_3 is the only version this SDK allows for new accounts.
  const mcNexus = await toMultichainNexusAccount({
    signer,
    chainConfigurations: [
      {
        chain: base,
        transport,
        version: getMEEVersion(MEEVersion.V2_2_3),
      },
    ],
  });
  const accountAddress = mcNexus.addressOn(base.id, true);

  // 3. MEE client – owner's client, used only for Phase 1.
  const meeClient = await createMeeClient({
    account: mcNexus,
    apiKey: API_KEY, // Sponsorship enabled api key
  });

  const { publicClient } = mcNexus.deploymentOn(base.id, true);
  const usdcBalance = () =>
    publicClient.readContract({
      abi: erc20Abi,
      address: USDC_BASE,
      functionName: "balanceOf",
      args: [accountAddress],
    });

  console.log("Smart account:", accountAddress);
  console.log("Redeemer     :", redeemerAccount.address, "(ephemeral)");
  console.log("Account USDC :", formatUnits(await usdcBalance(), USDC_DECIMALS));

  // The session's only permission: transfer USDC, capped per call.
  const actions = [
    buildSessionAction({
      type: "transfer",
      data: {
        chainIds: [base.id],
        contractAddress: USDC_BASE,
        amountLimitPerAction: TRANSFER_LIMIT,
      },
    }),
  ].flat();

  // ── Phase 1 – PREPARE: enable the session on-chain (owner-signed, sponsored) ──
  // ✅ This works on 2.2.3. The supertransaction mines and the session is enabled.
  console.log("\n[1] PREPARE: owner enables a USDC-transfer session...");
  const prepareQuote = await meeClient.getSessionQuote({
    mode: "PREPARE",
    enableSession: {
      redeemer: redeemerAccount.address,
      actions,
    },
    simulation: { simulate: true },
    sponsorship: true,
  });
  if (!prepareQuote) throw new Error("No PREPARE quote");

  const { hash: enableHash } = await meeClient.executeSessionQuote(prepareQuote);
  const enableReceipt = await meeClient.waitForSupertransactionReceipt({ hash: enableHash });
  console.log("  supertransaction:", enableHash);
  console.log("  status          :", enableReceipt.transactionStatus);

  if (!prepareQuote.sessionDetails) throw new Error("Missing session details");
  const sessionDetails: SessionDetail[] = prepareQuote.sessionDetails;
  console.log("  permissionId    :", sessionDetails[0]?.permissionId);

  // ── Phase 2 – USE: the redeemer spends through the session ──
  // Same smart account, pinned by address, but signed by the redeemer key.
  const redeemerMcNexus = await toMultichainNexusAccount({
    signer: redeemerAccount,
    chainConfigurations: [
      {
        chain: base,
        transport,
        version: getMEEVersion(MEEVersion.V2_2_3),
        accountAddress,
      },
    ],
  });
  const redeemerMeeClient = await createMeeClient({
    account: redeemerMcNexus,
    apiKey: API_KEY,
  });

  // A plain ERC-20 transfer, well inside the session's cap and fully funded.
  const instructions = [
    {
      chainId: base.id,
      calls: [
        {
          to: USDC_BASE,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [signer.address, TRANSFER_AMOUNT],
          }),
        },
      ],
    },
  ];

  console.log("\n[2] USE: redeemer transfers 0.01 USDC with the session...");
  const useQuote = await redeemerMeeClient.getSessionQuote({
    mode: "USE",
    sessionDetails,
    instructions,
    sponsorship: true,
  });
  if (!useQuote) throw new Error("getSessionQuote USE returned no quote");
  console.log("  quote obtained (quote-time simulation passes)");

  // ❌ BREAKS HERE on MEE 2.2.3.
  //
  // executeSessionQuote submits and returns a hash, then the MEE node rejects the
  // redeemer-signed supertransaction and waitForSupertransactionReceipt throws:
  //
  //   Error: [0] Invalid signature
  //
  // Observed run (Base mainnet, 2026-09-01), account 0x9Cd6D8a41F4D341f70fedC68eAA24070d3b7A7f6:
  //   Phase 1 enable        -> MINED_SUCCESS, permissionId
  //                            0xb8412808fc379a9681afa5df2e8a4578b48a80a3863bca756dbd7be1cdfe0f33
  //                            (isPermissionEnabled reads true on-chain, so the session is live)
  //   Phase 2 USE quote     -> returned normally
  //   Phase 2 supertx       -> 0x7080cc514e1a85a6ff6f0d68780c925227d2c8461d53db8479d276e6d6fde951
  //                            rejected: "[0] Invalid signature"
  //
  // Notes from isolating this:
  //   • Not the policies — a session whose only policy is getSudoPolicy() fails identically.
  //   • Not the signature-format branch — signQuote picks EIP-712 SuperTx typed data for MEE
  //     >= 2.2.1 and personal-sign below it; both branches were forced, same rejection.
  //   • Not the SDK — this same 2.0.0 SDK redeems successfully against MEE 2.1.0 via
  //     getLegacyMEEVersion(MEEVersion.V2_1_0).
  //   • The quote-time simulation that "passes" above uses a MOCK signature (and mocks it
  //     with getOwnableValidatorMockSignature even though the session validator is MEE K1),
  //     so the real signature path is never simulated before the quote is accepted.
  //
  // The other redemption surface fails on 2.2.3 too: posting the quote request directly to
  // https://api.biconomy.io/v1/quote with meeVersion "2.2.3" is rejected at input validation,
  // because that API's accepted values are 3.0.0, 2.3.0, 2.2.1, 2.1.0, 2.0.0, 1.1.0, 1.0.0 —
  // 2.2.3 is not among them.
  const { hash: useHash } = await redeemerMeeClient.executeSessionQuote({
    quoteType: useQuote.quoteType,
    quote: useQuote.quote,
  });
  console.log("  supertransaction:", useHash);

  const useReceipt = await redeemerMeeClient.waitForSupertransactionReceipt({ hash: useHash });
  console.log("  status          :", useReceipt.transactionStatus);
  console.log("  account USDC    :", formatUnits(await usdcBalance(), USDC_DECIMALS));
  console.log("\nRedemption succeeded — the 2.2.3 issue appears to be fixed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
