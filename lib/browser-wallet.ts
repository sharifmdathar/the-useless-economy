/**
 * THE USER'S CONNECTED WALLET (browser side).
 *
 * Week 2 says the agent should be able to send tokens "either from the user's
 * connected wallet or from the AI agent's own wallet". The agent-wallet path
 * is server-side. This is the user-wallet path: an EIP-1193 injected provider
 * (MetaMask, Rabby, Brave, …) that the browser talks to directly.
 *
 * viem is already a dependency, so there is no need to pull in wagmi or
 * RainbowKit just to reach window.ethereum. `custom(window.ethereum)` gives
 * viem a transport over the injected provider; everything else (chain id
 * check, ERC-20 encoding, tx hash) comes from viem as usual.
 *
 * Nothing here touches a private key: the wallet extension holds it and the
 * user approves in their own UI. This file only asks the provider to do it.
 */
"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

/** Ask the browser for the user's addresses. Returns [] if declined. */
export async function connectWallet(): Promise<Address[]> {
  if (!hasInjectedWallet()) {
    throw new Error(
      "No browser wallet found. Install MetaMask (or another EIP-1193 wallet) to send from your own wallet.",
    );
  }
  const provider = window.ethereum as EIP1193Provider;
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as Address[];
  return accounts ?? [];
}

/** The wallet's current chain id, as a number. */
export async function getChainId(): Promise<number> {
  const provider = window.ethereum as EIP1193Provider;
  const hex = (await provider.request({ method: "eth_chainId" })) as Hex;
  return Number.parseInt(hex, 16);
}

function getWalletClient() {
  const provider = window.ethereum as EIP1193Provider;
  return createWalletClient({
    chain: baseSepolia,
    transport: custom(provider),
  });
}

/**
 * Switch the user's wallet to Base Sepolia. MetaMask-family wallets expose
 * wallet_switchEthereumChain; if it is missing we surface a clear error
 * rather than a confusing "chain mismatch" further down.
 */
export async function switchToBaseSepolia(): Promise<void> {
  const provider = window.ethereum as EIP1193Provider;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }], // 84532
    });
  } catch {
    throw new Error(
      "Could not switch your wallet to Base Sepolia. Switch networks manually and try again.",
    );
  }
}

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const USDC_ADDRESS_BASE_SEPOLIA: Address =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Send from the user's connected wallet.
 *
 * `isNative` sends the raw asset; an ERC-20 is encoded as a `transfer` call
 * and sent to the token contract. The wallet extension shows its own
 * confirmation dialog, which is the user authorizing the transaction.
 */
export async function sendFromUserWallet(args: {
  from: Address;
  to: Address;
  amount: number | string;
  token: "USDC" | "ETH";
}): Promise<{ txHash: Hex }> {
  const chainId = await getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    await switchToBaseSepolia();
  }

  const client = getWalletClient();
  const isNative = args.token === "ETH";
  const decimals = isNative ? 18 : 6;
  const value = parseUnits(String(args.amount), decimals);

  if (isNative) {
    const hash = await client.sendTransaction({
      account: args.from,
      to: args.to,
      value,
      chain: baseSepolia,
    });
    return { txHash: hash };
  }

  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [args.to, value],
  });
  const hash = await client.sendTransaction({
    account: args.from,
    to: USDC_ADDRESS_BASE_SEPOLIA,
    data,
    chain: baseSepolia,
  });
  return { txHash: hash };
}

/** The user's USDC balance on Base Sepolia. */
export async function getUserUsdcBalance(
  address: Address,
): Promise<string> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const balance = await client.readContract({
    address: USDC_ADDRESS_BASE_SEPOLIA,
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
  return formatUnits(balance, 6);
}
