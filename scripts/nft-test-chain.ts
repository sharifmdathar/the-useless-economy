/**
 * A local EVM with everything the NFT tests need.
 *
 * Base Sepolia deployment needs testnet gas that this repo's wallets do not
 * hold, so the NFT tests run against a local chain instead: the real
 * contract, the real viem calls, the real app code. The one thing that has to
 * be faked is the USDC, and it is faked in a way that does not touch the app:
 * a mock ERC-20 is deployed and its runtime code is copied to the canonical
 * Base Sepolia USDC address with `evm_setAccountCode`, so the app's
 * hard-coded USDC address resolves with no test-only branch in the app.
 */
import fs from "fs";
import path from "path";
import ganache from "ganache";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_ID = 1337;
export const RPC = `http://127.0.0.1:${CHAIN_ID}`;
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

const MOCK_USDC_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
contract MockUSDC {
    string public name = "USD Coin";
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

export type TestChain = {
  agent: ReturnType<typeof privateKeyToAccount>;
  provider: ReturnType<typeof privateKeyToAccount>;
  buyer: ReturnType<typeof privateKeyToAccount>;
  /** The raw keys — viem's account objects do not expose them. */
  agentKey: `0x${string}`;
  providerKey: `0x${string}`;
  buyerKey: `0x${string}`;
  nftAddress: `0x${string}`;
  publicClient: ReturnType<typeof createPublicClient>;
  /** Point the app at this chain (env vars the app reads). */
  useAppKeys(key?: `0x${string}`): void;
  stop(): Promise<void>;
};

export async function bootNftChain(opts?: { fundUsdc?: boolean }): Promise<TestChain> {
  const root = process.cwd();
  const nftAbi = JSON.parse(
    fs.readFileSync(path.join(root, "contracts", "UselessNFT.abi.json"), "utf8"),
  );
  const nftBytecode = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts", "UselessNFT.bytecode.json"),
      "utf8",
    ),
  ).bytecode;

  const solc = (await import("solc")).default;
  const input = {
    language: "Solidity",
    sources: { "MockUSDC.sol": { content: MOCK_USDC_SOURCE } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter(
    (e: { severity: string }) => e.severity === "error",
  );
  if (errs.length) {
    throw new Error(
      errs
        .map((e: { formattedMessage: string }) => e.formattedMessage)
        .join("\n"),
    );
  }
  const mock = out.contracts["MockUSDC.sol"].MockUSDC;

  const server = ganache.server({
    wallet: { totalAccounts: 4 },
    logging: { quiet: true },
    chain: { hardfork: "shanghai", chainId: CHAIN_ID },
  });
  await server.listen(CHAIN_ID);

  const rpcCall = async (method: string, params: unknown[]) => {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message: string };
    };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };

  const agentKey = (
    JSON.parse(
      fs.readFileSync(path.join(root, ".agent-wallet.json"), "utf8"),
    ) as { privateKey: `0x${string}` }
  ).privateKey;
  const providerKey = (
    JSON.parse(
      fs.readFileSync(path.join(root, ".provider-wallet.json"), "utf8"),
    ) as { privateKey: `0x${string}` }
  ).privateKey;
  const buyerKey =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

  const agent = privateKeyToAccount(agentKey);
  const provider = privateKeyToAccount(providerKey);
  const buyer = privateKeyToAccount(buyerKey);

  for (const who of [agent, provider, buyer]) {
    await rpcCall("evm_setAccountBalance", [who.address, "0x3635C9ADC5DEA00000"]);
  }

  const transport = http(RPC);
  const publicClient = createPublicClient({ transport });
  const wallet = (account: typeof agent) =>
    createWalletClient({ account, transport });

  // The mock USDC, placed at the canonical Base Sepolia USDC address.
  const mockDeploy = await wallet(agent).deployContract({
    abi: mock.abi,
    bytecode: ("0x" + mock.evm.bytecode.object) as `0x${string}`,
    chain: null,
  });
  const mockReceipt = await publicClient.waitForTransactionReceipt({
    hash: mockDeploy,
  });
  const runtime = await publicClient.getCode({
    address: mockReceipt.contractAddress!,
  });
  await rpcCall("evm_setAccountCode", [USDC_ADDRESS, runtime]);

  if (opts?.fundUsdc !== false) {
    for (const who of [agent, buyer]) {
      await wallet(agent).writeContract({
        address: USDC_ADDRESS,
        abi: mock.abi,
        functionName: "mint",
        args: [who.address, 100_000_000n],
        chain: null,
      });
    }
  }

  // The real contract, deployed by the agent wallet (so the agent is the
  // minter) and paid in the mock USDC.
  const nftDeploy = await wallet(agent).deployContract({
    abi: nftAbi,
    bytecode: nftBytecode,
    args: [agent.address, USDC_ADDRESS],
    chain: null,
  });
  const nftReceipt = await publicClient.waitForTransactionReceipt({
    hash: nftDeploy,
  });
  const nftAddress = nftReceipt.contractAddress!;

  return {
    agent,
    provider,
    buyer,
    agentKey,
    providerKey,
    buyerKey,
    nftAddress,
    publicClient,
    useAppKeys(key = agentKey) {
      process.env.NFT_RPC_URL = RPC;
      process.env.NFT_CHAIN_ID = String(CHAIN_ID);
      process.env.WALLET_PRIVATE_KEY = key;
    },
    async stop() {
      await server.close();
    },
  };
}
