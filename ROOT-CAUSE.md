# Root cause: smart-session redemption on MEE 2.2.3

`abstractjs` 2.0.0 signs session redemptions in **Simple mode** (`0x177eee00`, EIP-712
`SuperTx`). `K1MeeValidator.validateSignatureWithData` cannot validate that mode when the caller
is SmartSessions. It should use the **NoMee** flow instead.

This is already fixed in [abstractjs#201](https://github.com/bcnmy/abstractjs/pull/201), open and
unmerged since 2026-04-06.

## Symptom

| Phase | Result |
|---|---|
| Owner enables session (owner-signed, sponsored) | `MINED_SUCCESS`, `isPermissionEnabled` true on-chain |
| Session key redeems (`getSessionQuote({mode:"USE"})`) | node rejects: `[0] Invalid signature` |

Base mainnet, account `0x9Cd6D8a41F4D341f70fedC68eAA24070d3b7A7f6`, permission
`0xb8412808fc379a9681afa5df2e8a4578b48a80a3863bca756dbd7be1cdfe0f33`, USE supertx
`0x7080cc514e1a85a6ff6f0d68780c925227d2c8461d53db8479d276e6d6fde951`.
Nothing reaches the chain — the node rejects after its own simulation.

[Tenderly trace](https://dashboard.tenderly.co/shared/simulation/f00e485d-6d69-4b72-b4fe-4b1cdc177fd5)
of that simulation: `handleOps` → `AA24 signature error`. Every SmartSessions policy check passes.
The only failure is `isValidISessionValidator` → K1 `validateSignatureWithData` (`0x940d3840`) → `false`.

## Chain

```
abstractjs signs EIP-712 SuperTx(MeeUserOp[]) + 0x177eee00
  -> node wraps as SmartSession USE
  -> SmartSessions forwards the raw userOpHash to K1
  -> K1 Simple mode expects the timestamp-wrapped MeeUserOp item hash
  -> hashes differ -> SIG_VALIDATION_FAILED -> AA24 -> "[0] Invalid signature"
```

## Two incompatibilities in the Simple-mode stateless path

`validateSignatureWithData` routes straight to Simple mode with no adaptation
(`K1MeeValidator.sol:270` → `:329`).

**1. It expects the caller to pre-hash.** `SimpleValidatorLib.validateSignatureForOwner` uses
`dataHash` directly as the item hash — its own doc says *"Task to rehash data and provide the
dataHash lies on the protocol"*. SmartSessions passes the raw ERC-4337 userOpHash, so
`HashLib.compareAndGetFinalHash` fails its first check and returns `bytes32(0)`:

```solidity
if (currentItemHash != itemHashes[itemIndex]) { finalHash = bytes32(0); }
```

The `validateUserOp` path builds the item hash itself
(`MEEUserOpHashLib.getMeeUserOpEip712Hash(userOpHash, lower, upper)`), which is why owner-signed
supertransactions are unaffected.

**2. The EIP-712 domain comes from `msg.sender`.** `HashLib.hashTypedDataForAccount(msg.sender, …)`
calls `IERC5267(msg.sender).eip712Domain()`. Here `msg.sender` is the SmartSessions singleton
`0x00000000008bDABA73cD9815d79069c247Eb4bDA`, which does not implement ERC-5267 and reverts. This
is only reached if (1) is fixed first.

## Proof

Read-only `eth_call` against K1 `0x0000B1C0790E5a28293276C320d2B95D651dBaD6` on Base, using the
**exact envelope and signature** from the failed transaction, varying only `hash` and `msg.sender`:

| `hash` argument | `msg.sender` | Result |
|---|---|---|
| raw userOpHash `0x92d1b3d6…a60098` | SmartSessions | `false` — what happens on-chain |
| item hash `0x2f44a10b…174769a4` | SmartSessions | revert (no `eip712Domain()`) |
| raw userOpHash | smart account | `false` |
| item hash | smart account | **`true`** |

The signature is cryptographically valid throughout: it recovers to exactly the session redeemer
`0x95d20585595569BA9bC0580E86866e1942e3267C` over
`keccak(0x1901 ‖ domainSeparator(name="Nexus") ‖ hashStruct(SuperTx{meeUserOps:[op]}))`.
It is a valid signature for the wrong mode.

The submitted envelope is well-formed for Simple mode —
`0x177eee00 ‖ abi.encode(bytes32 outerTypeHash, uint256 itemIndex, bytes32[] itemHashes, bytes sig)`
with `outerTypeHash = SUPER_TX_MEE_USER_OP_ARRAY_TYPEHASH`, `itemIndex = 0`, and one item hash.
Nothing is malformed; the mode itself is wrong for this caller.

## NoMee is the mode that works

`NoMeeFlowLib.validateSignatureForOwner` is a plain ECDSA check over the passed hash — no item
hash, no `msg.sender` domain lookup. A bare 65-byte signature with **no** `0x177eee00` prefix,
called from SmartSessions, returns `true` (verified on Base, both raw and EIP-191 digests).

So K1 does support smart sessions. `abstractjs` just selects the wrong mode.

This matches the review comment on abstractjs#201:

> Currently the legacy smart sessions flow might break because it uses EIP 712 and our server goes
> with NoMeeMode.

## Why this is easy to miss

Quote-time simulation passes because it uses a mock signature — and mocks it with
`getOwnableValidatorMockSignature` even though the session validator is MEE K1. The real signature
path is never exercised before the quote is accepted.

## Version context

- SDK 2.0.0 accepts only `MEEVersion.V2_2_3` for new accounts (`SAFE_MEE_VERSIONS = ["2.2.3"]`);
  `V2_1_0` throws *"MEE version 2.1.0 cannot be used to create new accounts. Use 2.2.3."*
  So 2.2.3 is the default stack for anyone starting today, and sessions do not work on it.
- `V2_1_0` pins a different validator (`0x0000000031ef4155C978d48a8A7d4EDba03b04fE`), so that lane
  is unaffected. Session redemption works end to end there via `getLegacyMEEVersion`.
- From `V3_0_0`, `getSessionValidatorInitData` points sessions at a dedicated
  `EoaStatelessValidator` submodule instead of MEE K1 (`getSessionQuote.js:11-16`).

## Asks

1. Can abstractjs#201 be merged and published? It has been open since April.
2. We will not deploy legacy `V2_1_0` accounts, so `getLegacyMEEVersion` is not an option for us —
   and the SDK itself says 2.1.0 "cannot be used to create new accounts". What is the supported
   path to smart sessions for **new** accounts before #201 lands? Is `V3_0_0` with the
   `EoaStatelessValidator` submodule the intended stack, and is it available in a published SDK?
3. Should the node reject a Simple-mode signature on a session USE quote early, rather than
   accepting it and failing at execution?

## Repro

```bash
bun install
cp .env.example .env   # PRIVATE_KEY, MEE_API_KEY
bun run transfer.ts
```
