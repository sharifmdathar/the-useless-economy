/**
 * PENDING TRANSFERS — the review-and-authorize layer for user-initiated
 * crypto transfers.
 *
 * Week 2's core ask is "send 10 USDC to 0x…" from a natural-language prompt,
 * with the user able to review and authorize before anything is signed. So a
 * transfer is a two-phase object:
 *
 *   phase 1  the agent parses the prompt and calls `send_tokens`, which
 *            VALIDATES the intent and files a pending transfer. No signing.
 *   phase 2  the user reviews the card in the chat and approves. Only then
 *            is a transaction signed and broadcast.
 *
 * The pending store is deliberately dumb: it holds intent, and it refuses to
 * move anything on its own. Execution requires an explicit approve, which
 * only the UI (or an explicit tool call) can issue.
 *
 * TESTNET ONLY — Base Sepolia. Amount caps are code-enforced, not prompt-
 * enforced, exactly like the economy's MAX_PER_JOB / WEEKLY_CAP.
 */
import fs from "fs";
import path from "path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI, USDC_ADDRESS, loadAccountForTransfer, USDC_DECIMALS } from "./wallet";
import { gaslessUsdcTransfer } from "@/lib/facilitator-retry";
import {
  amountToUnits,
  isValidRecipient,
  resolveToken,
  unitsToAmount,
  type TokenDef,
  type TokenSymbol,
} from "./tokens";

const CHAIN_ID = 84532; // Base Sepolia — TESTNET ONLY

const TRANSFERS_PATH = path.join(process.cwd(), ".transfers.json");

/** Per-transaction ceiling for a user-initiated transfer. */
export const MAX_TRANSFER = Number(process.env.MAX_TRANSFER_USDC ?? 100);
/** Rolling 24h ceiling across all user-initiated transfers. */
export const MAX_DAILY_TRANSFER = Number(
  process.env.MAX_DAILY_TRANSFER_USDC ?? 500,
);

export type TransferSource = "agent_wallet" | "user_wallet";

export type TransferStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed";

export type PendingTransfer = {
  id: string;
  createdAt: string;
  /** Original user prompt, kept for the audit trail. */
  prompt: string;
  token: TokenSymbol;
  tokenName: string;
  amount: string;
  recipient: Address;
  source: TransferSource;
  status: TransferStatus;
  /** Set once a transaction is broadcast. */
  txHash?: string;
  /** Set on rejection or failure. */
  reason?: string;
  /** True when the amount was paid in the native asset. */
  isNative: boolean;
};

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function readAll(): PendingTransfer[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRANSFERS_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as PendingTransfer[]) : [];
  } catch {
    return [];
  }
}

function writeAll(rows: PendingTransfer[]) {
  fs.writeFileSync(
    TRANSFERS_PATH,
    JSON.stringify(rows, null, 2) + "\n",
  );
}

/** Rolling 24h spend of EXECUTED transfers, by token. */
function dailySpend(token: TokenSymbol): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return readAll()
    .filter(
      (t) =>
        t.token === token &&
        t.status === "executed" &&
        new Date(t.createdAt).getTime() >= cutoff,
    )
    .reduce((s, t) => s + Number(t.amount), 0);
}

export function listTransfers(status?: TransferStatus): PendingTransfer[] {
  const rows = readAll();
  return status ? rows.filter((t) => t.status === status) : rows;
}

export function getTransfer(id: string): PendingTransfer | undefined {
  return readAll().find((t) => t.id === id);
}

/**
 * File a new pending transfer. This does NOT sign anything — it validates
 * the intent and records it for review. Throws with a human-readable reason
 * when the intent is illegal.
 */
