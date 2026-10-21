/**
 * END-TO-END test of the NFT desk (agent/nft.ts) against a LOCAL EVM.
 *
 * This drives the SAME code the app runs — the same module, the same tools'
 * functions, the same contract — against a local chain, because a Base
 * Sepolia deployment needs testnet gas that this repo's wallets do not hold.
 *
 *   npm run test:nft-app
 *
 * It proves the whole path:
 *   1. the agent files a pending mint (nothing signed);
 *   2. the user approves it with an image -> the metadata is written and the
 *      contract's mint() is called;
 *   3. the token exists on-chain, owned by the recipient, with the URI the
 *      metadata route serves;
 *   4. the provider lists it for sale;
 *   5. a third party buys it with USDC -> ownership AND money both move.
 */
import fs from "fs";
import path from "path";
import { bootNftChain, USDC_ADDRESS } from "./nft-test-chain";

const root = process.cwd();

// Files the app writes at runtime. They are gitignored, but the test still
// puts them back the way it found them.
const contractFile = path.join(root, ".nft-contract.json");
const mintsFile = path.join(root, ".nft-mints.json");
const nftDir = path.join(root, ".nfts");

function snapshot(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

const saved = {
  contract: snapshot(contractFile),
  mints: snapshot(mintsFile),
  nftDir: fs.existsSync(nftDir) ? fs.readdirSync(nftDir) : null,
  walletKey: process.env.WALLET_PRIVATE_KEY,
};

function restore(file: string, contents: string | null) {
  if (contents) fs.writeFileSync(file, contents);
  else if (fs.existsSync(file)) fs.unlinkSync(file);
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("  ok  " + msg);
}

const chain = await bootNftChain();
fs.writeFileSync(
  contractFile,
  JSON.stringify({ address: chain.nftAddress, chainId: 1337 }, null, 2),
);
chain.useAppKeys();

process.on("exit", () => {
  restore(contractFile, saved.contract);
  restore(mintsFile, saved.mints);
  if (!saved.nftDir && fs.existsSync(nftDir)) {
    fs.rmSync(nftDir, { recursive: true, force: true });
  }
  if (saved.walletKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
  else process.env.WALLET_PRIVATE_KEY = saved.walletKey;
});

const nft = await import("@/agent/nft");
const { agent, provider, buyer } = chain;

console.log("\n1. the agent files a pending mint");
const pending = await nft.createPendingMint({
  name: "Sunset Withdrawn From Service",
  description: "A sunset that has been told its shift is over.",
  traits: [
    { trait_type: "Uselessness", value: "High" },
    { trait_type: "Provider", value: "Soleil" },
  ],
  prompt: "mint an NFT about a sunset that is out of service",
});
assert(pending.status === "pending", "the mint is pending");
assert(pending.recipient === agent.address, "it defaults to the agent's wallet");
const onChainBefore = await chain.publicClient.readContract({
  address: chain.nftAddress,
  abi: nft.NFT_ABI,
  functionName: "totalSupply",
});
assert(onChainBefore === 0n, "nothing was minted on-chain yet");

console.log("\n2. the user approves it with an image");
const image =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const minted = await nft.approveMint(pending.id, {
  name: "Sunset Withdrawn From Service",
  description: "A sunset that has been told its shift is over.",
  traits: pending.traits,
  image,
});
assert(minted.status === "minted", `the mint succeeded (${minted.reason ?? ""})`);
assert(minted.tokenId === 1, "it is token #1");
assert(!!minted.txHash, "a transaction hash was recorded");
assert(
  minted.tokenUri === `http://localhost:3000/api/nfts/${pending.id}`,
  "the tokenURI points at the metadata route",
);

console.log("\n3. the metadata is on disk, with the image");
const metadata = nft.readMetadata(pending.id);
assert(!!metadata, "the metadata document exists");
assert(metadata!.image === image, "the uploaded image is embedded");
assert(metadata!.attributes.length === 2, "both traits are stored");
assert(
  metadata!.name === "Sunset Withdrawn From Service",
  "the name is stored",
);

console.log("\n4. the chain agrees");
const list = await nft.listOnChainNfts();
assert(list.length === 1, "the contract reports one token");
assert(list[0].owner === agent.address, "the agent owns it");
assert(list[0].tokenUri === minted.tokenUri, "the URI matches");

console.log("\n5. the provider lists it for 0.05 USDC");
chain.useAppKeys(chain.providerKey);
// The provider does not own the agent's token, so listing must be refused.
let refused = false;
try {
  await nft.listNftForSale(1, 0.05);
} catch {
  refused = true;
}
assert(refused, "a non-owner cannot list the token");

// Mint one to the provider (the agent is the minter) and list that one.
chain.useAppKeys(chain.agentKey);
const providerMint = await nft.createPendingMint({
  name: "Pigeon, Counting Itself",
  description: "A pigeon that has been asked to count and is unconvinced.",
  recipient: provider.address,
});
const providerToken = await nft.approveMint(providerMint.id, {
  image: nft.placeholderImage("Pigeon, Counting Itself", providerMint.id),
});
assert(providerToken.status === "minted", "the provider's token was minted");
assert(providerToken.tokenId === 2, "it is token #2");
assert(
  providerToken.recipient === provider.address,
  "the provider owns token #2",
);

chain.useAppKeys(chain.providerKey);
const listed = await nft.listNftForSale(2, 0.05);
assert(!!listed.txHash, "the listing transaction went through");
const afterList = await nft.listOnChainNfts();
assert(afterList[1].listed === true, "token #2 is for sale");
assert(afterList[1].priceUsdc === "0.05", "the price is 0.05 USDC");

console.log("\n6. a buyer buys it with USDC");
chain.useAppKeys(chain.buyerKey);
const bought = await nft.buyNft(2);
assert(!!bought.txHash, "the purchase transaction went through");
assert(bought.priceUsdc === "0.05", "it cost 0.05 USDC");
const afterBuy = await nft.listOnChainNfts();
assert(afterBuy[1].owner === buyer.address, "the buyer owns token #2");
assert(afterBuy[1].listed === false, "the listing is closed");

const providerUsdc = await chain.publicClient.readContract({
  address: USDC_ADDRESS,
  abi: [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
  functionName: "balanceOf",
  args: [provider.address],
});
assert(providerUsdc === 50_000n, "the seller was paid 0.05 USDC");

console.log("\nAll NFT app-layer checks passed on the local EVM.");
await chain.stop();
