/**
 * Test the standings grounding.
 *
 * The bug this covers: the agent's chat prose restated the scores that
 * run_gig_economy had recorded, and sometimes got them wrong (a 3 called a
 * five, an invented tie-break). The server now renders the standings from
 * the recorded tool result and strips the prose's own score claims.
 *
 * Run: JITI_TSCONFIG_PATHS=true node_modules/.bin/jiti scripts/test-standings-grounding.ts
 */
import { strict as assert } from "node:assert";

import {
  extractStandings,
  standingsFromSteps,
  stripScoreClaims,
  providerName,
} from "../agent/standings";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(
      `       ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ─── extractStandings ────────────────────────────────────────────────────

check("extracts provider, score and feedback from a recorded result", () => {
  const s = extractStandings({
    winner: { provider: "feathers", score: 5, feedback: "A feathered flourish." },
    standings: [
      { provider: "feathers", score: 5, feedback: "A feathered flourish." },
      { provider: "capn", score: 4, feedback: "Solid pirate flair." },
      { provider: "soleil", score: 3, feedback: "A decent critique." },
    ],
    deliverables: { feathers: "..." },
  });
  assert.ok(s, "expected a standings table");
  assert.equal(s!.rows.length, 3);
  assert.equal(s!.rows[0].provider, "feathers");
  assert.equal(s!.rows[0].score, 5);
  assert.equal(s!.winner!.provider, "feathers");
});

check("returns null for a result with no standings", () => {
  assert.equal(extractStandings({ error: "boom" }), null);
  assert.equal(extractStandings({ standings: [] }), null);
  assert.equal(extractStandings("not an object"), null);
  assert.equal(extractStandings(undefined), null);
});

check("falls back to the top-ranked row when the winner is missing", () => {
  const s = extractStandings({
    standings: [
      { provider: "capn", score: 5, feedback: "x" },
      { provider: "soleil", score: 2, feedback: "y" },
    ],
  });
  assert.equal(s!.winner!.provider, "capn");
  assert.equal(s!.winner!.score, 5);
});

check("skips malformed rows instead of rendering NaN", () => {
  const s = extractStandings({
    standings: [
      { provider: "soleil", score: 4, feedback: "ok" },
      { provider: "capn" },
      { score: 3 },
      "garbage",
    ],
  });
  assert.equal(s!.rows.length, 1);
  assert.equal(s!.rows[0].provider, "soleil");
});

// ─── standingsFromSteps ──────────────────────────────────────────────────

check("finds the standings among a run's steps", () => {
  const s = standingsFromSteps([
    { tool: "rate_sunset", result: { rating: 8 } },
    {
      tool: "run_gig_economy",
      result: {
        standings: [
          { provider: "capn", score: 5, feedback: "a" },
          { provider: "soleil", score: 3, feedback: "b" },
        ],
      },
    },
  ]);
  assert.ok(s);
  assert.equal(s!.rows.length, 2);
});

check("uses the LAST run when the economy ran twice", () => {
  const s = standingsFromSteps([
    {
      tool: "run_gig_economy",
      result: { standings: [{ provider: "soleil", score: 5, feedback: "a" }] },
    },
    {
      tool: "run_gig_economy",
      result: { standings: [{ provider: "capn", score: 2, feedback: "b" }] },
    },
  ]);
  assert.equal(s!.rows[0].provider, "capn");
});

check("returns null when no step carried standings", () => {
  assert.equal(
    standingsFromSteps([{ tool: "log_to_ledger", result: { ok: true } }]),
    null,
  );
  assert.equal(standingsFromSteps([]), null);
  assert.equal(standingsFromSteps(undefined), null);
});

// ─── stripScoreClaims ────────────────────────────────────────────────────

check("removes the prose's own markdown table", () => {
  const prose = [
    "Here is how the three providers did:",
    "",
    "| Provider | Score | Quick note |",
    "|---|---|---|",
    "| **Feathers** | **5** | a heartfelt count |",
    "| **Cap'n** | 4 | pirate flair |",
    "",
    "Let me know if you want to tip the winner.",
  ].join("\n");
  const out = stripScoreClaims(prose);
  assert.ok(!out.includes("|---"), "the table separator should be gone");
  assert.ok(!out.includes("**Feathers** |"), "the table rows should be gone");
  assert.ok(
    out.includes("Here is how the three providers did:"),
    "prose should survive",
  );
  assert.ok(out.includes("tip the winner"), "closing prose should survive");
});

check("removes a winner claim", () => {
  const prose = "**Winner:** **Soleil** (5 ⭐) – a poetic sunlit masterpiece.";
  const out = stripScoreClaims(prose);
  assert.ok(!/winner/i.test(out), `winner claim should be gone, got: ${out}`);
});

check("removes a score-in-a-sentence claim", () => {
  const out = stripScoreClaims("Soleil takes the crown, five stars.");
  assert.ok(!out.includes("Soleil"), `should be gone, got: ${out}`);
});

check("removes a 'X scored N' sentence", () => {
  const out = stripScoreClaims("Cap'n scored 4 out of 5.");
  assert.ok(!out.includes("Cap'n"), `should be gone, got: ${out}`);
});

check("keeps prose that mentions a provider without a number", () => {
  const prose = "Feathers had a go at counting the pigeons.";
  const out = stripScoreClaims(prose);
  assert.ok(out.includes("Feathers"), `should be kept, got: ${out}`);
});

check("removes a runner-up line with a curly apostrophe", () => {
  // The model writes "Cap'n" with U+2019 often enough that an ASCII-only
  // match misses it, and a missed match lets a wrong score into the UI.
  const prose = "Runner‑up: Cap’n – 5 ⭐ (pirate‑flavored translation)";
  const out = stripScoreClaims(prose);
  assert.ok(!out.includes("Runner"), `should be gone, got: ${out}`);
  assert.ok(!out.includes("5"), `score should be gone, got: ${out}`);
});

check("removes a runner-up line with a plain apostrophe", () => {
  const out = stripScoreClaims("Runner-up: Cap'n - 5 (pirate-flavoured)");
  assert.ok(!out.includes("Runner"), `should be gone, got: ${out}`);
});

check("removes a bare number attached to a provider", () => {
  assert.ok(!stripScoreClaims("Soleil – 4").includes("Soleil"));
  assert.ok(!stripScoreClaims("Cap'n: 3").includes("Cap'n"));
  assert.ok(!stripScoreClaims("**Feathers** — 2/5").includes("Feathers"));
});

check("removes a crown claim", () => {
  const out = stripScoreClaims("Soleil takes the crown, five stars.");
  assert.ok(!out.includes("Soleil"), `should be gone, got: ${out}`);
});

check("removes a star-rating line", () => {
  const out = stripScoreClaims("Soleil: 4 ⭐");
  assert.ok(!out.includes("Soleil"), `should be gone, got: ${out}`);
});

check("keeps a provider line with an unrelated number", () => {
  const prose = "Feathers counted 3 pigeons in the square.";
  const out = stripScoreClaims(prose);
  assert.ok(out.includes("Feathers"), `should be kept, got: ${out}`);
});

check("removes a label left empty by the stripping", () => {
  // "Standings:" on its own would read as a heading with nothing under it.
  assert.ok(!stripScoreClaims("Standings:").includes("Standings"));
  assert.ok(!stripScoreClaims("**Results:**").includes("Results"));
  assert.ok(!stripScoreClaims("Final verdict:").includes("verdict"));
});

check("keeps a label that has content after it", () => {
  const out = stripScoreClaims("Standings: the three providers differed in style.");
  assert.ok(out.includes("Standings"), `should be kept, got: ${out}`);
});

check("leaves non-gig answers completely alone", () => {
  const prose = "Your wallet holds 12.5 USDC and the price is 3.";
  assert.equal(stripScoreClaims(prose), prose);
});

check("handles empty text", () => {
  assert.equal(stripScoreClaims(""), "");
});

// ─── providerName ────────────────────────────────────────────────────────

check("maps provider ids to display names", () => {
  assert.equal(providerName("soleil"), "Soleil");
  assert.equal(providerName("feathers"), "Feathers");
  assert.equal(providerName("capn"), "Cap'n");
  assert.equal(providerName("unknown"), "unknown");
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) {
  console.error("STANDINGS GROUNDING: FAILED");
  process.exit(1);
}
console.log("STANDINGS GROUNDING: PASSED");
