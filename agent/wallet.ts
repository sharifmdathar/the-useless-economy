/**
 * THE AGENT'S WALLET — real x402 payments on Base Sepolia (testnet only).
 *
 * Flow (EIP-3009, the scheme USDC actually supports):
 *   1. Agent calls a provider API      -> 402 Payment Required (price + payTo + asset)
 *   2. Agent signs a USDC transferWithAuthorization typed-data signature
 *   3. Agent retries with X-PAYMENT    -> provider verifies the signature,
 *      settles via USDC.transferWithAuthorization on-chain, and returns an
 *      X-PAYMENT-RESPONSE body { settledTx } so both sides can ledger the txHash.
 *
 * TESTNET ONLY: the chain is hard-pinned to baseSepolia everywhere. The key is
 * loaded from .agent-wallet.json (or .env) and is never logged or echoed.
 * A provider settlement key can live in .provider-wallet.json so the "provider
 * balance rises" test is a real, distinct account.
 */
import fs from "fs";
import path from "path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const WALLET_FILE = path.join(process.cwd(), ".agent-wallet.json");
const PROVIDER_WALLET_FILE = path.join(process.cwd(), ".provider-wallet.json");
const chain = baseSepolia; // TESTNET ONLY — never swap for mainnet

// Circle's testnet USDC on Base Sepolia.
export const USDC_ADDRESS: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;

// USDC ABI trimmed to the functions used here.
const USDC_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type X402Requirement = { price: string; asset: Address; payTo: Address; resource: string };

export type X402PaymentBody = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export const X402_DOMAIN = { name: "USD Coin", version: "2", chainId: chain.id, verifyingContract: USDC_ADDRESS } as const;
export const X402_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function getPublicClient() {
  return createPublicClient({ chain, transport: http() });
}

function loadKey(file: string, envVar: string): Hex | null {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.startsWith("0x")) return fromEnv.trim() as Hex;
  try {
    const stored = (JSON.parse(fs.readFileSync(file, "utf8")) as { privateKey: Hex }).privateKey;
    return stored && stored.startsWith("0x") ? (stored.trim() as Hex) : null;
  } catch {
    return null;
  }
}

/** The agent's own wallet from .env or .agent-wallet.json, or null if none yet. */
function loadAccount() {
  const key = loadKey(WALLET_FILE, "WALLET_PRIVATE_KEY");
  return key ? privateKeyToAccount(key) : null;
}

function requireAccount() {
  const account = loadAccount();
  if (!account) throw new Error("The agent has no wallet yet. Ask the user to click 'Create wallet' first.");
  return account;
}

/** The provider-side settlement wallet (distinct so balances move visibly). */
function loadProviderAccount() {
  const key = loadKey(PROVIDER_WALLET_FILE, "PROVIDER_PRIVATE_KEY");
  return key ? privateKeyToAccount(key) : null;
}

/** Make a brand new wallet and save it (idempotent). */
export function createWallet() {
  if (loadAccount()) return getWalletAddress();
  const privateKey = generatePrivateKey();
  fs.writeFileSync(WALLET_FILE, JSON.stringify({ privateKey }, null, 2));
  return privateKeyToAccount(privateKey).address;
}

/** Create (or reuse) the provider settlement wallet. */
export function createProviderWallet() {
  if (loadProviderAccount()) return loadProviderAccount()!.address;
  const privateKey = generatePrivateKey();
  fs.writeFileSync(PROVIDER_WALLET_FILE, JSON.stringify({ privateKey }, null, 2));
  return privateKeyToAccount(privateKey).address;
}

export function getWalletAddress() {
  return loadAccount()?.address ?? null;
}

export function getProviderWalletAddress(): Address | null {
  return loadProviderAccount()?.address ?? null;
}

export async function getWalletBalance() {
  const wei = await getPublicClient().getBalance({ address: requireAccount().address });
  return `${formatEther(wei)} ETH`;
}

/** USDC balance of any address (testnet USDC, 6 decimals). */
export async function getUsdcBalance(address: Address): Promise<string> {
  const raw = await getPublicClient().readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(raw, USDC_DECIMALS);
}

// ─── buyer side ───

