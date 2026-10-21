/**
 * THE NFT DESK — the agent's on-chain asset desk.
 *
 * Week 2's advanced brief asks for a DEPLOYED SMART CONTRACT that the agent
 * can call through its own tools, plus an interface where a human can upload
 * an image, name the token, write a description, attach metadata, and then
 * authorize the mint from inside the chat. This file is the server half of
 * that:
 *
 *   contracts/UselessNFT.sol   the contract (ERC-721 + a tiny marketplace)
 *   agent/nft.ts                this file — intents, metadata, contract calls
 *   agent/tools.ts              the tools the model calls
 *   app/api/nft/route.ts        the HTTP surface the chat card talks to
 *   components/nft-mint-card.tsx the in-chat interface
 *
 * THE SHAPE OF A MINT
 * -------------------
 * The same two-phase shape as a transfer, because the same reason applies:
 * the model is good at reading "mint an NFT called X" and bad at guaranteeing
 * the result is what the user wanted. So:
 *
 *   1. `mint_nft` VALIDATES the intent and files a PENDING mint. Nothing is
 *      sent, nothing is signed.
 *   2. The chat renders the MINT CARD. The user uploads an image, edits the
 *      name, the description and the traits, and presses Mint.
 *   3. Only then does the agent call `mint()` on the contract.
 *
 * The image and the metadata are written to disk BEFORE the contract call, so
 * the tokenURI the contract stores always resolves to real metadata.
 *
 * TESTNET ONLY. Base Sepolia by default; NFT_RPC_URL / NFT_CHAIN_ID exist so
 * the same code can be pointed at a local EVM for testing.
 */
import fs from "fs";
import path from "path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { loadAccountForTransfer, getWalletAddress } from "./wallet";
import { USDC_ADDRESS, USDC_DECIMALS } from "./usdc";
import { isValidRecipient } from "./tokens";

const CHAIN_ID = 84532; // Base Sepolia — TESTNET ONLY

const MINTS_PATH = path.join(process.cwd(), ".nft-mints.json");
const NFT_DIR = path.join(process.cwd(), ".nfts");
const CONTRACT_FILE = path.join(process.cwd(), ".nft-contract.json");

/**
 * The ABI, compiled from contracts/UselessNFT.sol and committed.
 *
 * Imported statically (rather than read with fs at runtime) so the Next.js
 * build traces and bundles it — a runtime fs read would work in `next dev`
 * and break in a production deployment.
 */
import NFT_ABI_JSON from "@/contracts/UselessNFT.abi.json";

const NFT_ABI = NFT_ABI_JSON as readonly unknown[];

/**
 * Per-purchase ceiling for an NFT the agent buys for itself.
 *
 * The economy's weekly cap governs commissions and tips; an NFT purchase is
 * agent spend too, so it gets its own, much tighter, ceiling. A prompt cannot
 * raise it.
 */
export const MAX_NFT_PRICE_USDC = Number(process.env.MAX_NFT_PRICE_USDC ?? 0.25);

/** Where the app is reachable — the host the tokenURI points at. */
export const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);

// ─── Chain plumbing ─────────────────────────────────────────────────────

/**
 * The chain the NFT desk talks to.
 *
 * Base Sepolia unless NFT_RPC_URL / NFT_CHAIN_ID say otherwise. The override
 * exists so the whole app (tools, API, card) can be exercised against a
 * local EVM — which is how `npm run test:nft-app` proves the flow without
 * needing testnet gas.
 */
