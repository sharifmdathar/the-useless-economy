import { MODEL, runAgent, ACTIVE_PROVIDER } from "@/agent/agent";
import { tools } from "@/agent/tools";
import { getTransfer } from "@/agent/transfers";
import {
  standingsFromSteps,
  stripScoreClaims,
} from "@/agent/standings";

// GET /api/agent -> setup status + the list of tools (shown on the page)
export async function GET() {
  return Response.json({
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    model: MODEL,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  });
}

// POST /api/agent { messages } -> the agent's answer + the tools it used
export async function POST(req: Request) {
  // The provider is chosen in lib/llm.ts from LLM_PROVIDER; only the ACTIVE
  // provider's key is required. A hard GEMINI_API_KEY gate here would reject
  // a Groq-configured run before the adapter ever saw it.
  if (ACTIVE_PROVIDER === "gemini" && !process.env.GEMINI_API_KEY) {
    return Response.json(
      {
        error:
          "LLM_PROVIDER=gemini but GEMINI_API_KEY is missing. Get a free key at aistudio.google.com/apikey, add it to .env, restart `npm run dev`.",
      },
      { status: 500 },
    );
  }
  if (ACTIVE_PROVIDER === "groq" && !process.env.GROQ_API_KEY) {
    return Response.json(
      {
        error:
          "LLM_PROVIDER=groq but GROQ_API_KEY is missing. Get a key at console.groq.com/keys, add it to .env, restart `npm run dev`.",
      },
      { status: 500 },
    );
  }

  const { messages } = await req.json();
  try {
    const result = await runAgent(messages, {
      baseUrl: new URL(req.url).origin,
    });

    // Surface any transfer the agent prepared, so the chat can render a
    // review card the user approves BEFORE anything is signed.
    const pending = result.steps
      .map((s) => {
        const r = s.result as { transferId?: string } | undefined;
        if (!r?.transferId) return null;
        return getTransfer(r.transferId) ?? null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    // The agent's closing answer is LLM prose. When the run was a gig
    // economy run, that prose sometimes misreports the scores the tool
    // actually recorded (it has been seen calling a 3 a five and inventing
    // a tie-break). The recorded standings are the truth, so send them
    // structured and drop the prose's own restatement of the same numbers.
    const standings = standingsFromSteps(result.steps);
    const answer = standings
      ? stripScoreClaims(result.answer)
      : result.answer;

    return Response.json({
      ...result,
      answer,
      transfers: pending,
      ...(standings ? { standings } : {}),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
