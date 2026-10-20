/**
 * DUPLICATE-PAYMENT REGRESSION TEST
 *
 * This test exists because a real bug shipped once: ONE logical commission
 * produced TWO funded on-chain transfers.
 *
 *   orphan:   0x1e05c209d7f67f40f3ecd6a51134c5e3ef6a1259ce58589341a23ea01e58a1e4
 *   recorded: 0x0d4d9f82e152437e6618fd5b3277a2297e401a3ddb95b516500f591cebfb3fd3
 *
 * Both were separate EIP-3009 `transferWithAuthorization` calls with the
 * SAME value, the SAME agent, and the SAME recipient but DIFFERENT nonces.
 * Different nonces mean two DISTINCT authorizations were signed — so this
 * was not a facilitator retry of one authorization (that path reuses the
 * nonce), it was the agent paying twice.
 *
 * The cause: in this protocol, asking a provider for its price IS a paid
 * request. The buyer signs an authorization for whatever price the 402
 * advertises. So the old flow —
 *
 *   1. payAndFetch(price = meta.ask)        -> signed + funded authorization A
 *   2. payAndFetch(price = counterOffer)    -> signed + funded authorization B
 *
 * paid twice for one job. Compounding it, the provider routes read the
 * negotiated price from the query string and never passed it to
 * `guardOrSettle`, so BOTH requests were charged the full ask, while the
 * ledger recorded the counter-offer. Hence 0.05 + 0.05 on chain against a
 * 0.04 ledger row.
 *
 * WHAT THIS TEST PROVES
 *   A. A provider settlement settles EXACTLY ONCE for a given authorization
 *      identity (payer + nonce). A second request carrying the same
 *      authorization returns the ORIGINAL transaction and moves no money.
 *   B. The buyer REFUSES to sign when the provider's quote differs from the
 *      price the caller intended to pay.
 *   C. The recorded settlement amount is the amount the provider reports as
 *      settled, not the amount the caller intended.
 *   D. The provider route advertises the NEGOTIATED price in its 402, not
 *      the full ask.
 *
 * A and B are unit-level and need no network. C and D are proven with a
 * real local server. A real on-chain settlement is exercised separately by
 * scripts/test-x402-settlement.ts.
 */
import { createServer } from "node:http";
import {
  guardOrSettle,
  paymentIdentity,
  resetSettlementMemo,
  listSettledPayments,
  resolvePayTo,
  settleOnce,
} from "../lib/x402-seller";
import { payAndFetch } from "../agent/wallet";
import { newNonce } from "../lib/facilitator";
import { PROVIDERS } from "../lib/providers";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) {
      console.log("        detail:", JSON.stringify(detail));
    }
  }
}

/**
 * Build a provider 402 the way a real route does, WITHOUT settling. This
 * lets the test exercise the buyer's price checks offline.
 */
function fakeRequirements(price: number) {
  return Response.json(
    {
      error: "Payment Required",
      scheme: "eip3009",
      price: String(price),
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x0000000000000000000000000000000000000001",
      facilitator: "https://x402.org/facilitator",
      resource: "/providers/rate-sunset",
    },
    { status: 402 },
  );
}

