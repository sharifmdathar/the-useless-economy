/**
 * EIP-1193 injected-provider types.
 *
 * The browser wallet (MetaMask, Rabby, Brave, …) injects `window.ethereum`.
 * viem ships its own EIP-1193 provider interface, but the global object
 * itself is not declared by TypeScript, so this file adds the one
 * declaration the app needs. Keeping it here (instead of touching the
 * project's global .d.ts) keeps the wallet surface self-contained.
 */
import type { EIP1193Provider } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export {};
