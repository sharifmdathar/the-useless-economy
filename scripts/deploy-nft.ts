/**
 * Deploy UselessNFT to Base Sepolia and record the address.
 *
 *   npm run deploy:nft
 *
 * Requirements:
 *   - the agent wallet (`.agent-wallet.json` or WALLET_PRIVATE_KEY) holds a
 *     little Base Sepolia ETH, because a deployment is a transaction;
 *   - the compiled artifacts in contracts/ are up to date
 *     (`npm run compile:nft`).
 *
 * The deployment is written to `.nft-contract.json` (gitignored). The app
 * reads that file, so nothing else has to be configured — although
 * NFT_CONTRACT_ADDRESS overrides it.
 */
import fs from "fs";
import path from "path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 84532;
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const root = process.cwd();
const abi = JSON.parse(
  fs.readFileSync(path.join(root, "contracts", "UselessNFT.abi.json"), "utf8"),
);
const artifact = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts", "UselessNFT.bytecode.json"),
    "utf8",
  ),
);

function loadKey(): Hex {
  const fromEnv = process.env.WALLET_PRIVATE_KEY;
  if (fromEnv && fromEnv.startsWith("0x")) return fromEnv.trim() as Hex;
  const stored = (
    JSON.parse(fs.readFileSync(path.join(root, ".agent-wallet.json"), "utf8")) as {
      privateKey: Hex;
    }
  ).privateKey;
  if (!stored?.startsWith("0x")) {
    throw new Error("No agent wallet key found (.agent-wallet.json).");
  }
  return stored;
}

const account = privateKeyToAccount(loadKey());
const client = createWalletClient({ account, chain: baseSepolia, transport: http() });

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) {
  console.error(
    `The agent wallet ${account.address} holds 0 ETH on Base Sepolia. A deployment needs gas — fund it first (base-sepolia faucet) and run this again.`,
  );
  process.exit(1);
}
console.log(
  `Deploying UselessNFT from ${account.address} (balance ${balance} wei)`,
);

const hash = await client.deployContract({
  abi,
  bytecode: artifact.bytecode as Hex,
  args: [account.address, USDC_ADDRESS],
  chain: baseSepolia,
  account,
});

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error("The deployment transaction reverted.");
  process.exit(1);
}
const address = receipt.contractAddress;

const record = {
  address,
  txHash: hash,
  chainId: CHAIN_ID,
  network: "Base Sepolia (testnet)",
  deployer: account.address,
  minter: account.address,
  paymentToken: USDC_ADDRESS,
  compiler: artifact.compiler,
  deployedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(root, ".nft-contract.json"),
  JSON.stringify(record, null, 2) + "\n",
);

console.log("\nUselessNFT deployed.");
console.log("  address :", address);
console.log("  tx      :", hash);
console.log("  explorer:", `https://sepolia.basescan.org/address/${address}`);
console.log("  minter  :", account.address);
console.log("\nWrote .nft-contract.json — the app picks it up automatically.");