function nftChain() {
  const url = process.env.NFT_RPC_URL;
  const id = Number(process.env.NFT_CHAIN_ID ?? CHAIN_ID);
  if (!url) {
    if (id !== CHAIN_ID) {
      throw new Error(
        `NFT_CHAIN_ID is ${id} but NFT_RPC_URL is not set — there is no RPC to talk to.`,
      );
    }
    return baseSepolia;
  }
  return defineChain({
    id,
    name: id === CHAIN_ID ? "Base Sepolia" : `Chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
}

export function getNftPublicClient() {
  return createPublicClient({
    chain: nftChain(),
    transport: http(process.env.NFT_RPC_URL ?? undefined),
  });
}

function getNftWalletClient() {
  const account = loadAccountForTransfer();
  return createWalletClient({
    account,
    chain: nftChain(),
    transport: http(process.env.NFT_RPC_URL ?? undefined),
  });
}

/**
 * The deployed UselessNFT address.
 *
 * Resolution order:
 *   1. NFT_CONTRACT_ADDRESS — the explicit env override.
 *   2. .nft-contract.json   — written by `npm run deploy:nft`.
 *   3. null                 — not deployed yet.
 *
 * Everything that touches the contract asks for this first, so a missing
 * deployment produces a clear message instead of a viem stack trace.
 */
export function getNftContractAddress(): Address | null {
  const fromEnv = process.env.NFT_CONTRACT_ADDRESS;
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return fromEnv as Address;
  try {
    const stored = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8")) as {
      address?: string;
    };
    if (stored.address && /^0x[0-9a-fA-F]{40}$/.test(stored.address)) {
      return stored.address as Address;
    }
  } catch {
    // no deployment record yet
  }
  return null;
}

export function requireNftContract(): Address {
  const address = getNftContractAddress();
  if (!address) {
    throw new Error(
      "UselessNFT is not deployed yet. Run `npm run deploy:nft` (needs Base Sepolia ETH for gas), or set NFT_CONTRACT_ADDRESS.",
    );
  }
  return address;
}

/** Is the NFT desk usable right now? */
export function nftStatus() {
  const address = getNftContractAddress();
  return {
    contract: address,
    deployed: Boolean(address),
    chainId: Number(process.env.NFT_CHAIN_ID ?? CHAIN_ID),
    network:
      Number(process.env.NFT_CHAIN_ID ?? CHAIN_ID) === CHAIN_ID
        ? "Base Sepolia (testnet)"
        : `chain ${process.env.NFT_CHAIN_ID}`,
    maxPriceUsdc: MAX_NFT_PRICE_USDC,
  };
}

// ─── The mint intent store ──────────────────────────────────────────────

export type MintStatus = "pending" | "minted" | "rejected" | "failed";

export type PendingMint = {
  id: string;
  createdAt: string;
  /** The user's original request, for the audit trail. */
  prompt: string;
  name: string;
  description: string;
  /** ERC-721 metadata attributes (trait_type / value). */
  traits: { trait_type: string; value: string }[];
  /** Who receives the token. */
  recipient: Address;
  status: MintStatus;
  /** Set once the contract call succeeded. */
  tokenId?: number;
  txHash?: Hex;
  tokenUri?: string;
  reason?: string;
};

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function readMints(): PendingMint[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(MINTS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as PendingMint[]) : [];
  } catch {
    return [];
  }
}

function writeMints(rows: PendingMint[]) {
  fs.writeFileSync(MINTS_PATH, JSON.stringify(rows, null, 2) + "\n");
}

export function listMints(status?: MintStatus): PendingMint[] {
  const rows = readMints();
  return status ? rows.filter((m) => m.status === status) : rows;
}

export function getMint(id: string): PendingMint | undefined {
  return readMints().find((m) => m.id === id);
}

/** The tokenURI for a mint id — the address the contract will store. */
export function tokenUriFor(mintId: string): string {
  return `${APP_URL}/api/nfts/${mintId}`;
}

// ─── Metadata on disk ───────────────────────────────────────────────────

export type NftMetadata = {
  name: string;
  description: string;
  image: string;
  attributes: { trait_type: string; value: string }[];
};

function metadataPath(mintId: string) {
  return path.join(NFT_DIR, `${mintId}.json`);
}

export function readMetadata(mintId: string): NftMetadata | null {
  try {
    return JSON.parse(
      fs.readFileSync(metadataPath(mintId), "utf8"),
    ) as NftMetadata;
  } catch {
    return null;
  }
}

/**
 * Write the token's metadata (and its image) to disk.
 *
 * The image is embedded in the metadata JSON as a data URI, so the metadata
 * document is self-contained: fetch the tokenURI and you get the picture with
 * it, with no second request and no dependency on a file server.
 */
export function writeMetadata(
  mintId: string,
  meta: Omit<NftMetadata, "image"> & { image?: string },
): NftMetadata {
  fs.mkdirSync(NFT_DIR, { recursive: true });
  const metadata: NftMetadata = {
    name: meta.name,
    description: meta.description,
    image: meta.image ?? "",
    attributes: meta.attributes ?? [],
  };
  fs.writeFileSync(metadataPath(mintId), JSON.stringify(metadata, null, 2) + "\n");
  return metadata;
}

/**
 * A deterministic placeholder image for a mint with no upload.
 *
 * An SVG rendered from the token's name — the agent can mint something
 * meaningful without the user supplying a picture, and the token is never
 * blank. It is written as a data URI so the metadata stays self-contained.
 */
export function placeholderImage(name: string, mintId: string): string {
  const hue = [...mintId].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const label = (name || "Useless").slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="hsl(${hue},70%,45%)"/>
    <stop offset="100%" stop-color="hsl(${(hue + 60) % 360},70%,25%)"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <circle cx="256" cy="200" r="86" fill="rgba(255,255,255,0.16)"/>
  <text x="256" y="330" font-family="monospace" font-size="30" fill="#fff" text-anchor="middle">${label.replace(
    /[<>&]/g,
    "",
  )}</text>
  <text x="256" y="380" font-family="monospace" font-size="22" fill="rgba(255,255,255,0.75)" text-anchor="middle">#${mintId}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ─── Minting ────────────────────────────────────────────────────────────

/**
 * File a PENDING mint. Nothing is signed, nothing is sent.
 *
 * The contract address is checked here so that "the contract is not
 * deployed" is reported at intent time rather than after the user has filled
 * in the whole form.
 */
export async function createPendingMint(args: {
  name: string;
  description?: string;
  recipient?: string;
  traits?: { trait_type: string; value: string }[];
  prompt?: string;
}): Promise<PendingMint> {
  if (process.env.KILL_SWITCH === "1") {
    throw new Error(
      "KILL_SWITCH is set — the economy is frozen. No NFTs will be minted.",
    );
  }
  requireNftContract();

  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("An NFT needs a name.");
  if (name.length > 120)
    throw new Error("That name is too long — keep it under 120 characters.");

  const description = String(args.description ?? "").trim().slice(0, 2000);

  // Default recipient: the agent's own wallet — the agent holds what it mints.
  const recipient = (args.recipient ?? getWalletAddress() ?? "").toString();
  if (!isValidRecipient(recipient)) {
    throw new Error(
      `"${recipient}" is not a valid EIP-55 checksum address. Nothing was minted.`,
    );
  }

  const traits = (args.traits ?? [])
    .filter((t) => t && String(t.trait_type ?? "").trim())
    .slice(0, 20)
    .map((t) => ({
      trait_type: String(t.trait_type).trim().slice(0, 64),
      value: String(t.value ?? "").trim().slice(0, 256),
    }));

  const mint: PendingMint = {
    id: `nft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    prompt: args.prompt ?? "",
    name,
    description,
    traits,
    recipient: recipient as Address,
    status: "pending",
  };

  await serialized(() => {
    const rows = readMints();
    rows.push(mint);
    writeMints(rows);
  });
  return mint;
}

/** Cancel a pending mint. Nothing was signed, so this is always safe. */
export async function rejectMint(
  id: string,
  reason = "Rejected by user.",
): Promise<PendingMint> {
  return serialized(() => {
    const rows = readMints();
    const row = rows.find((m) => m.id === id);
    if (!row) throw new Error(`No mint with id ${id}.`);
    if (row.status !== "pending")
      throw new Error(`Mint ${id} is already ${row.status}.`);
    row.status = "rejected";
    row.reason = reason;
    writeMints(rows);
    return row;
  });
}

/**
 * Execute a pending mint: write the metadata, then call `mint()` on the
 * contract with the agent's wallet.
 *
 * The metadata is written FIRST. If the contract call then fails, the
 * metadata is already on disk and the mint can be retried without the user
 * re-uploading anything.
 */
export async function approveMint(
  id: string,
  options?: {
    name?: string;
    description?: string;
    traits?: { trait_type: string; value: string }[];
    image?: string; // a data URI
  },
): Promise<PendingMint> {
  const row = getMint(id);
  if (!row) throw new Error(`No mint with id ${id}.`);
  if (row.status !== "pending")
    throw new Error(`Mint ${id} is ${row.status} and cannot be minted.`);
  if (process.env.KILL_SWITCH === "1") {
    throw new Error("KILL_SWITCH is set — the economy is frozen. Nothing was minted.");
  }
  const contract = requireNftContract();

  const name = (options?.name ?? row.name).trim().slice(0, 120) || row.name;
  const description = (options?.description ?? row.description)
    .trim()
    .slice(0, 2000);
  const traits = options?.traits ?? row.traits;
  const image = options?.image || placeholderImage(name, row.id);

  writeMetadata(row.id, { name, description, image, attributes: traits });

  const uri = tokenUriFor(row.id);
  const client = getNftWalletClient();

  try {
    // The contract returns the new token id from `mint`.
    const hash = await client.writeContract({
      address: contract,
      abi: NFT_ABI,
      functionName: "mint",
      args: [row.recipient, uri],
      chain: nftChain(),
      account: loadAccountForTransfer(),
    });
    const receipt = await getNftPublicClient().waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success") {
      return await markFailed(row.id, "The mint transaction reverted.");
    }
    // The token id is the count of NFTs before this mint, plus one.
    const tokenId = await readTotalSupply();
    return await markMinted(row.id, {
      tokenId,
      txHash: hash,
      tokenUri: uri,
    });
  } catch (err) {
    return await markFailed(
      row.id,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function markMinted(
  id: string,
  data: { tokenId: number; txHash: Hex; tokenUri: string },
): Promise<PendingMint> {
  return serialized(() => {
    const rows = readMints();
    const row = rows.find((m) => m.id === id);
    if (!row) throw new Error(`No mint with id ${id}.`);
    row.status = "minted";
    row.tokenId = data.tokenId;
    row.txHash = data.txHash;
    row.tokenUri = data.tokenUri;
    writeMints(rows);
    return row;
  });
}

async function markFailed(id: string, reason: string): Promise<PendingMint> {
  return serialized(() => {
    const rows = readMints();
    const row = rows.find((m) => m.id === id);
    if (!row) throw new Error(`No mint with id ${id}.`);
    row.status = "failed";
    row.reason = reason;
    writeMints(rows);
    return row;
  });
}

// ─── Reading the chain ──────────────────────────────────────────────────

async function readTotalSupply(): Promise<number> {
  const client = getNftPublicClient();
  const total = (await client.readContract({
    address: requireNftContract(),
    abi: NFT_ABI,
    functionName: "totalSupply",
  })) as bigint;
  return Number(total);
}

export type OnChainNft = {
  tokenId: number;
  owner: Address;
  tokenUri: string;
  priceUsdc: string;
  seller: Address | null;
  listed: boolean;
};

/** Every token the contract knows about, with its listing state. */
export async function listOnChainNfts(): Promise<OnChainNft[]> {
  const contract = requireNftContract();
  const client = getNftPublicClient();
  const total = await readTotalSupply();
  const out: OnChainNft[] = [];
  for (let tokenId = 1; tokenId <= total; tokenId++) {
    const info = (await client.readContract({
      address: contract,
      abi: NFT_ABI,
      functionName: "tokenInfo",
      args: [BigInt(tokenId)],
    })) as readonly [Address, string, bigint, Address, boolean];
    out.push({
      tokenId,
      owner: info[0],
      tokenUri: info[1],
      priceUsdc: (Number(info[2]) / 10 ** USDC_DECIMALS).toString(),
      seller: info[3] === "0x0000000000000000000000000000000000000000" ? null : info[3],
      listed: info[4],
    });
  }
  return out;
}

/** One token, with the local metadata attached when we have it. */
export async function readNft(tokenId: number) {
  const contract = requireNftContract();
  const client = getNftPublicClient();
  const info = (await client.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: "tokenInfo",
    args: [BigInt(tokenId)],
  })) as readonly [Address, string, bigint, Address, boolean];
  const mint = readMints().find((m) => m.tokenId === tokenId);
  return {
    tokenId,
    owner: info[0],
    tokenUri: info[1],
    priceUsdc: (Number(info[2]) / 10 ** USDC_DECIMALS).toString(),
    seller: info[3] === "0x0000000000000000000000000000000000000000" ? null : info[3],
    listed: info[4],
    metadata: mint ? readMetadata(mint.id) : null,
    explorer: `https://sepolia.basescan.org/token/${contract}?a=${info[0]}`,
  };
}

// ─── Selling and buying ─────────────────────────────────────────────────

/** Put one of the agent's own tokens up for sale. */
export async function listNftForSale(
  tokenId: number,
  priceUsdc: number,
): Promise<{ txHash: Hex }> {
  if (process.env.KILL_SWITCH === "1") {
    throw new Error("KILL_SWITCH is set — the economy is frozen.");
  }
  requireNftContract();
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) {
    throw new Error("The price must be a positive number of USDC.");
  }
  if (priceUsdc > MAX_NFT_PRICE_USDC) {
    throw new Error(
      `${priceUsdc} USDC exceeds the ${MAX_NFT_PRICE_USDC} USDC NFT cap. Listing refused.`,
    );
  }
  const client = getNftWalletClient();
  const hash = await client.writeContract({
    address: requireNftContract(),
    abi: NFT_ABI,
    functionName: "listForSale",
    args: [BigInt(tokenId), parseUnits(priceUsdc.toString(), USDC_DECIMALS)],
    chain: nftChain(),
    account: loadAccountForTransfer(),
  });
  const receipt = await getNftPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("The listing transaction reverted.");
  }
  return { txHash: hash };
}

