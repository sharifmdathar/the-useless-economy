/**
 * GROUNDING THE STANDINGS
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent's final answer is free-form prose written by the LLM after the
 * tools have run. The tool `run_gig_economy` returns a structured result:
 * the judged score and feedback for every provider, the winner, and the
 * deliverables. The prose, however, is the model *re-describing* that
 * structure from memory — and it gets the numbers wrong.
 *
 * Observed in the running app: a real run recorded Feathers 5, Cap'n 4,
 * Soleil 3 in the tool result, while the chat bubble told the user
 * "Soleil takes the crown, five stars" — a provider that had actually
 * scored 3, plus an invented tie-break. The user reads the bubble, not
 * the tool JSON, so the app was displaying a score that never happened.
 *
 * This is the same class of bug as the ledger one: when a number is a
 * RECORD of what the system did, it must come from code, not from the
 * model's retelling of it.
 *
 * WHAT THIS DOES
 * --------------
 * `buildStandingsTable` renders the standings table and the winner line
 * directly from the tool's recorded result. The API route sends it to the
 * UI alongside the prose, and the UI renders it as a table and replaces
 * the prose's score claims with it.
 *
 * The prose is still shown — it carries the colour ("a heartfelt, albeit
 * messy, pigeon count") and the conversational voice. Only the NUMBERS
 * come from code.
 */

/** One row of a recorded standings table. */
export type Standing = {
  provider: string;
  score: number;
  feedback: string;
};

export type StandingsTable = {
  /** Rows in rank order, exactly as the tool ranked them. */
  rows: Standing[];
  /** The recorded winner, or null when there were no standings. */
  winner: { provider: string; score: number; feedback: string } | null;
  /** The job the run was for, if the tool reported one. */
  job?: string;
  /** Providers that sat the run out. */
  excluded?: string[];
};

/** The display name for a provider id, matching the personas in tools.ts. */
const PROVIDER_NAMES: Record<string, string> = {
  soleil: "Soleil",
  feathers: "Feathers",
  capn: "Cap'n",
  cap: "Cap'n",
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id.toLowerCase()] ?? id;
}

/**
 * Pull the recorded standings out of a tool result.
 *
 * Returns null for anything that is not a run_gig_economy result with
 * standings, so callers can leave the answer untouched for every other
 * kind of tool call.
 */
export function extractStandings(result: unknown): StandingsTable | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;

  const rawStandings = r.standings;
  if (!Array.isArray(rawStandings) || rawStandings.length === 0) return null;

  const rows: Standing[] = [];
  for (const entry of rawStandings) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    const provider = typeof s.provider === "string" ? s.provider : null;
    const score = typeof s.score === "number" ? s.score : null;
    if (!provider || score === null) continue;
    rows.push({
      provider,
      score,
      feedback: typeof s.feedback === "string" ? s.feedback : "",
    });
  }
  if (rows.length === 0) return null;

  // The winner is recorded by the tool. Fall back to the top-ranked row if
  // a result carries standings but no explicit winner.
  const rawWinner = r.winner as Record<string, unknown> | undefined;
  let winner: StandingsTable["winner"] = null;
  if (rawWinner && typeof rawWinner.provider === "string") {
    winner = {
      provider: rawWinner.provider,
      score: typeof rawWinner.score === "number" ? rawWinner.score : 0,
      feedback: typeof rawWinner.feedback === "string" ? rawWinner.feedback : "",
    };
  } else {
    const top = rows[0];
    winner = {
      provider: top.provider,
      score: top.score,
      feedback: top.feedback,
    };
  }

  const excluded = Array.isArray(r.excluded)
    ? r.excluded.filter((e): e is string => typeof e === "string")
    : undefined;

  return {
    rows,
    winner,
    job: typeof r.job === "string" ? r.job : undefined,
    excluded,
  };
}

/**
 * Find the recorded standings among an agent run's steps.
 *
 * The agent may call other tools before or after the economy run, so this
 * scans every step and returns the LAST one that carries standings — the
 * most recent run wins if the user ran the economy twice.
 */
export function standingsFromSteps(steps: unknown): StandingsTable | null {
  if (!Array.isArray(steps)) return null;
  let found: StandingsTable | null = null;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const result = (step as { result?: unknown }).result;
    const s = extractStandings(result);
    if (s) found = s;
  }
  return found;
}

