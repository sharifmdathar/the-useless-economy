/**
 * THE AGENT
 *
 * An agent is a loop:
 *   1. Send the chat + the list of tools to the LLM.
 *   2. If it wants to call a tool -> run it, send back the result, repeat.
 *   3. If it answers with text -> done.
 *
 * Week 2: the gig-economy workflow lives in agent/tools.ts (run_gig_economy),
 * so the loop stays exactly the original design — just a few more steps
 * allowed since a full run is 3 providers + 3 judges.
 *
 * Provider note: this loop used to speak Gemini's native function-calling
 * protocol (functionCalls / functionResponse / Content-parts). It now speaks
 * the OpenAI wire format, because Groq is OpenAI-compatible — and the shape
 * maps one-to-one:
 *
 *   Gemini                                  OpenAI/Groq
 *   ───────────────────────────────────────  ─────────────────────────────
 *   config.systemInstruction                 messages[0] = {role:"system"}
 *   tools:[functionDeclarations]             tools:[{type:"function",function:{…}}]
 *   contents (role/parts)                    messages (role/content)
 *   response.functionCalls[]                  message.tool_calls[]
 *   call.args (an object already)            call.function.arguments (JSON STRING)
 *   {functionResponse:{id,name,response}}    {role:"tool",tool_call_id,content}
 *   call.id (may be undefined)               call.id (always present)
 *
 * The tool schemas in tools.ts are plain JSON Schema, so they cross over
 * unchanged — no schema rewriting anywhere.
 */
import { tools } from "./tools";
import { ACTIVE_PROVIDER, GROQ_BASE_URL, MODEL, withRetry } from "@/lib/llm";

export { ACTIVE_PROVIDER, MODEL };

// A full run_gig_economy is 6+ LLM calls; the kit default of 5 steps can
// cut a workflow mid-flight, so allow a few extra hops.
const MAX_STEPS = 10;

const SYSTEM_PROMPT =
  "You are the Foreman of the Useless Economy, a gig market for pointless jobs run by AI " +
  "providers (Soleil rates sunsets, Feathers counts pigeons, Cap'n translates to pirate). " +
  "Use your tools when they help: commission providers, judge their work (1-5), and log results. " +
  "For 'run the economy on X' or 'who wins on X' use run_gig_economy. Keep answers short and " +
  "friendly.";

export type ChatMessage = { role: "user" | "agent"; text: string };
export type Step = {
  tool: string;
  args: unknown;
  result: unknown;
  error?: boolean;
};

