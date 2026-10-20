/**
 * Empirically determine the USDC EIP-712 domain on Base Sepolia.
 *
 * Strategy: for each candidate domain, sign a transferWithAuthorization
 * message with the agent wallet, then eth_call (simulate) the contract.
 * A simulation that does NOT revert with "invalid signature" proves the
 * domain is correct. eth_call needs no gas, so this works with 0 ETH.
 */
import { createPublicClient, http, createWalletClient, parseAbiParameters, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import fs from "node:fs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;
const VALUE = 10_000n; // 0.01 USDC

const client = createPublicClient({ chain: baseSepolia, transport: http() });

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const TRANSFER_ABI = [
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
] as const;

function loadKey(): `0x${string}` {
  const fromEnv = process.env.WALLET_PRIVATE_KEY;
  if (fromEnv?.startsWith("0x")) return fromEnv.trim() as `0x${string}`;
  const stored = (
    JSON.parse(fs.readFileSync(".agent-wallet.json", "utf8")) as { privateKey: `0x${string}` }
  ).privateKey;
  return stored.trim() as `0x${string}`;
}

async function main() {
  const account = privateKeyToAccount(loadKey());
  console.log("signer:", account.address);
  console.log("USDC balance check (agent):", await client.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: [account.address],
  }));

  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: account.address,
    to: RECIPIENT,
    value: VALUE,
    validAfter: 0n,
    validBefore: now + 3600n,
    nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
  };

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

  const candidates: Array<{ name: string; version: string; chainId: number }> = [
    { name: "USDC", version: "2", chainId: 84532 },
    { name: "USD Coin", version: "2", chainId: 84532 },
    { name: "USDC", version: "1", chainId: 84532 },
    { name: "USD Coin", version: "1", chainId: 84532 },
    { name: "Fide", version: "1", chainId: 84532 },
    { name: "Fide", version: "2", chainId: 84532 },
    { name: "USDC", version: "2", chainId: 0 },
    { name: "USD Coin", version: "2", chainId: 0 },
  ];

  for (const c of candidates) {
    try {
      const signature = await wallet.signTypedData({
        domain: {
          name: c.name,
          version: c.version,
          chainId: c.chainId,
          verifyingContract: USDC,
        },
        types: TYPES,
        primaryType: "TransferWithAuthorization",
        message: authorization,
      });

      const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
      const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
      const v = Number.parseInt(signature.slice(130, 132), 16);

      const data = encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: "transferWithAuthorization",
        args: [
          authorization.from,
          authorization.to,
          authorization.value,
          authorization.validAfter,
          authorization.validBefore,
          authorization.nonce,
          v,
          r,
          s,
        ],
      });

      await client.call({ to: USDC, data, account: account.address });
      console.log(
        `  ✅ SIMULATION PASSED -> name=${JSON.stringify(c.name)} version=${JSON.stringify(c.version)} chainId=${c.chainId}`,
      );
    } catch (err) {
      const msg = (err as Error).message.replace(/\s+/g, " ").slice(0, 110);
      console.log(
        `  ❌ name=${JSON.stringify(c.name)} version=${JSON.stringify(c.version)} chainId=${c.chainId} -> ${msg}`,
      );
    }
  }
  void parseAbiParameters;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
