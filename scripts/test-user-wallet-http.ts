/**
 * HTTP-LEVEL test of the browser-wallet claim flow.
 *
 * The unit test exercises the functions directly. This one drives the
 * real API through a real HTTP server, because the ORDERING is the whole
 * point:
 *
 *   claim  ->  sign in the browser  ->  approve (record the hash)
 *
 * If the client claimed AFTER signing, or never claimed at all, these
 * endpoints would still "work" — the unit test would still pass. The
 * order is only visible over HTTP.
 *
 * Uses a temporary working directory so the real .transfers.json is
 * never touched, and no transaction is ever broadcast.
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const REPO = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "user-wallet-http-"));
const PORT = 3987;

const RECIPIENT = "0x1111111111111111111111111111111111111111";
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
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

async function waitForServer(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function post(body: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function main() {
  // Run the built app from a temp dir so it uses the temp .transfers.json.
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: TMP,
    env: {
      ...process.env,
      NODE_ENV: "production",
      MAX_TRANSFER_USDC: "10",
      MAX_DAILY_TRANSFER_USDC: "25",
      // A throwaway key, generated per run. It is never funded and never
      // used to sign anything here — the browser path is server-side only
      // in this test — but the server refuses to boot without one.
      WALLET_PRIVATE_KEY: `0x${crypto.randomBytes(32).toString("hex")}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  server.stdout?.on("data", (d: Buffer) => logs.push(String(d)));
  server.stderr?.on("data", (d: Buffer) => logs.push(String(d)));

  try {
    // The temp dir needs the built app; symlink .next and the source
    // files the server reads at runtime.
    fs.symlinkSync(path.join(REPO, ".next"), path.join(TMP, ".next"));
    fs.symlinkSync(path.join(REPO, "public"), path.join(TMP, "public"));
    for (const f of ["package.json", "next.config.ts", "next.config.js"]) {
      const p = path.join(REPO, f);
      if (fs.existsSync(p)) fs.symlinkSync(p, path.join(TMP, f));
    }

    const up = await waitForServer(`http://127.0.0.1:${PORT}/`);
    if (!up) {
      console.log("server logs:", logs.join("").slice(0, 2000));
      throw new Error("server did not start");
    }

    // File a browser-wallet transfer directly in the temp store.
    const rowsFile = path.join(TMP, ".transfers.json");
    const id = "tx_http_browser";
    fs.writeFileSync(
      rowsFile,
      JSON.stringify(
        [
          {
            id,
            createdAt: new Date().toISOString(),
            prompt: "send 5 USDC",
            token: "USDC",
            tokenName: "USD Coin",
            amount: "5",
            recipient: RECIPIENT,
            source: "user_wallet",
            status: "pending",
            isNative: false,
          },
        ],
        null,
        2,
      ),
    );

    console.log("browser-wallet claim flow over HTTP");

    await check("a claim on a browser-wallet transfer succeeds", async () => {
      const r = await post({ action: "claim", transferId: id });
      assert(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(r.body.transfer?.claimedAt, "expected the row to be stamped");
    });

    await check("a second claim is refused", async () => {
      const r = await post({ action: "claim", transferId: id });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(
        String(r.body.error ?? "").includes("already being signed"),
        `expected an already-signed refusal, got: ${r.body.error}`,
      );
    });

    await check("approve records the hash", async () => {
      const hash = "0x" + "ab".repeat(32);
      const r = await post({ action: "approve", transferId: id, txHash: hash });
      assert(r.status === 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert(r.body.transfer?.status === "executed", "expected executed");
      assert(r.body.transfer?.txHash === hash, "expected the hash to be recorded");
    });

    await check("claiming an executed transfer is refused", async () => {
      const r = await post({ action: "claim", transferId: id });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(
        String(r.body.error ?? "").includes("already executed"),
        `expected an already-executed refusal, got: ${r.body.error}`,
      );
    });

    await check("a second approve does not overwrite the first hash", async () => {
      const r = await post({
        action: "approve",
        transferId: id,
        txHash: "0x" + "cd".repeat(32),
      });
      // The route returns the existing row for an executed transfer.
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(
        r.body.transfer?.txHash === "0x" + "ab".repeat(32),
        `the original hash must survive, got: ${r.body.transfer?.txHash}`,
      );
    });

    await check("an agent-wallet transfer cannot be claimed here", async () => {
      const agentId = "tx_http_agent";
      const rows = JSON.parse(fs.readFileSync(rowsFile, "utf8"));
      rows.push({
        id: agentId,
        createdAt: new Date().toISOString(),
        prompt: "send 1 USDC",
        token: "USDC",
        tokenName: "USD Coin",
        amount: "1",
        recipient: RECIPIENT,
        source: "agent_wallet",
        status: "pending",
        isNative: false,
      });
      fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 2));
      const r = await post({ action: "claim", transferId: agentId });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(
        String(r.body.error ?? "").includes("user's own wallet"),
        `expected a source refusal, got: ${r.body.error}`,
      );
    });

    await check("an unknown transfer is a 404", async () => {
      const r = await post({ action: "claim", transferId: "tx_nope" });
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });

    await check(
      "an unclaimed transfer cannot have a hash recorded",
      async () => {
        const freshId = "tx_http_unclaimed";
        const rows = JSON.parse(fs.readFileSync(rowsFile, "utf8"));
        rows.push({
          id: freshId,
          createdAt: new Date().toISOString(),
          prompt: "send 1 USDC",
          token: "USDC",
          tokenName: "USD Coin",
          amount: "1",
          recipient: RECIPIENT,
          source: "user_wallet",
          status: "pending",
          isNative: false,
        });
        fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 2));
        const r = await post({
          action: "approve",
          transferId: freshId,
          txHash: "0x" + "ef".repeat(32),
        });
        assert(r.status === 400, `expected 400, got ${r.status}`);
        assert(
          String(r.body.error ?? "").includes("never claimed"),
          `expected a never-claimed refusal, got: ${r.body.error}`,
        );
      },
    );

    await check("an unknown action is rejected", async () => {
      const r = await post({ action: "frobnicate", transferId: id });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    console.log("");
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill?.("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    server.kill?.("SIGKILL");
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exitCode = 1;
});