/**
 * Remove the model's own score claims from the prose.
 *
 * The prose restates the standings — usually as a markdown table, a
 * "**Winner:** ..." line, or a "Runner-up: Cap'n – 5 ⭐" line — and that
 * restatement is where the wrong numbers come from. The UI renders a real
 * table from the recorded result, so the prose's version is dropped:
 * keeping it would show the same run twice with two different sets of
 * scores.
 *
 * What survives is the prose that is NOT a score claim: the opening line
 * about the job, the judge's colour ("a heartfelt, albeit messy, pigeon
 * count"), the closing offer to tip the winner.
 */
export function stripScoreClaims(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // A markdown table row: "| **Soleil** | **5** | note |". The table is
    // dropped whole — the UI renders a real one from the recorded result.
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) continue;

    // A winner claim: "**Winner:** Soleil (5 ⭐)" or "Winner: Cap'n (5)".
    if (/^\**winner\**\s*:/i.test(trimmed)) continue;

    // A label whose content was all score claims: "Standings:", "Results:".
    // Left alone it reads as a heading with nothing under it.
    //
    // The bold markers can sit on either side of the colon — "**Results**:"
    // and "**Results:**" are both things the model writes — so match
    // against the bold-stripped line.
    const bare = trimmed.replace(/\*\*/g, "");
    if (
      /^(final\s+)?(standings|results?|scores?|ranking|rankings|breakdown|verdict|tally)\s*:?\s*$/i.test(
        bare,
      )
    ) {
      continue;
    }

    // A score claim attached to a provider.
    if (isScoreClaim(trimmed)) continue;

    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Providers, matched after normalisation (see `normalizeLine`). */
const PROVIDER_PATTERN = /\b(soleil|feathers|capn)\b/;

/**
 * Words that mark a competitive judgement. A provider mentioned next to
 * one of these and a small number is a score claim, even when the number
 * carries no unit ("Soleil took the crown with 5").
 */
const COMPETITIVE_WORD =
  /\b(crown|crowns|winner|wins|won|beat|beats|takes?|took|top|first|second|third|runner|rank|ranking|place|places|score[ds]?|scoring|star[s]?|point[s]?|out of|front)\b/i;

/**
 * Normalise a line so provider names match however the model spelled them.
 *
 * The model writes "Cap'n" with a curly apostrophe (U+2019) often enough
 * that a plain ASCII match misses it — and a missed match means a wrong
 * score survives into the UI.
 */
function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc\u00b4`]/g, "") // apostrophes
    .replace(/[\u2010-\u2015\u2212]/g, "-"); // dashes
}

/**
 * True when a line states a provider's score.
 *
 * Deliberately narrow. It must see a provider AND a score in a shape that
 * is unambiguously a score:
 *   - a rating out of five: "4/5"
 *   - a star rating: "5 ⭐", "five stars"
 *   - an explicit score verb: "scored 4", "4 out of 5"
 *   - a bare number attached to the provider: "Soleil – 4", "Cap'n: 3"
 *   - a competitive word next to a provider and a number: "took the crown
 *     with 5"
 *
 * A line that merely mentions a provider alongside an unrelated number
 * ("Feathers counted 3 pigeons") is left alone.
 */
function isScoreClaim(line: string): boolean {
  const n = normalizeLine(line);
  if (!PROVIDER_PATTERN.test(n)) return false;

  // A number 1-5 (or its word) somewhere in the line.
  const hasNumber =
    /\b[1-5]\b/.test(n) || /\b(one|two|three|four|five)\b/.test(n);
  if (!hasNumber) return false;

  // An unambiguous rating shape.
  if (/\b[1-5]\s*\/\s*5\b/.test(n)) return true;
  if (/\b[1-5]\s*⭐/.test(n)) return true;
  if (/\b([1-5]|one|two|three|four|five)\s*stars?\b/.test(n)) return true;
  if (/\b(out of|scored?|scoring|score[ds]?)\b/.test(n)) return true;

  // A bare number attached to the provider: "Soleil - 4", "Capn: 3".
  if (/\b(soleil|feathers|capn)\b\s*[-:–—]?\s*\**\b[1-5]\b/.test(n)) return true;

  // A competitive judgement with a number in it.
  if (COMPETITIVE_WORD.test(n)) return true;

  return false;
}
