/**
 * GASLESS SETTLEMENT VIA THE x402 FACILITATOR — Base Sepolia only.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent wallet holds USDC but no ETH, so it cannot pay gas. A direct
 * `USDC.transfer(...)` from that wallet fails with:
 *
 *     gas required exceeds allowance (0)
 *
 * EIP-3009 solves this: the holder signs an authorization OFF-CHAIN (free)
 * and a third party broadcasts it while paying the gas. The x402 facilitator
 * is exactly that third party, and it supports `eip155:84532` (Base Sepolia).
 *
 * The facilitator can only spend what the signature authorizes — it cannot
 * change the amount or the destination. So the user-facing guarantee holds:
 * the agent signs off-chain, the facilitator only broadcasts.
 *
 * TESTNET ONLY — Base Sepolia (chain id 84532) hard-checked below.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_CHAIN_ID,
  USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_EIP712_DOMAIN,
} from "@/agent/usdc";

/** Base Sepolia — TESTNET ONLY. */
const CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;
const NETWORK = "eip155:84532" as const;

/** Default facilitator. Override with X402_FACILITATOR_URL. */
export const FACILITATOR_URL = (
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator"
).replace(/\/+$/, "");

export { USDC_EIP712_DOMAIN };

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Eip3009Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export type FacilitatorResult = {
  success: boolean;
  txHash?: Hex;
  payer?: Address;
  error?: string;
};

/** Fresh 32-byte nonce for an EIP-3009 authorization (one-time use). */
export function newNonce(): Hex {
  // Must be exactly 32 bytes (64 hex chars) — viem rejects a bytes16 here.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Unix seconds right now. */
function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Sign an EIP-3009 authorization off-chain. This costs no gas and moves no
 * funds — it only authorizes the facilitator to broadcast on our behalf.
 */
export async function signEip3009(
  account: { address: Address; signTypedData: (args: any) => Promise<Hex> },
  authorization: Eip3009Authorization,
): Promise<Hex> {
  const client = createWalletClient({
    account: account as never,
    chain: baseSepolia,
    transport: http(),
  });
  return client.signTypedData({
    domain: USDC_EIP712_DOMAIN,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  });
}

function buildPaymentPayload(
  authorization: Eip3009Authorization,
  signature: Hex,
  resource: string,
  description: string,
) {
  return {
    x402Version: 2,
    resource: {
      url: resource,
      description,
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: NETWORK,
      amount: authorization.value.toString(),
      asset: USDC_ADDRESS,
      payTo: authorization.to,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "eip3009",
        name: USDC_EIP712_DOMAIN.name,
        version: USDC_EIP712_DOMAIN.version,
      },
    },
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
}

function buildPaymentRequirements(authorization: Eip3009Authorization) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: authorization.value.toString(),
    asset: USDC_ADDRESS,
    payTo: authorization.to,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "eip3009",
      name: USDC_EIP712_DOMAIN.name,
      version: USDC_EIP712_DOMAIN.version,
    },
  };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Facilitator ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  return { status: res.status, json };
}

/**
 * Ask the facilitator to VERIFY an authorization (read-only, no state change).
 * Useful as a pre-flight check before asking the user to approve.
 */
export async function verifyWithFacilitator(
  authorization: Eip3009Authorization,
  signature: Hex,
  resource = "https://the-useless-economy.local/transfer",
  description = "USDC transfer",
): Promise<{ valid: boolean; reason?: string; payer?: Address }> {
  const body = {
    x402Version: 2,
    paymentPayload: buildPaymentPayload(
      authorization,
      signature,
      resource,
      description,
    ),
    paymentRequirements: buildPaymentRequirements(authorization),
  };
  const { json } = await post("/verify", body);
  return {
    valid: json.isValid === true,
    reason: typeof json.invalidReason === "string" ? json.invalidReason : undefined,
    payer: typeof json.payer === "string" ? (json.payer as Address) : undefined,
  };
}

/**
 * Settle an EIP-3009 authorization through the facilitator. The facilitator
 * broadcasts the transferWithAuthorization and pays the gas.
 */
export async function settleWithFacilitator(
  authorization: Eip3009Authorization,
  signature: Hex,
  resource = "https://the-useless-economy.local/transfer",
  description = "USDC transfer",
): Promise<FacilitatorResult> {
  const body = {
    x402Version: 2,
    paymentPayload: buildPaymentPayload(
      authorization,
      signature,
      resource,
      description,
    ),
    paymentRequirements: buildPaymentRequirements(authorization),
  };
  const { json } = await post("/settle", body);
  if (json.success === true && typeof json.transaction === "string") {
    return {
      success: true,
      txHash: json.transaction as Hex,
      payer: typeof json.payer === "string" ? (json.payer as Address) : undefined,
    };
  }
  return {
    success: false,
    error:
      (typeof json.errorMessage === "string" && json.errorMessage) ||
      (typeof json.errorReason === "string" && json.errorReason) ||
      "Facilitator settlement failed.",
    payer: typeof json.payer === "string" ? (json.payer as Address) : undefined,
  };
}

/**
 * Full gasless transfer: sign off-chain, settle via the facilitator, and
 * confirm the receipt. Returns the tx hash only after the chain reports
 * success.
 */
export async function gaslessUsdcTransfer(args: {
  account: { address: Address; signTypedData: (args: any) => Promise<Hex> };
  to: Address;
  value: bigint;
  resource?: string;
  description?: string;
}): Promise<FacilitatorResult> {
  if (baseSepolia.id !== CHAIN_ID) {
    throw new Error(
      `Chain ID mismatch: expected ${CHAIN_ID} (Base Sepolia), got ${baseSepolia.id}.`,
    );
  }

  const authorization: Eip3009Authorization = {
    from: args.account.address,
    to: args.to,
    value: args.value,
    validAfter: 0n,
    validBefore: nowSeconds() + 3600n,
    nonce: newNonce(),
  };

  const signature = await signEip3009(args.account, authorization);
  const result = await settleWithFacilitator(
    authorization,
    signature,
    args.resource,
    args.description,
  );
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

/** USDC balance of any address, as a decimal string. */
export async function usdcBalanceOf(address: Address): Promise<string> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [address],
  });
  const asString = raw.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = asString.slice(0, -USDC_DECIMALS);
  const frac = asString.slice(-USDC_DECIMALS);
  return `${whole}.${frac}`;
}