/**
 * Buy a listed NFT with the agent's own USDC.
 *
 * The contract pulls the USDC with `transferFrom`, so the agent has to
 * approve the contract first. That approval is a separate transaction, and
 * both are code-enforced: the price is capped before anything is signed.
 */
export async function buyNft(tokenId: number): Promise<{
  txHash: Hex;
  priceUsdc: string;
}> {
  if (process.env.KILL_SWITCH === "1") {
    throw new Error("KILL_SWITCH is set — the economy is frozen.");
  }
  const contract = requireNftContract();
  const client = getNftPublicClient();

  const listing = (await client.readContract({
    address: contract,
    abi: NFT_ABI,
    functionName: "listingOf",
    args: [BigInt(tokenId)],
  })) as readonly [bigint, Address, boolean];
  const price = Number(listing[0]) / 10 ** USDC_DECIMALS;
  const active = listing[2];

  if (!active) throw new Error(`NFT #${tokenId} is not for sale.`);
  if (price > MAX_NFT_PRICE_USDC) {
    throw new Error(
      `NFT #${tokenId} asks ${price} USDC, above the ${MAX_NFT_PRICE_USDC} USDC cap. Buying refused.`,
    );
  }

  const wallet = getNftWalletClient();
  const account = loadAccountForTransfer();

  // 1. Approve the contract to spend the exact price.
  const approveHash = await wallet.writeContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ],
    functionName: "approve",
    args: [contract, listing[0]],
    chain: nftChain(),
    account,
  });
  const approveReceipt = await client.waitForTransactionReceipt({
    hash: approveHash,
  });
  if (approveReceipt.status !== "success") {
    throw new Error("The USDC approval transaction reverted.");
  }

  // 2. Buy.
  const hash = await wallet.writeContract({
    address: contract,
    abi: NFT_ABI,
    functionName: "buy",
    args: [BigInt(tokenId)],
    chain: nftChain(),
    account,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("The purchase transaction reverted.");
  }
  return { txHash: hash, priceUsdc: price.toString() };
}

export { NFT_ABI };
