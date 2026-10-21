/**
 * Drive the NFT TOOLS themselves (agent/tools.ts) against a local EVM, the
 * same way the model would: call mint_nft, then list_nfts, then get_nft and
 * list_nft_for_sale.
 *
 *   npm run test:nft-tools
 *
 * The chain is booted here, so the script is standalone: it needs no testnet
 * gas, no running server and no environment variables.
 */
import fs from "fs";
import path from "path";
import { bootNftChain } from "./nft-test-chain";

const root = process.cwd();

// The app resolves the deployed contract from .nft-contract.json; point it at
// the local deployment for the duration of the test and put it back after.
// The mint store and the metadata directory are restored the same way.
const contractFile = path.join(root, ".nft-contract.json");
const mintsFile = path.join(root, ".nft-mints.json");
const nftDir = path.join(root, ".nfts");

const savedContract = fs.existsSync(contractFile)
  ? fs.readFileSync(contractFile, "utf8")
  : null;
const savedMints = fs.existsSync(mintsFile)
  ? fs.readFileSync(mintsFile, "utf8")
  : null;
const savedNftDir = fs.existsSync(nftDir) ? fs.readdirSync(nftDir) : null;
const savedKey = process.env.WALLET_PRIVATE_KEY;

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
  restore(contractFile, savedContract);
  restore(mintsFile, savedMints);
  if (!savedNftDir && fs.existsSync(nftDir)) {
    fs.rmSync(nftDir, { recursive: true, force: true });
  }
  if (savedKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
  else process.env.WALLET_PRIVATE_KEY = savedKey;
});

// The tools import the chain config lazily, but the module-level constants
// (the ABI, the price cap) are read at import time — so import AFTER the
// env vars are set.
const { tools } = await import("@/agent/tools");
const { getNftContractAddress } = await import("@/agent/nft");

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`No tool named ${name}`);
  return t;
}

const ctx = { baseUrl: "http://localhost:3000" };

console.log("\n1. the tool surface carries the NFT tools");
for (const name of [
  "mint_nft",
  "list_nfts",
  "get_nft",
  "list_nft_for_sale",
  "buy_nft",
]) {
  assert(!!tool(name), `${name} is exposed to the model`);
}

console.log("\n2. mint_nft files a pending intent (no transaction)");
const prepared = (await tool("mint_nft").run(
  {
    name: "Two Cranes, One Invoice",
    description:
      "Two cranes and a single invoice for a job neither of them was hired for.",
    traits: [{ trait_type: "Uselessness", value: "Severe" }],
    prompt: "mint an NFT about two cranes",
  },
  ctx,
)) as Record<string, unknown>;
assert(prepared.status === "pending_user_approval", "the mint is pending approval");
assert(typeof prepared.mintId === "string", "it has a mint id");
assert(
  prepared.tokenUri === `http://localhost:3000/api/nfts/${prepared.mintId}`,
  "the tokenURI is the metadata route",
);
assert(prepared.contract === getNftContractAddress(), "it names the contract");
assert(
  (await chain.publicClient.readContract({
    address: chain.nftAddress,
    abi: (await import("@/agent/nft")).NFT_ABI,
    functionName: "totalSupply",
  })) === 0n,
  "nothing was minted on-chain yet",
);

console.log("\n3. list_nfts reports the contract state");
const listed = (await tool("list_nfts").run({}, ctx)) as Record<string, unknown>;
assert(listed.deployed === true, "the contract is deployed");
assert(Array.isArray(listed.nfts), "it lists the tokens");
assert(
  (listed.pendingMints as unknown[]).length >= 1,
  "the pending mint is in the list",
);

console.log("\n4. the price cap is enforced on the listing tool");
let refused = false;
try {
  await tool("list_nft_for_sale").run({ token_id: 1, price_usdc: 99 }, ctx);
} catch {
  refused = true;
}
assert(refused, "a 99 USDC listing is refused by the cap");

console.log("\n5. approving the mint puts a token on-chain, and get_nft reads it");
const nftModule = await import("@/agent/nft");
const minted = await nftModule.approveMint(prepared.mintId as string, {
  image: nftModule.placeholderImage("Two Cranes, One Invoice", prepared.mintId as string),
});
assert(minted.status === "minted", `the mint succeeded (${minted.reason ?? ""})`);
assert(minted.tokenId === 1, "it is token #1");

const got = (await tool("get_nft").run({ token_id: 1 }, ctx)) as Record<string, unknown>;
assert(got.tokenId === 1, "it read token #1");
assert(typeof got.tokenUri === "string", "it has the tokenURI");
assert(got.owner === chain.agent.address, "the agent owns it");

console.log("\nAll NFT tool checks passed.");
await chain.stop();
