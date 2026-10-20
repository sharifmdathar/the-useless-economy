/**
 * GASLESS SETTLEMENT WITH RELAYER-COLLISION RECOVERY — Base Sepolia only.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The x402 facilitator is a shared public relayer. When two settlements land
 * in the same block, its relayer can pick a nonce it already has in flight
 * and the node rejects the send with "replacement transaction underpriced".
 * That is a RELAYER-side fault: our authorization is untouched and the money
 * has NOT moved.
 *
 * The naive fix — just retry — is dangerous in the other direction. If the
 * settlement DID land on-chain but the response never reached us, a blind
 * retry could pay the recipient twice. So before every retry we ask the
 * contract whether the authorization was actually spent.
 *
 * FiatTokenV2.authorizationState(owner, nonce) returns a bitmask:
 *   bit 0 -> the authorization was USED (the money already moved)
 *   bit 1 -> the authorization was CANCELED
 *
 * If the state is "unused" the nonce is still live and resubmitting the SAME
 * authorization is safe. If it is "used" we recover the real transaction hash
 * from the AuthorizationUsed event instead of paying again.
 *
 * The amount and destination can never change: they are locked into the
 * signature the payer already approved.
 */
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { USDC_ADDRESS } from "@/agent/usdc";
import {
  newNonce,
  settleWithFacilitator,
  signEip3009,
  type Eip3009Authorization,
  type FacilitatorResult,
} from "./facilitator";

/**
 * Has this EIP-3009 authorization already been spent?
 */
export async function authorizationStateOf(
  from: Address,
  nonce: Hex,
): Promise<"unused" | "used" | "canceled"> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const state = await client.readContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: "authorizationState",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "nonce", type: "bytes32" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "authorizationState",
    args: [from, nonce],
  });
  if (state & 1n) return "used";
  if (state & 2n) return "canceled";
  return "unused";
}

/**
 * Find the transaction that consumed a given authorization.
 *
 * Used to recover the tx hash when a settlement succeeded on-chain but the
 * facilitator's response never reached us. The AuthorizationUsed event
 * carries the nonce, so the transaction can be looked up.
 */
export async function findAuthorizationTx(
  from: Address,
  nonce: Hex,
): Promise<Hex | undefined> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const logs = await client.getLogs({
    address: USDC_ADDRESS,
    event: {
      type: "event",
      name: "AuthorizationUsed",
      inputs: [
        { name: "authorizer", type: "address", indexed: true },
        { name: "nonce", type: "bytes32", indexed: true },
      ],
    },
    args: { authorizer: from, nonce },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const last = logs[logs.length - 1];
  return last?.transactionHash as Hex | undefined;
}

/** Is this failure the facilitator's relayer colliding with itself? */
export function isRelayerCollision(error: string | undefined): boolean {
  if (!error) return false;
  return /underpriced|nonce too low|replacement transaction|already known/i.test(
    error,
  );
}

/**
 * Settle an authorization, recovering from the facilitator's relayer
 * nonce collisions.
 */
export async function settleWithFacilitatorRetry(args: {
  authorization: Eip3009Authorization;
  signature: Hex;
  resource?: string;
  description?: string;
  attempts?: number;
}): Promise<FacilitatorResult> {
  const {
    authorization,
    signature,
    resource = "https://the-useless-economy.local/transfer",
    description = "USDC transfer",
  } = args;
  const maxAttempts = Math.max(1, args.attempts ?? 3);
  let lastError = "Settlement failed.";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await settleWithFacilitator(
      authorization,
      signature,
      resource,
      description,
    );

    if (result.success && result.txHash) {
      return result;
    }

    lastError = result.error ?? "Settlement failed.";

    if (!isRelayerCollision(lastError)) break;

    // Did the money actually move despite the error? If so, recover the tx
    // rather than paying the recipient a second time.
    let state: "unused" | "used" | "canceled" = "unused";
    try {
      state = await authorizationStateOf(authorization.from, authorization.nonce);
    } catch {
      // If we cannot read the state, do NOT retry blindly — a blind retry
      // could double-pay. Surface the original error instead.
      break;
    }

    if (state === "used") {
      const found = await findAuthorizationTx(
        authorization.from,
        authorization.nonce,
      ).catch(() => undefined);
      return {
        success: true,
        txHash: found,
        payer: result.payer,
        error: found
          ? undefined
          : "Authorization was already used on-chain, but the transaction hash could not be recovered.",
      };
    }
    if (state === "canceled") {
      return {
        success: false,
        error: "The authorization was canceled on-chain and cannot be settled.",
      };
    }

    // Still unused: the relayer simply lost a nonce race. Wait a moment so
    // its pending transaction settles, then resubmit the same authorization.
    if (attempt === maxAttempts) break;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }

  return { success: false, error: lastError };
}

/**
 * Full gasless transfer: sign off-chain, settle via the facilitator, and
 * confirm the receipt. Returns the tx hash only after the chain reports
 * success.
 *
 * The authorization is signed ONCE and reused across retries. Signing again
 * with a fresh nonce would create a second spendable authorization for the
 * same money — so a retry could pay the recipient twice. The retry helper
 * above checks the contract's authorization state before resubmitting.
 */
export async function gaslessUsdcTransfer(args: {
  account: { address: Address; signTypedData: (args: any) => Promise<Hex> };
  to: Address;
  value: bigint;
  resource?: string;
  description?: string;
  attempts?: number;
}): Promise<FacilitatorResult> {
  if (baseSepolia.id !== 84532) {
    throw new Error(
      `Chain ID mismatch: expected 84532 (Base Sepolia), got ${baseSepolia.id}.`,
    );
  }

  const authorization: Eip3009Authorization = {
    from: args.account.address,
    to: args.to,
    value: args.value,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
    nonce: newNonce(),
  };

  const signature = await signEip3009(args.account, authorization);
  const result = await settleWithFacilitatorRetry({
    authorization,
    signature,
    resource: args.resource,
    description: args.description,
    attempts: args.attempts,
  });

  if (!result.success || !result.txHash) {
    return { success: false, error: result.error ?? "Settlement failed." };
  }

  // Confirm the chain actually accepted it before reporting success.
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const receipt = await client.waitForTransactionReceipt({
    hash: result.txHash,
    timeout: 60_000,
  });
  if (receipt.status !== "success") {
    return {
      success: false,
      txHash: result.txHash,
      error: `Transaction reverted on chain (status=${receipt.status}).`,
    };
  }
  return { success: true, txHash: result.txHash, payer: result.payer };
}