type ToolCall = {
  id: string;
  // Groq's validator demands `type` on a replayed assistant tool_calls entry,
  // even though OpenAI's spec treats it as optional. Always set it.
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Gemini-only: the opaque signature Gemini 3+ returns ON THE PART (a sibling
   * of functionCall) when it asks for a tool. Sending that functionCall back
   * without the signature is a hard 400 ("Function call is missing a
   * thought_signature in functionCall parts"), so it has to ride along with
   * the call through the loop. Groq never emits it, and only the Gemini
   * branch below consumes it, so the OpenAI wire format stays clean.
   */
  thoughtSignature?: string;
};

/** Parse the arguments string we replay, defaulting to {} on garbage. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** OpenAI-style message union — the only history shape either provider needs. */
type Message =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

// The Foreman's tool surface, in the OpenAI shape. Built once at module load:
// 14 tools, so the map is trivial.
const OPENAI_TOOLS = tools.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

/** POST JSON, turning a non-2xx into an error carrying the HTTP status. */
async function postJson(url: string, body: unknown, auth: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text.slice(0, 300)}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * One completion, returning the text plus any tool calls. Both providers are
 * funnelled through here so the loop below stays provider-agnostic.
 */
async function complete(
  messages: Message[],
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  if (ACTIVE_PROVIDER === "groq") {
    const data = (await withRetry(() =>
      postJson(
        `${GROQ_BASE_URL}/openai/v1/chat/completions`,
        {
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          tools: OPENAI_TOOLS,
          tool_choice: "auto",
        },
        process.env.GROQ_API_KEY ?? "",
      ),
    )) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    const msg = data.choices?.[0]?.message;
    return {
      text: msg?.content ?? "",
      // No thoughtSignature on the OpenAI path — the field is Gemini-only.
      toolCalls: (msg?.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `call_${i}`,
        type: "function" as const,
        function: {
          name: c.function?.name ?? "",
          arguments: c.function?.arguments ?? "{}",
        },
      })),
    };
  }

  // ─── Gemini path (the original provider) ───
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  // Gemini accepts only "user" and "model" roles — an OpenAI-shaped "tool"
  // turn is rejected outright (your 400). So translate the message list:
  //   assistant + tool_calls -> one model turn of functionCall parts
  //   tool                    -> that content as a user-turn functionResponse
  //   anything else           -> verbatim
  const contents = messages.map((m) => {
    if (m.role === "assistant" && "tool_calls" in m) {
      const parts = m.tool_calls.map((c) => ({
        functionCall: {
          name: c.function.name,
          args: parseArgs(c.function.arguments),
        },
        // Replay the signature EXACTLY where Gemini put it. Gemini 3+ treats
        // the first functionCall of each step in the current turn as required
        // to carry it and answers 400 without it; parallel follow-up calls
        // carry none, which is what we record.
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      }));
      return { role: "model", parts };
    }
    if (m.role === "tool") {
      // Gemini's proto accepts ONLY {name, response} on a functionResponse.
      // Sending our raw result object at the top level (the {winner,
      // standings, ...} shape our tools return) is rejected as unknown
      // fields, so it must be nested under `response`, with a name alongside.
      let payload: unknown = m.content;
      try {
        payload = JSON.parse(m.content);
      } catch {
        // a non-JSON string stays a string and is wrapped below
      }
      // `response` is a protobuf Struct, so it must be a JSON OBJECT. The
      // persona tools (rate_sunset, count_pigeons, pirate_translate) return a
      // bare string, which Gemini rejects with "Invalid value at
      // 'contents[N].parts[0].function_response.response' (type.googleapis.com/
      // google.protobuf.Struct)". Wrap those under `output`, the key the SDK
      // docs nominate for function output.
      const response: Record<string, unknown> =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : { output: payload };
      return {
        role: "user",
        parts: [
          { functionResponse: { name: "tool_result", response } },
        ],
      };
    }
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: (m.content as string) ?? "" }],
    };
  });
  const data = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
      },
    }),
  );
  // Read the raw PARTS rather than `data.functionCalls`: that getter maps a
  // part down to its bare functionCall and drops the sibling thoughtSignature,
  // which is exactly the field Gemini 3+ refuses to have missing on replay.
  const parts = (data.candidates?.[0]?.content?.parts ?? []) as {
    functionCall?: { id?: string; name?: string; args?: object };
    thoughtSignature?: string;
  }[];
  let n = 0;
  return {
    text: data.text ?? "",
    // Gemini hands back args already parsed; wrap into the OpenAI shape
    // (arguments as a JSON string) so callers need no branching.
    toolCalls: parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const c = p.functionCall!;
        return {
          id: c.id ?? `call_${n++}`,
          type: "function" as const,
          function: {
            name: c.name ?? "",
            arguments: JSON.stringify(c.args ?? {}),
          },
          ...(p.thoughtSignature
            ? { thoughtSignature: p.thoughtSignature }
            : {}),
        };
      }),
  };
}

export async function runAgent(
  history: ChatMessage[],
  ctx: { baseUrl: string },
) {
  const messages: Message[] = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  const steps: Step[] = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    const { text, toolCalls } = await complete(messages);

    if (toolCalls.length === 0) return { answer: text, steps };

    // Keep the model's turn in the history, then run every tool it asked for.
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.function.name);
      let args: unknown = {};
      try {
        // Groq sends the arguments as a JSON STRING; a malformed one (the
        // known weak spot of a 70B on a 14-tool surface) shows up as {} here
        // rather than crashing the loop.
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      let result: unknown;
      let error = false;
      try {
        if (!tool) throw new Error(`No tool named ${call.function.name}`);
        result = await tool.run(args, ctx);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
        error = true;
      }
      steps.push({ tool: call.function.name, args, result, error });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { answer: "I hit my step limit. Try a simpler question.", steps };
}
