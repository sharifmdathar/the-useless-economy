/**
 * THE TOKEN REGISTRY — what the agent is allowed to move, and how.
 *
 * Week 2's core requirement is prompt-based crypto transfers, so the agent
 * needs a hard-coded, validated notion of "a token": a symbol, a contract
 * address, a decimal count, and whether it is native. The LLM extracts the
 * token/amount/recipient from the user's prompt; THIS file decides whether
 * the extracted values are legal before anything is signed.
 *
 * The split matters: the model is good at reading "send 10 USDC to 0x…"
 * and bad at guaranteeing the result is safe. Parsing is the model's job;
 * validation is the code's job.
 *
 * TESTNET ONLY — every entry here is a Base Sepolia asset. Adding a mainnet
 * address here would be a one-line mistake with real money attached, so
 * assertTestnet() in tools.ts re-checks the chain id at call time.
 */
import { isAddress, parseUnits, formatUnits, type Address } from "viem";
import { USDC_ADDRESS, USDC_DECIMALS } from "./usdc";

export type TokenSymbol = "USDC" | "ETH";

export type TokenDef = {
  symbol: TokenSymbol;
  /** Human name shown in the review card. */
  name: string;
  /** ERC-20 contract address, or null for the native asset. */
  address: Address | null;
  decimals: number;
  isNative: boolean;
};

export const TOKENS: Record<TokenSymbol, TokenDef> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: USDC_ADDRESS,
    decimals: USDC_DECIMALS,
    isNative: false,
  },
  ETH: {
    symbol: "ETH",
    name: "Ether",
    address: null,
    decimals: 18,
    isNative: true,
  },
};

export const SUPPORTED_TOKENS = Object.keys(TOKENS) as TokenSymbol[];

/** Loose symbol matching: "usdc", "USDC", "usd coin", "ether", "eth". */
const ALIASES: Record<string, TokenSymbol> = {
  usdc: "USDC",
  "usd coin": "USDC",
  usdcoin: "USDC",
  eth: "ETH",
  ether: "ETH",
  ethereum: "ETH",
};

/** Resolve a user/LLM-supplied token name to a supported token, or null. */
export function resolveToken(input: string): TokenDef | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (key in ALIASES) return TOKENS[ALIASES[key]];
  const upper = key.toUpperCase();
  if (upper in TOKENS) return TOKENS[upper as TokenSymbol];
  return null;
}

/**
 * Validate a recipient address. EIP-55 checksum is enforced for mixed-case
 * input (viem's isAddress does this), so a mistyped address is caught before
 * funds go to a black hole.
 */
export function isValidRecipient(address: string): address is Address {
  if (!address || !address.startsWith("0x")) return false;
  return isAddress(address, { strict: true });
}

/**
 * Parse a human amount ("10", "0.5", "1.25") into base units.
 * Returns null on anything non-numeric, non-finite, <= 0, or with more
 * decimal places than the token supports (which would silently truncate).
 */
export function toBaseUnits(
  amount: number | string,
  decimals: number,
): bigint | null {
  let value: number;
  if (typeof amount === "string") {
    const trimmed = amount.trim();
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
      return null;
    }
    value = Number(trimmed);
  } else {
    value = amount;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  // Reject values that lose precision at this token's decimals.
  const scaled = value * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
  const units = BigInt(Math.round(scaled));
  if (units <= 0n) return null;
  return units;
}

/** Base units -> a human decimal string, e.g. "10" or "0.5". */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const s = formatUnits(units, decimals);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.0*$/, "");
}

/** Human amount -> base units, using the token's decimals. */
export function amountToUnits(
  token: TokenDef,
  amount: number | string,
): bigint | null {
  return toBaseUnits(amount, token.decimals);
}

/** Base units -> human amount string, using the token's decimals. */
export function unitsToAmount(
  token: TokenDef,
  units: bigint,
): string {
  return fromBaseUnits(units, token.decimals);
}

/** parseUnits re-export for native ETH value encoding. */
export { parseUnits };
