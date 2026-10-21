/**
 * End-to-end test of contracts/UselessNFT.sol on a LOCAL EVM (ganache).
 *
 * This exists because a Base Sepolia deployment needs testnet gas, and a
 * contract that has never been executed is a contract that does not work.
 * Ganache runs the same EVM rules (and the same 30M gas limit) as Base
 * Sepolia, so this proves the Solidity logic, the ABI and the viem calls
 * the app makes.
 *
 *   npm run test:nft
 *
 * It covers: mint -> list -> approve -> buy -> ownership change, the
 * authorisation rules (only the minter may mint), the payment-failure
 * revert, and the event trail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ganache from "ganache";

const {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  parseEventLogs,
} = await import("viem");
const { mnemonicToAccount } = await import("viem/accounts");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const abi = JSON.parse(
  fs.readFileSync(path.join(root, "contracts", "UselessNFT.abi.json"), "utf8"),
);
const bytecode = JSON.parse(
  fs.readFileSync(
    path.join(root, "contracts", "UselessNFT.bytecode.json"),
    "utf8",
  ),
).bytecode;

// ─── A tiny USDC on the local chain, so the buy path has real money ───
// Compiled here with solc rather than hand-written bytecode: the point of
// this script is to prove the NFT contract, not to hand-assemble EVM.
const solc = (await import("solc")).default;
const MOCK_USDC_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

function compileSol(source, name) {
  const input = {
    language: "Solidity",
    sources: { [name]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) {
    console.error(errs.map((e) => e.formattedMessage).join("\n"));
    process.exit(1);
  }
  const c = out.contracts[name][name.replace(/\.sol$/, "")];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

const mock = compileSol(MOCK_USDC_SOURCE, "MockUSDC.sol");
const ERC20_ABI = mock.abi;

const server = ganache.server({
  wallet: { totalAccounts: 4, defaultBalance: 1000 },
  logging: { quiet: true },
  chain: { hardfork: "shanghai", chainId: 1337 },
});
await server.listen(1337);
const rpc = "http://127.0.0.1:1337";

const transport = http(rpc);
const publicClient = createPublicClient({ transport });

// Ganache's deterministic dev accounts (funded with 1000 ETH each by the
// wallet option above), so every one of them can pay for gas.
const MNEMONIC =
  "myth like bonus scare over problem client lizard pioneer submit female collect";
const accounts = [0, 1, 2, 3].map((i) =>
  mnemonicToAccount(MNEMONIC, { addressIndex: i }),
);

// Fund every account with 1000 test ETH so each one can pay for gas.
for (const account of accounts) {
  await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "evm_setAccountBalance",
      params: [account.address, "0x3635C9ADC5DEA00000"],
    }),
  });
}

const walletOf = (i) =>
  createWalletClient({ account: accounts[i], transport });

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("  ok  " + msg);
}

// ─── Deploy a local USDC and mint balances to the buyer ───
const usdcHash = await walletOf(0).deployContract({
  abi: mock.abi,
  bytecode: mock.bytecode,
  chain: null,
});
const usdcReceipt = await publicClient.waitForTransactionReceipt({
  hash: usdcHash,
});
const usdc = usdcReceipt.contractAddress;

for (const [i, amount] of [
  [1, 100],
  [2, 100],
  [3, 100],
]) {
  await walletOf(0).writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [accounts[i].address, parseUnits(String(amount), 6)],
    chain: null,
  });
}

// ─── Deploy UselessNFT ───
const deployHash = await walletOf(0).deployContract({
  abi,
  bytecode,
  args: [accounts[1].address, usdc], // minter = the agent, payment token = USDC
  chain: null,
});
const deployReceipt = await publicClient.waitForTransactionReceipt({
  hash: deployHash,
});
const nft = deployReceipt.contractAddress;
console.log("UselessNFT deployed at " + nft);

const AGENT = accounts[1].address;
const PROVIDER = accounts[2].address;
const BUYER = accounts[3].address;

const read = async (fn, args = []) =>
  publicClient.readContract({ address: nft, abi, functionName: fn, args });

const write = async (i, fn, args = []) => {
  const hash = await walletOf(i).writeContract({
    address: nft,
    abi,
    functionName: fn,
    args,
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
};

console.log("\n1. only the minter may mint");
{
  let threw = false;
  try {
    await write(2, "mint", [PROVIDER, "http://localhost:3000/api/nfts/9"]);
  } catch {
    threw = true;
  }
  assert(threw, "a non-minter mint reverts");
}

console.log("\n2. the agent mints");
const tokenUri = "http://localhost:3000/api/nfts/1";
{
  const { receipt } = await write(1, "mint", [PROVIDER, tokenUri]);
  assert(receipt.status === "success", "mint succeeded");
  assert((await read("ownerOf", [1])) === PROVIDER, "the provider owns token #1");
  assert((await read("tokenURI", [1])) === tokenUri, "the tokenURI was stored");
  assert((await read("totalSupply")) === 1n, "totalSupply is 1");
  const minted = parseEventLogs({
    abi,
    eventName: "Minted",
    logs: receipt.logs,
  });
  assert(minted.length === 1, "a Minted event was emitted");
  assert(minted[0].args.tokenId === 1n, "the Minted event names token #1");
}

console.log("\n3. the provider lists it for 0.05 USDC");
{
  const price = parseUnits("0.05", 6);
  const { receipt } = await write(2, "listForSale", [1, price]);
  assert(receipt.status === "success", "listForSale succeeded");
  const [p, seller, active] = await read("listingOf", [1]);
  assert(active === true, "the listing is active");
  assert(seller === PROVIDER, "the seller is the provider");
  assert(p === price, "the price is 0.05 USDC");
  const ids = await read("listedTokenIds");
  assert(ids.length === 1 && ids[0] === 1n, "listedTokenIds returns #1");
}

console.log("\n4. a buyer who has NOT approved cannot buy");
{
  let threw = false;
  try {
    await write(3, "buy", [1]);
  } catch {
    threw = true;
  }
  assert(threw, "buy without a USDC approval reverts");
  assert((await read("ownerOf", [1])) === PROVIDER, "ownership did not change");
  assert((await read("isListed", [1])) === true, "the listing is still open");
}

console.log("\n5. the buyer approves and buys");
{
  const price = parseUnits("0.05", 6);
  await walletOf(3).writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [nft, price],
    chain: null,
  });
  const before = await publicClient.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [PROVIDER],
  });
  const { receipt } = await write(3, "buy", [1]);
  assert(receipt.status === "success", "buy succeeded");
  assert((await read("ownerOf", [1])) === BUYER, "the buyer owns token #1");
  assert((await read("isListed", [1])) === false, "the listing is closed");
  const after = await publicClient.readContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [PROVIDER],
  });
  assert(after - before === price, "the seller received exactly 0.05 USDC");
  const sold = parseEventLogs({
    abi,
    eventName: "Sold",
    logs: receipt.logs,
  });
  assert(sold.length === 1, "a Sold event was emitted");
  assert(sold[0].args.buyer === BUYER, "the Sold event names the buyer");
}

console.log("\n6. the buyer can list it again, and the agent can buy it");
{
  const price = parseUnits("0.01", 6);
  await write(3, "listForSale", [1, price]);
  assert((await read("isListed", [1])) === true, "re-listed");
  await walletOf(1).writeContract({
    address: usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [nft, price],
    chain: null,
  });
  await write(1, "buy", [1]);
  assert((await read("ownerOf", [1])) === AGENT, "the agent owns token #1");
}

console.log("\n7. cancelling a listing");
{
  await write(1, "listForSale", [1, parseUnits("0.02", 6)]);
  await write(1, "cancelListing", [1]);
  assert((await read("isListed", [1])) === false, "the listing is gone");
}

console.log("\n8. a zero price cannot be listed");
{
  let threw = false;
  try {
    await write(1, "listForSale", [1, 0n]);
  } catch {
    threw = true;
  }
  assert(threw, "listForSale(0) reverts");
}

console.log("\nAll UselessNFT contract checks passed on the local EVM.");
await server.close();
