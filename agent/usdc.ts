/**
 * USDC CONSTANTS — a leaf module with no imports of its own.
 *
 * These live apart from agent/wallet.ts so that the gasless facilitator
 * (lib/facilitator.ts) and the token registry (agent/tokens.ts) can both use
 * them without creating an import cycle through wallet.ts.
 *
 * TESTNET ONLY — Circle's Base Sepolia USDC.
 */
import type { Address } from "viem";

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Circle's testnet USDC on Base Sepolia. */
export const USDC_ADDRESS: Address =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;

/**
 * EIP-712 domain for Base Sepolia USDC.
 *
 * The name MUST be "USDC" — that is what the Base Sepolia contract's own
 * `name()` returns. The commonly-copied "USD Coin" pair (correct for
 * Ethereum mainnet USDC) produces signatures the contract rejects with
 * "FiatTokenV2: invalid signature". Proved by eth_call simulation against
 * the live contract; see scripts/check-domain.ts.
 */
export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: BASE_SEPOLIA_CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const;
