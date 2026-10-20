/**
 * Prove the gasless path: the agent wallet signs an EIP-3009
 * transferWithAuthorization (an OFF-CHAIN signature — costs no gas), and the
 * x402 facilitator broadcasts it while paying the gas.
 *
 * The agent wallet has 0 ETH, so a direct writeContract can never work.
 * This test uses eth_call (no gas) to check the signature, then asks the
 * facilitator to verify + settle for real.
 */
import { createPublicClient, http, createWalletClient, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import fs from "node:fs";
import { newNonce } from "@/lib/facilitator";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
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
  console.log("facilitator:", FACILITATOR);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: account.address,
    to: RECIPIENT,
    value: VALUE,
    validAfter: 0n,
    validBefore: now + 3600n,
    // Must be a FRESH nonce every run. EIP-3009 authorizations are one-time
    // use: once the contract has consumed one, re-submitting it reverts with
    // "FiatTokenV2: authorization is used or canceled".
    nonce: newNonce(),
  };

  // Domain name MUST be "USDC" for this contract (proved by simulation).
  const signature = await createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  }).signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  // 1) local simulation — proves the signature is valid on-chain
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
  try {
    await client.call({ to: USDC, data, account: account.address });
    console.log("✅ local simulation PASSED (signature valid on-chain)");
  } catch (err) {
    console.log("❌ local simulation FAILED:", (err as Error).message.slice(0, 200));
    return;
  }

  // 2) facilitator /verify
  const paymentPayload = {
    x402Version: 2,
    resource: {
      url: "https://the-useless-economy.local/transfer",
      description: "Transfer 0.01 USDC to the recipient",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: VALUE.toString(),
      asset: USDC,
      payTo: RECIPIENT,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "eip3009",
        name: "USDC",
        version: "2",
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

  const paymentRequirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: VALUE.toString(),
    asset: USDC,
    payTo: RECIPIENT,
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
  };

  const body = { x402Version: 2, paymentPayload, paymentRequirements };

  const verifyRes = await fetch(`${FACILITATOR}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const verifyJson = (await verifyRes.json()) as Record<string, unknown>;
  console.log(`facilitator /verify -> ${verifyRes.status}`, JSON.stringify(verifyJson).slice(0, 400));

  // 3) facilitator /settle (the facilitator pays the gas)
  const settleRes = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const settleJson = (await settleRes.json()) as Record<string, unknown>;
  console.log(`facilitator /settle -> ${settleRes.status}`, JSON.stringify(settleJson).slice(0, 600));

  const tx = settleJson.transaction as string | undefined;
  if (tx && tx !== "") {
    console.log("settlement tx:", tx);
    const receipt = await client.waitForTransactionReceipt({ hash: tx as `0x${string}`, timeout: 60_000 });
    console.log("receipt status:", receipt.status, "gas used:", receipt.gasUsed);
    const usdcAfter = await client.readContract({
      address: USDC,
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log("agent USDC after:", usdcAfter.toString());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
