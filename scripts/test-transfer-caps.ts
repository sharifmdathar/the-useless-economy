/**
 * Verify the transfer caps cannot be walked through.
 *
 * Two halves, both of which used to be wrong:
 *
 *  1. CREATION — the daily cap was computed from EXECUTED transfers only. A
 *     pending intent was invisible to it, so a user could file N intents that
 *     each passed the cap on their own.
 *  2. EXECUTION — the cap was only ever checked when the intent was filed.
 *     Between filing and approval, other transfers could settle, and the
 *     approval path signed without re-checking anything.
 *
 * The fix: pending/approved intents count as committed spend, and the caps
 * are re-checked at execution time with the transfer being executed excluded
 * from its own total.
 *
 * SAFETY: this test never broadcasts. It runs against a THROWAWAY agent
 * wallet (a random key that holds no funds) in a temporary working
 * directory, so even the "within the cap" case fails on-chain instead of
 * moving real USDC. The real .transfers.json and .agent-wallet.json are
 * never touched.
 *
 * Run: JITI_TSCONFIG_PATHS=true node_modules/.bin/jiti scripts/test-transfer-caps.ts
 */
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const CAP = "0.05"; // USDC rolling-24h ceiling for this test
const DEAD = "0x000000000000000000000000000000000000dEaD";

/** A throwaway key that holds nothing — used so nothing real can be signed. */
const THROWAWAY_KEY = "0x" + randomBytes(32).toString("hex");

async function main() {
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  // --- isolate: a temp cwd with a throwaway wallet and an empty transfers file
  const work = mkdtempSync(path.join(tmpdir(), "transfer-caps-"));
  const repo = process.cwd();
  try {
    mkdirSync(path.join(work, "scripts"), { recursive: true });
    // The module resolves .transfers.json and .agent-wallet.json from
    // process.cwd(), so running from `work` isolates both.
    writeFileSync(path.join(work, ".transfers.json"), "[]\n");
    writeFileSync(
      path.join(work, ".agent-wallet.json"),
      JSON.stringify({ privateKey: THROWAWAY_KEY }),
    );

    process.env.MAX_DAILY_TRANSFER_USDC = CAP;
    process.env.MAX_TRANSFER_USDC = "100";
    process.env.KILL_SWITCH = "0";
    // Force the throwaway key even if a .env is present.
    process.env.WALLET_PRIVATE_KEY = THROWAWAY_KEY;

    process.chdir(work);

    const { createPendingTransfer, executeAgentTransfer } = await import(
      path.join(repo, "agent", "transfers.ts")
    );

    const rows = (): any[] =>
      JSON.parse(readFileSync(path.join(work, ".transfers.json"), "utf8"));
    const save = (r: any[]) =>
      writeFileSync(
        path.join(work, ".transfers.json"),
        JSON.stringify(r, null, 2) + "\n",
      );

    // --- 1. CREATION: a pending intent must count against the cap. ---
    const a = await createPendingTransfer({
      token: "USDC",
      amount: 0.03,
      recipient: DEAD,
    });
    check("a 0.03 USDC intent is filed under a 0.05 cap", !!a.id, a.id);

    let secondBlocked = false;
    let secondMsg = "";
    try {
      await createPendingTransfer({
        token: "USDC",
        amount: 0.03,
        recipient: DEAD,
      });
    } catch (e) {
      secondBlocked = true;
      secondMsg = (e as Error).message;
    }
    check(
      "a second 0.03 USDC intent is refused while the first is still pending",
      secondBlocked,
      secondMsg,
    );
    check(
      "the refusal names the cap",
      secondBlocked && /cap/i.test(secondMsg),
      secondMsg,
    );

    // --- 2. EXECUTION: the cap is re-checked when the money actually moves. ---
    // The first intent was filed when the running total was 0, so it passed.
    // Now a sibling settles and the committed total becomes 0.03 + 0.03.
    const all = rows();
    all.push({
      id: "tx_test_concurrent_settlement",
      createdAt: new Date().toISOString(),
      prompt: "test fixture",
      token: "USDC",
      tokenName: "USD Coin",
      amount: "0.03",
      recipient: DEAD,
      source: "agent_wallet",
      status: "executed",
      isNative: false,
      txHash: "0x" + "11".repeat(32),
    });
    save(all);

    let execBlocked = false;
    let execMsg = "";
    try {
      await executeAgentTransfer(a.id);
    } catch (e) {
      execBlocked = true;
      execMsg = (e as Error).message;
    }
    check(
      "executing a transfer re-checks the daily cap",
      execBlocked,
      execMsg,
    );
    check(
      "the execution refusal names the cap",
      execBlocked && /cap/i.test(execMsg),
      execMsg,
    );

    // --- 3. The refused transfer must NOT have moved money. ---
    const after = rows().find((t) => t.id === a.id);
    check(
      "the refused transfer is still pending and has no tx hash",
      after?.status === "pending" && !after?.txHash,
      `status=${after?.status} txHash=${after?.txHash ?? "none"}`,
    );

    // --- 4. A transfer that fits must still pass the cap gate. ---
    const clean = rows().filter(
      (t) => t.id !== "tx_test_concurrent_settlement" && t.id !== a.id,
    );
    save(clean);
    const c = await createPendingTransfer({
      token: "USDC",
      amount: 0.01,
      recipient: DEAD,
    });
    check("a 0.01 USDC intent is still filed when there is headroom", !!c.id, c.id);

    // It must get PAST the cap gate. It is allowed to fail afterwards — the
    // throwaway key holds no USDC, so the settlement fails. What matters is
    // that the failure is not a cap refusal.
    let capError = false;
    let otherMsg = "";
    try {
      await executeAgentTransfer(c.id);
    } catch (e) {
      const msg = (e as Error).message;
      capError = /cap/i.test(msg);
      otherMsg = msg;
    }
    check(
      "a transfer within the cap is not refused by the cap",
      !capError,
      otherMsg,
    );
  } finally {
    process.chdir(repo);
    rmSync(work, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? "\nPASS: the transfer caps cannot be walked through."
      : `\nFAIL: ${failures} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exitCode = 1;
});