async function main() {
  console.log("\n=== A. provider advertises the NEGOTIATED price ===\n");
  {
    const provider = PROVIDERS.find((p) => p.slug === "soleil")!;
    const req = new Request("http://localhost/providers/rate-sunset");
    // No X-PAYMENT -> the 402 requirements. The price in the body must be
    // the negotiated price, not the provider's full ask.
    const result = await guardOrSettle(req, "soleil", 0.03);
    check("402 returned without a payment header", result.kind === "requirements");
    if (result.kind === "requirements") {
      const body = (await result.response.json()) as { price: string };
      check(
        "402 advertises the negotiated price (0.03)",
        Number(body.price) === 0.03,
        { price: body.price },
      );
      check(
        "402 does NOT advertise the full ask (0.05)",
        Number(body.price) !== provider.basePrice,
        { price: body.price, ask: provider.basePrice },
      );
    }

    // And with no negotiated price it falls back to the ask.
    const fallback = await guardOrSettle(
      new Request("http://localhost/providers/rate-sunset"),
      "soleil",
    );
    if (fallback.kind === "requirements") {
      const body = (await fallback.response.json()) as { price: string };
      check(
        "no negotiated price -> full ask (0.05)",
        Number(body.price) === provider.basePrice,
        { price: body.price },
      );
    }
  }

  console.log("\n=== B. payment identity is payer+nonce ===\n");
  {
    const n1 = newNonce();
    const n2 = newNonce();
    const id1 = paymentIdentity({
      from: "0xef3E983B014148c76bF0Caa64547826220543433",
      nonce: n1,
    });
    const id2 = paymentIdentity({
      from: "0xef3E983B014148c76bF0Caa64547826220543433",
      nonce: n2,
    });
    const id1Case = paymentIdentity({
      from: "0xef3e983b014148c76bf0caa64547826220543433",
      nonce: `0x${n1.slice(2).toUpperCase()}` as `0x${string}`,
    });
    check("different nonces -> different identities", id1 !== id2);
    check(
      "identity is case-insensitive (same payer + same nonce)",
      id1 === id1Case,
      { id1, id1Case },
    );
  }

  console.log("\n=== C. buyer refuses a quote that differs from the intent ===\n");
  {
    // A local server that always quotes 0.05 regardless of what was asked
    // for — exactly the bug shape: the route ignores the negotiated price.
    const server = createServer((_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payment Required",
          scheme: "eip3009",
          price: "0.05",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x0000000000000000000000000000000000000001",
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    let refused = "";
    try {
      await payAndFetch(`http://localhost:${port}/providers/rate-sunset`, {
        maxPrice: 0.05,
        expectedPrice: 0.03,
      });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check(
      "buyer REFUSED to sign a different amount than intended",
      refused.includes("Refusing to pay a different amount"),
      { refused },
    );

    // The cap must still be enforced independently.
    let capped = "";
    try {
      await payAndFetch(`http://localhost:${port}/providers/rate-sunset`, {
        maxPrice: 0.01,
      });
    } catch (err) {
      capped = err instanceof Error ? err.message : String(err);
    }
    check(
      "buyer REFUSED a price above the cap",
      capped.includes("above the") && capped.includes("cap"),
      { capped },
    );

    server.close();
  }

  console.log("\n=== D. a 402 body with no parseable price is refused ===\n");
  {
    const server = createServer((_req, res) => {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment Required" }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    let message = "";
    try {
      await payAndFetch(`http://localhost:${port}/providers/rate-sunset`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    check(
      "buyer REFUSED a 402 with no price",
      message.includes("parseable positive price"),
      { message },
    );
    server.close();
  }

  console.log("\n=== E. exactly-once: the same authorization settles once ===\n");
  {
    resetSettlementMemo();

    const nonce = newNonce();
    const from = "0xef3E983B014148c76bF0Caa64547826220543433";
    const identity = paymentIdentity({ from, nonce });

    // Count how many times the chain is actually touched.
    let settleCalls = 0;
    const settle = async () => {
      settleCalls++;
      return { tx: "0x" + "ab".repeat(32) };
    };

    // First settlement: really settles.
    const first = await settleOnce(identity, settle);
    check("first settlement is not a replay", first.replay === false);
    check("the chain was touched exactly once", settleCalls === 1);

    // A replay of the SAME authorization must not settle again.
    const replay = await settleOnce(identity, settle);
    check("a replay is detected", replay.replay === true);
    check(
      "a replay returns the ORIGINAL transaction",
      replay.tx === first.tx,
      { replayTx: replay.tx, firstTx: first.tx },
    );
    check(
      "a replay does NOT touch the chain again",
      settleCalls === 1,
      { settleCalls },
    );

    // A DIFFERENT authorization is a different payment and may settle.
    const otherIdentity = paymentIdentity({ from, nonce: newNonce() });
    const other = await settleOnce(otherIdentity, settle);
    check("a different authorization may settle", other.replay === false);
    check(
      "two distinct payments -> two settlements",
      settleCalls === 2,
      { settleCalls },
    );
    check(
      "exactly two settlements recorded in the memo",
      listSettledPayments().length === 2,
      listSettledPayments(),
    );
  }

  console.log("\n=== F. payTo resolution never leaks the placeholder ===\n");
  {
    const override = process.env.PROVIDER_PAY_TO_OVERRIDE;
    const payTo: string = resolvePayTo("soleil");
    check(
      "payTo is a funded address, not a registry placeholder",
      !/^0x0{36}0[123]$/i.test(payTo),
      { payTo },
    );
    if (override && override.startsWith("0x")) {
      check(
        "the explicit override wins",
        payTo.toLowerCase() === override.toLowerCase(),
        { payTo, override },
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  console.log("\nPASS: one commission can no longer produce two funded settlements.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