function parseHeader(header: string): { payment: X402PaymentBody; signature: Hex; asset: Address; resource: string } {
  const parsed = JSON.parse(Buffer.from(header, "base64").toString()) as {
    scheme: string;
    payment: Omit<X402PaymentBody, "value"> & { value: string };
    signature: Hex;
    asset: Address;
    resource: string;
  };
  // The X-PAYMENT header carries value as a decimal string (JSON cannot hold
  // bigint); convert back so seller-side typed-data verification sees the same
  // message the buyer signed.
  return { ...parsed, payment: { ...parsed.payment, value: BigInt(parsed.payment.value) } };
}

/**
 * Fetch a URL. If it demands payment (402 + x402 requirements), sign an
 * EIP-3009 USDC authorization with the agent's wallet and retry once with
 * X-PAYMENT. Returns the deliverable plus settlement info (incl. tx hash).
 */
export async function payAndFetch(url: string, opts?: { maxPrice?: number }) {
  const first = await fetch(url);
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`Provider ${first.status}: ${(await first.text()).slice(0, 200)}`);
    return { data: await first.json() };
  }

  const req = (await first.json()) as X402Requirement;
  const price = Number(req.price);
  if (Number.isNaN(price) || price <= 0) throw new Error("Provider 402 did not include a parseable positive price.");

  // Hard cap stays buyer-side: never sign an authorization above the cap.
  if (opts?.maxPrice != null && price > opts.maxPrice) {
    throw new Error(`Provider asks ${price} USDC, above the ${opts.maxPrice} cap. Refusing to pay.`);
  }

  const account = requireAccount();
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // ~1h window
  const nonce = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").slice(0, 32);
  const value = BigInt(Math.round(price * 10 ** USDC_DECIMALS));

  const message: X402PaymentBody = {
    from: account.address,
    to: req.payTo as Address,
    value,
    validAfter,
    validBefore,
    // bytes32 nonce for EIP-3009
    nonce: `0x${nonce}` as Hex,
  };

  // viem signs typed data with the account's key locally (never sends the key).
  const signature = await createWalletClient({ account, chain, transport: http() }).signTypedData({
    domain: X402_DOMAIN,
    types: X402_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });
  const header = Buffer.from(
    JSON.stringify({
      scheme: "eip3009",
      payment: { ...message, value: value.toString() }, // JSON-safe
      signature,
      asset: req.asset,
      resource: req.resource,
    }),
  ).toString("base64");

  const paid = await fetch(url, { headers: { "X-PAYMENT": header } });
  const body = (await paid.json().catch(() => ({}))) as { settledTx?: string; error?: string };
  return {
    data: body,
    payment:
      paid.status === 200
        ? { status: "settled" as const, amount: `${price} USDC`, to: req.payTo, tx: body.settledTx }
        : { status: "rejected" as const, httpStatus: paid.status, body },
  };
}

// ─── seller side ───

/**
 * Verify an X-PAYMENT header locally: a well-signed, unexpired EIP-3009
 * authorization from the holder. Settlement happens on-chain afterwards.
 */
export async function verifyPayment(header: string | null) {
  if (!header) return null;
  try {
    const { payment, signature } = parseHeader(header);
    if (payment.validBefore <= BigInt(Math.floor(Date.now() / 1000))) return null; // expired
    if (payment.to.toLowerCase() === payment.from.toLowerCase()) return null; // self-pay nonsense

    // viem's verify typed data: recovers the signer and compares to payment.from.
    const { verifyTypedData } = await import("viem");
    const ok = await verifyTypedData({
      address: payment.from,
      domain: X402_DOMAIN,
      types: X402_TYPES,
      primaryType: "TransferWithAuthorization",
      message: payment,
      signature,
    });
    return ok ? payment : null;
  } catch {
    return null;
  }
}

/**
 * Provider settles straight from the incoming request header: verify, then
 * broadcast transferWithAuthorization with the buyer's signature components.
 * Returns the on-chain settlement tx hash.
 */
export async function settlePaymentFromHeader(header: string): Promise<{ tx: Hex; payment: X402PaymentBody }> {
  const payment = await verifyPayment(header);
  if (!payment) throw new Error("Invalid or expired X-PAYMENT authorization.");

  const account = loadProviderAccount() ?? loadAccount();
  if (!account) throw new Error("No settlement wallet available.");

  const { signature } = parseHeader(header);
  // Split r/s/v from the 65-byte hex signature: 32B r, 32B s, 1B v.
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  const tx = await createWalletClient({ account, chain, transport: http() }).writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "transferWithAuthorization",
    args: [payment.from, payment.to, payment.value, payment.validAfter, payment.validBefore, payment.nonce, v, r, s],
  });
  return { tx, payment };
}