export async function createPendingTransfer(args: {
  token: string;
  amount: number | string;
  recipient: string;
  source?: TransferSource;
  prompt?: string;
}): Promise<PendingTransfer> {
  if (process.env.KILL_SWITCH === "1") {
    throw new Error(
      "KILL_SWITCH is set — the economy is frozen. No transfers will be created or sent.",
    );
  }

  const token = resolveToken(args.token);
  if (!token) {
    throw new Error(
      `Unsupported token "${args.token}". Supported: USDC, ETH (Base Sepolia testnet).`,
    );
  }

  if (!isValidRecipient(args.recipient)) {
    throw new Error(
      `"${args.recipient}" is not a valid EIP-55 checksum address. Nothing was sent.`,
    );
  }
  const recipient = args.recipient;

  const units = amountToUnits(token, args.amount);
  if (units === null) {
    throw new Error(
      `Invalid amount "${args.amount}". Use a positive number with at most ${token.decimals} decimal places.`,
    );
  }
  const amount = unitsToAmount(token, units);

  // Code-enforced caps — a prompt cannot raise them.
  const numeric = Number(amount);
  if (numeric > MAX_TRANSFER) {
    throw new Error(
      `${amount} ${token.symbol} exceeds the ${MAX_TRANSFER} ${token.symbol} per-transfer cap. Nothing was sent.`,
    );
  }
  const spent = dailySpend(token.symbol);
  if (spent + numeric > MAX_DAILY_TRANSFER) {
    throw new Error(
      `Daily transfer cap of ${MAX_DAILY_TRANSFER} ${token.symbol} would be breached (already sent ${spent.toFixed(6)} + ${amount}). Nothing was sent.`,
    );
  }

  const source: TransferSource = args.source ?? "agent_wallet";
  if (source !== "agent_wallet" && source !== "user_wallet") {
    throw new Error(`Unknown transfer source "${args.source}".`);
  }

  const transfer: PendingTransfer = {
    id: `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    prompt: args.prompt ?? "",
    token: token.symbol,
    tokenName: token.name,
    amount,
    recipient,
    source,
    status: "pending",
    isNative: token.isNative,
  };

  await serialized(() => {
    const rows = readAll();
    rows.push(transfer);
    writeAll(rows);
  });
  return transfer;
}

/** Mark a pending transfer as rejected by the user. */
export async function rejectTransfer(
  id: string,
  reason = "Rejected by user.",
): Promise<PendingTransfer> {
  return serialized(() => {
    const rows = readAll();
    const row = rows.find((t) => t.id === id);
    if (!row) throw new Error(`No transfer with id ${id}.`);
    if (row.status !== "pending") {
      throw new Error(`Transfer ${id} is already ${row.status}.`);
    }
    row.status = "rejected";
    row.reason = reason;
    writeAll(rows);
    return row;
  });
}

async function markExecuted(
  id: string,
  txHash: string,
): Promise<PendingTransfer> {
  return serialized(() => {
    const rows = readAll();
    const row = rows.find((t) => t.id === id);
    if (!row) throw new Error(`No transfer with id ${id}.`);
    row.status = "executed";
    row.txHash = txHash;
    writeAll(rows);
    return row;
  });
}

async function markFailed(
  id: string,
  reason: string,
): Promise<PendingTransfer> {
  return serialized(() => {
    const rows = readAll();
    const row = rows.find((t) => t.id === id);
    if (!row) throw new Error(`No transfer with id ${id}.`);
    row.status = "failed";
    row.reason = reason;
    writeAll(rows);
    return row;
  });
}

/**
 * Execute an approved transfer from the AGENT's own wallet.
 * The agent signs locally with its on-disk key; the key is never returned,
 * logged, or sent anywhere.
 */
export async function executeAgentTransfer(
  id: string,
): Promise<PendingTransfer> {
  const row = getTransfer(id);
  if (!row) throw new Error(`No transfer with id ${id}.`);
  if (row.status !== "pending" && row.status !== "approved") {
    throw new Error(`Transfer ${id} is ${row.status}, not pending.`);
  }
  // A transfer created before the switch was flipped must not still settle.
  if (process.env.KILL_SWITCH === "1") {
    throw new Error(
      "KILL_SWITCH is set — the economy is frozen. This transfer was not sent.",
    );
  }

  const token = resolveToken(row.token);
  if (!token) throw new Error(`Unsupported token ${row.token}.`);
  const units = amountToUnits(token, row.amount);
  if (units === null) throw new Error(`Invalid stored amount ${row.amount}.`);

  try {
    const account = loadAccountForTransfer();

    if (token.isNative) {
      // Native ETH must be broadcast by a key that can pay gas.
      const client = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(),
      });
      const tx = await client.sendTransaction({
        to: row.recipient,
        value: units,
      });
      return await markExecuted(id, tx);
    }

    // USDC goes through the gasless EIP-3009 path: the agent signs an
    // authorization OFF-CHAIN (free, no ETH needed) and the x402 facilitator
    // broadcasts it while paying the gas. The agent wallet holds USDC but no
    // ETH, so a direct USDC.transfer() could never succeed.
    const result = await gaslessUsdcTransfer({
      account,
      to: row.recipient,
      value: units,
      resource: "https://the-useless-economy.local/transfer",
      description: `Transfer ${row.amount} ${token.symbol} to ${row.recipient}`,
    });
    if (!result.success || !result.txHash) {
      return await markFailed(
        id,
        result.error ?? "Gasless settlement failed.",
      );
    }
    return await markExecuted(id, result.txHash);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await markFailed(id, reason);
  }
}

/**
 * Record a transfer that the USER's own connected wallet broadcast. The
 * browser signs; the server only records the resulting hash so the ledger
 * and the UI agree on what happened.
 */
export async function recordUserTransfer(
  id: string,
  txHash: string,
): Promise<PendingTransfer> {
  const row = getTransfer(id);
  if (!row) throw new Error(`No transfer with id ${id}.`);
  if (row.status !== "pending" && row.status !== "approved") {
    throw new Error(`Transfer ${id} is ${row.status}, not pending.`);
  }
  return await markExecuted(id, txHash);
}

/** The agent's USDC balance, for the review card. */
export async function agentUsdcBalance(): Promise<string> {
  const account = loadAccountForTransfer();
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  return unitsToAmount(resolveToken("USDC") as TokenDef, raw);
}

export { USDC_DECIMALS };
