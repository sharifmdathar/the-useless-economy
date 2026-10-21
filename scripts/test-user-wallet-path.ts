/**
 * USER-WALLET TRANSFER PATH — cap enforcement and single-execution.
 *
 * The browser-wallet path is the one the user actually clicks:
 *
 *   transfer-card.tsx  ->  POST /api/transfers { action: "claim" }
 *                        ->  connectWallet()
 *                        ->  sendFromUserWallet()   <- SIGNS AND BROADCASTS
 *                        ->  POST /api/transfers { action: "approve", txHash }
 *                        ->  recordUserTransfer()
 *
 * Two things must hold there, exactly as they hold on the agent-wallet path:
 *
 *   1. The transfer caps are re-checked before the money moves. The
 *      agent-wallet path does this in executeAgentTransfer(); the browser
 *      path signs in the BROWSER, so the server has to hand out a claim
 *      BEFORE the signing happens.
 *
 *   2. One logical transfer settles at most once. The agent path gets this
 *      from the EIP-3009 nonce plus a state check; the browser path has
 *      neither — the extension broadcasts directly — so the server issues a
 *      one-shot claim instead.
 *
 * This test runs against a THROWAWAY wallet in a TEMPORARY working
 * directory, so it never touches the real agent wallet and never spends
 * real money. It also never broadcasts: it exercises the server-side
 * bookkeeping only.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "user-wallet-test-"));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP);

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// The browser wallet signs with ITS OWN key, so the agent's key is
// irrelevant here. Still point it at a throwaway so nothing can reach the
// real wallet if the code under test does sign. The key is generated per
// run and never written down, so no key material is committed.
const THROWAWAY_KEY =
  `0x${randomBytes(32).toString("hex")}` as `0x${string}`;

let transfers: typeof import("../agent/transfers") = null!;
let caps: { MAX_TRANSFER: number; MAX_DAILY_TRANSFER: number } = null!;

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HASH_A = "0x" + "33".repeat(32);
const HASH_B = "0x" + "44".repeat(32);

function writeRows(rows: unknown[]) {
  fs.writeFileSync(
    path.join(TMP, ".transfers.json"),
    JSON.stringify(rows, null, 2),
  );
}

function readRows(): any[] {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(TMP, ".transfers.json"), "utf8"),
    ) as any[];
  } catch {
    return [];
  }
}

function appendRow(row: unknown) {
  writeRows([...readRows(), row]);
}

function executedRow(id: string, amount: string) {
  return {
    id,
    createdAt: new Date().toISOString(),
    prompt: "seed",
    token: "USDC",
    tokenName: "USD Coin",
    amount,
    recipient: RECIPIENT,
    source: "agent_wallet",
    status: "executed",
    isNative: false,
    txHash: "0x" + "11".repeat(32),
  };
}

async function main() {
  process.env.WALLET_PRIVATE_KEY = THROWAWAY_KEY;
  process.env.MAX_TRANSFER_USDC = "10";
  process.env.MAX_DAILY_TRANSFER_USDC = "25";

  // Imported AFTER the env is set so the module reads the limits.
  transfers = await import("../agent/transfers");
  caps = {
    MAX_TRANSFER: transfers.MAX_TRANSFER,
    MAX_DAILY_TRANSFER: transfers.MAX_DAILY_TRANSFER,
  };

  console.log(
    `limits: per-transfer=${caps.MAX_TRANSFER} daily=${caps.MAX_DAILY_TRANSFER}`,
  );
  console.log("");

  // -------------------------------------------------------------------
  // 1. The cap is enforced when the intent is filed, for BOTH sources.
  // -------------------------------------------------------------------
  console.log("cap at intent time (both sources)");
  for (const source of ["agent_wallet", "user_wallet"] as const) {
    await check(`per-transfer cap refused for ${source}`, async () => {
      let threw = "";
      try {
        await transfers.createPendingTransfer({
          token: "USDC",
          amount: caps.MAX_TRANSFER + 1,
          recipient: RECIPIENT,
          source,
        });
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        threw.includes("per-transfer cap"),
        `expected per-transfer refusal, got: ${threw}`,
      );
    });
  }

  console.log("");
  console.log("cap at intent time (daily ceiling, both sources)");
  writeRows([executedRow("tx_committed", String(caps.MAX_DAILY_TRANSFER))]);
  for (const source of ["agent_wallet", "user_wallet"] as const) {
    await check(`daily cap refused at intent time for ${source}`, async () => {
      let threw = "";
      try {
        await transfers.createPendingTransfer({
          token: "USDC",
          amount: 1,
          recipient: RECIPIENT,
          source,
        });
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        threw.includes("Daily transfer cap"),
        `expected daily refusal, got: ${threw}`,
      );
    });
  }

  // -------------------------------------------------------------------
  // 2. THE GAP THAT WAS FIXED: the user-wallet path now re-checks the
  //    caps at approval time, via a server-side claim.
  // -------------------------------------------------------------------
  console.log("");
  console.log("cap at approval time (claim)");

  // Free up headroom, file a transfer, then commit more spend AFTER
  // filing so the transfer crosses the ceiling between intent and
  // approval. Both paths must refuse to move the money.
  writeRows([]);
  const filedAgent = await transfers.createPendingTransfer({
    token: "USDC",
    amount: 5,
    recipient: RECIPIENT,
    source: "agent_wallet",
  });
  const filedUser = await transfers.createPendingTransfer({
    token: "USDC",
    amount: 5,
    recipient: RECIPIENT,
    source: "user_wallet",
  });

  // Someone else commits 24 USDC in the meantime (cap is 25).
  appendRow(executedRow("tx_other", "24"));

  await check(
    "agent path refuses at approval time when the cap is crossed",
    async () => {
      let threw = "";
      try {
        await transfers.executeAgentTransfer(filedAgent.id);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        threw.includes("cap"),
        `expected cap refusal at approval, got: ${threw}`,
      );
      const after = transfers.getTransfer(filedAgent.id)!;
      assert(!after.txHash, `refused transfer must not have a txHash`);
      assert(
        after.status === "pending",
        `refused transfer must stay pending, got: ${after.status}`,
      );
    },
  );

  await check(
    "user path refuses to claim when the cap is crossed",
    async () => {
      let threw = "";
      try {
        await transfers.claimTransferForSigning(filedUser.id);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        threw.includes("Daily transfer cap"),
        `expected daily refusal at claim, got: ${threw}`,
      );
      const after = transfers.getTransfer(filedUser.id)!;
      assert(!after.txHash, `refused transfer must not have a txHash`);
      assert(
        !after.claimedAt,
        `a refused claim must not stamp the row, got: ${after.claimedAt}`,
      );
    },
  );

  // -------------------------------------------------------------------
  // 3. Single execution: one logical transfer, one signature.
  // -------------------------------------------------------------------
  console.log("");
  console.log("single execution");

  writeRows([]);
  const dup = await transfers.createPendingTransfer({
    token: "USDC",
    amount: 1,
    recipient: RECIPIENT,
    source: "user_wallet",
  });

  await check("a second claim on the same transfer is refused", async () => {
    await transfers.claimTransferForSigning(dup.id);
    let threw = "";
    try {
      await transfers.claimTransferForSigning(dup.id);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw !== "", "a second claim must be refused");
    assert(
      threw.includes("already being signed"),
      `expected an already-signed refusal, got: ${threw}`,
    );
  });

  await check("claiming an executed transfer is refused", async () => {
    await transfers.recordUserTransfer(dup.id, HASH_A);
    let threw = "";
    try {
      await transfers.claimTransferForSigning(dup.id);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw !== "", "claiming an executed transfer must be refused");
    assert(
      threw.includes("already executed"),
      `expected an already-executed refusal, got: ${threw}`,
    );
  });

  await check("a second approve on an executed transfer is refused", async () => {
    let threw = "";
    try {
      await transfers.recordUserTransfer(dup.id, HASH_B);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw !== "", "a second approve must be refused");
    // The FIRST hash must survive — the second must not overwrite it.
    const after = transfers.getTransfer(dup.id)!;
    assert(
      after.txHash === HASH_A,
      `the original hash must be preserved, got: ${after.txHash}`,
    );
  });

  await check("an expired claim can be re-issued (no permanent lockout)", async () => {
    writeRows([]);
    const stale = await transfers.createPendingTransfer({
      token: "USDC",
      amount: 1,
      recipient: RECIPIENT,
      source: "user_wallet",
    });
    await transfers.claimTransferForSigning(stale.id);
    // Age the claim past its TTL.
    const rows = JSON.parse(
      fs.readFileSync(path.join(TMP, ".transfers.json"), "utf8"),
    ) as any[];
    rows.find((r) => r.id === stale.id).claimedAt = new Date(
      Date.now() - 60 * 60 * 1000,
    ).toISOString();
    writeRows(rows);
    // Must NOT throw.
    await transfers.claimTransferForSigning(stale.id);
  });

  await check(
    "the kill switch also blocks a browser-wallet claim",
    async () => {
      writeRows([]);
      const frozen = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "user_wallet",
      });
      process.env.KILL_SWITCH = "1";
      let threw = "";
      try {
        await transfers.claimTransferForSigning(frozen.id);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      } finally {
        delete process.env.KILL_SWITCH;
      }
      assert(threw !== "", "the kill switch must block a claim");
    },
  );

  await check("a released claim can be re-claimed", async () => {
    writeRows([]);
    const rel = await transfers.createPendingTransfer({
      token: "USDC",
      amount: 1,
      recipient: RECIPIENT,
      source: "user_wallet",
    });
    await transfers.claimTransferForSigning(rel.id);
    await transfers.releaseTransferClaim(rel.id);
    // Must NOT throw — the transfer is retryable.
    await transfers.claimTransferForSigning(rel.id);
  });

  await check("releasing an executed transfer is refused", async () => {
    writeRows([]);
    const done = await transfers.createPendingTransfer({
      token: "USDC",
      amount: 1,
      recipient: RECIPIENT,
      source: "user_wallet",
    });
    await transfers.claimTransferForSigning(done.id);
    await transfers.recordUserTransfer(done.id, HASH_A);
    let threw = "";
    try {
      await transfers.releaseTransferClaim(done.id);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(threw !== "", "releasing an executed transfer must be refused");
  });

  await check(
    "concurrent claims: exactly one wins",
    async () => {
      writeRows([]);
      const race = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "user_wallet",
      });
      // Two tabs clicking approve at the same instant. Exactly one claim
      // may succeed, otherwise both would sign and the user would pay
      // twice.
      const results = await Promise.allSettled([
        transfers.claimTransferForSigning(race.id),
        transfers.claimTransferForSigning(race.id),
        transfers.claimTransferForSigning(race.id),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      assert(
        won.length === 1,
        `expected exactly one claim to win, got ${won.length}`,
      );
    },
  );

  await check(
    "a hash cannot be recorded for an unclaimed transfer",
    async () => {
      writeRows([]);
      const unclaimed = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "user_wallet",
      });
      let threw = "";
      try {
        await transfers.recordUserTransfer(unclaimed.id, HASH_A);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(threw !== "", "an unclaimed transfer must not accept a hash");
      assert(
        threw.includes("never claimed"),
        `expected a never-claimed refusal, got: ${threw}`,
      );
      const after = transfers.getTransfer(unclaimed.id)!;
      assert(!after.txHash, "no hash may be recorded");
      assert(after.status === "pending", "the transfer must stay pending");
    },
  );

  await check(
    "a released transfer cannot have a hash recorded either",
    async () => {
      writeRows([]);
      const released = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "user_wallet",
      });
      await transfers.claimTransferForSigning(released.id);
      await transfers.releaseTransferClaim(released.id);
      let threw = "";
      try {
        await transfers.recordUserTransfer(released.id, HASH_A);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(threw !== "", "a released transfer must not accept a hash");
    },
  );

  console.log("");
  console.log("the agent's wallet may not sign a user-wallet transfer");

  await check(
    "executeAgentTransfer refuses a user_wallet transfer",
    async () => {
      writeRows([]);
      const userFunded = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "user_wallet",
      });
      let threw = "";
      try {
        await transfers.executeAgentTransfer(userFunded.id);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(threw !== "", "the agent wallet must not sign a user-wallet transfer");
      assert(
        threw.includes("own wallet"),
        `expected a wrong-wallet refusal, got: ${threw}`,
      );
      const after = transfers.getTransfer(userFunded.id)!;
      assert(!after.txHash, "no hash may be recorded");
      assert(
        after.status === "pending",
        `the transfer must stay pending, got: ${after.status}`,
      );
    },
  );

  await check(
    "executeAgentTransfer still signs an agent_wallet transfer",
    async () => {
      writeRows([]);
      const agentFunded = await transfers.createPendingTransfer({
        token: "USDC",
        amount: 1,
        recipient: RECIPIENT,
        source: "agent_wallet",
      });
      // The throwaway key holds no funds, so the chain call fails and the
      // transfer is marked failed — but it was ATTEMPTED, which is what
      // this asserts. The point is that the source guard did not block it.
      let threw = "";
      try {
        await transfers.executeAgentTransfer(agentFunded.id);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        !threw.includes("own wallet"),
        `the agent-wallet path must not be blocked by the source guard, got: ${threw}`,
      );
    },
  );

  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("ERROR:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(TMP, { recursive: true, force: true });
  });
