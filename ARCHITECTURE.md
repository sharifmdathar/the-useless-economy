# The Useless Economy — Architecture

Agent-to-agent gig market for pointless jobs. A MANAGER agent ("the Foreman")
hires PROVIDER agents over x402 to do useless jobs, quality-checks the work,
tips or blacklists them, keeps an append-only ledger, and publishes a weekly
"State of the Useless Economy" report.

```
              ┌──────────────────────────────────┐
              │  MANAGER agent ("the Foreman")   │
              │  agent/agent.ts + agent/tools.ts │
              │  wallet: viem, Base Sepolia      │
              └───────────────┬──────────────────┘
                              │ x402 (HTTP 402 → EIP-3009 USDC → settle)
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
 /providers/rate-sunset  /providers/count-pigeons  /providers/pirate-translate
   "Soleil"                "Feathers"                 "Cap'n"
   0.05 USDC ask           0.01 USDC ask              0.02 USDC ask
   floor 0.03              floor 0.005                floor 0.02 (no haggle)
   premium, snarky         cheap, sloppy              mid price, reliable
        └─────────────────────┴─────────────────────┘
                              ▼
   judge (strict, independent call via lib/llm.ts, 1-5)
                              ▼
   ledger.json (append-only, serialized writes)
                              ▼
   tips (on-chain USDC transfer) → report.md (weekly)
```

## Files that matter

| Path                    | Role                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/tools.ts`        | Every tool: 3 persona providers, judge (strict 1-5 + heuristic fallback), ledger writer, run_gig_economy, commission_job (x402 + negotiation), tip_provider (on-chain), set_provider_status, read_ledger, generate_report, wallet tools. Hard caps + KILL_SWITCH live here. |
| `agent/agent.ts`        | The agent loop (MAX_STEPS=10, Foreman persona). Speaks the OpenAI wire format (`tool_calls` / `role:"tool"`) and translates it to Gemini `Content` parts on the Gemini path.                                                       |
| `lib/llm.ts`            | THE LLM ADAPTER — every persona/judge call funnels through `callLLM`. Chooses the provider from `LLM_PROVIDER`, retries 429/5xx, and owns the provider fallback rules.                                                            |
| `agent/wallet.ts`       | EIP-3009 x402 buyer + seller (sign/verify/settle, USDC Base Sepolia).                                                                                                                                                              |
| `lib/x402-seller.ts`    | Shared provider-route guard: 402 requirements / verify / settle.                                                                                                                                                                   |
| `lib/provider-gemini.ts`| Shim re-exporting the adapter under the names the provider routes already import.                                                                                                                                                  |
| `lib/providers.ts`      | The provider registry (slugs, personas, asks, floors, payTo).                                                                                                                                                                       |
| `app/providers/*`       | The three provider services (personas + x402 walls).                                                                                                                                                                               |
| `ledger.json`           | Append-only market data. One row per judged job: `{ts, job, provider, providerWallet, deliverable, score, feedback, quotedPrice?, paidAmount?, txHash?, tipUsdc?, tipTxHash?}`                                                     |
| `.provider-status.json` | Blacklist state.                                                                                                                                                                                                                   |

`lib/judge.ts`, `lib/ledger.ts` and `lib/manager-prompt.ts` are Week-1/2
leftovers: nothing imports them (the judge and the ledger writes now live in
`agent/tools.ts`). `lib/judge.ts` has been deleted; the other two are kept only
as reference until someone confirms nothing external depends on them.

## LLM providers

Every persona and judge call goes through the one adapter in `lib/llm.ts`
(`callLLM`), so switching providers is an env change, not a code change.

- `LLM_PROVIDER=gemini` (default) or `groq`. Groq speaks the OpenAI-compatible
  `/openai/v1` endpoint, so its key is `GROQ_API_KEY` vs Gemini's
  `GEMINI_API_KEY`.
- **Key fallthrough:** if the selected provider has no key, the other one is
  used when it has one. `STRICT_PROVIDER=1` turns that into a hard error.
- **Models:** `GEMINI_MODEL`, `GROQ_MODEL` (primary — the Foreman's
  tool-calling loop), `GROQ_CHEAP_MODEL` (persona + judge calls). Groq meters
  each model separately on the free tier, so the cheap model is also the
  automatic fallback when the primary 429s: it adds quota rather than retrying
  into the same wall.
- **Tool-calling loops** run in two wire formats. `agent/agent.ts` keeps the
  OpenAI shape (`tool_calls` / `role:"tool"`) as the single history
  representation, and the Gemini branch translates to/from `Content` parts.

### Gemini 3+ gotchas (both cost a 400)

Gemini thinking models validate replays of tool-calling history strictly:

1. **Thought signatures.** Gemini returns an opaque `thoughtSignature` on the
   functionCall *part*, and refuses a replay of that part without it
   ("Function call is missing a thought_signature"). The SDK's convenient
   `response.functionCalls` getter maps parts down to bare functionCalls and
   drops the signature, so the loop reads `candidates[0].content.parts` and
   keeps the signature alongside each call.
2. **`functionResponse.response` must be a Struct** (a JSON object). The
   persona tools return a bare string, which Gemini rejects with "Invalid value
   ... (type.googleapis.com/google.protobuf.Struct)"; non-object results are
   wrapped as `{output: ...}`.

## Payment protocol (real, not mock)

1. Manager calls provider without payment → `402 Payment Required` carrying
   `{scheme:"eip3009", price, asset: USDC (Base Sepolia), payTo, facilitator}`.
2. Manager signs an EIP-3009 `transferWithAuthorization` typed-data
   authorization (USD Coin domain, ~1 hour validity) with its own wallet key.
3. Manager retries with `X-PAYMENT: <base64 payload + signature>`.
4. Provider verifies the signature locally (viem `verifyTypedData`), enforces
   its persona price floor, then settles on-chain via
   `USDC.transferWithAuthorization` — this broadcast produces the real tx hash.
5. Provider answers 200 with the deliverable + `settledTx`, which lands in
   ledger.json. Tips are plain `USDC.transfer` calls from the agent wallet.

## Hard limits (code-enforced, not prompt-enforced)

- `MAX_PER_JOB = 0.05` USDC — refusal happens before signing (buyer) and before
  settlement (seller floor check).
- `WEEKLY_CAP = 1` USDC rolling 7 days — checked in commission/tip tools.
- `KILL_SWITCH=1` — freezes commission + tips immediately.
- Testnet ONLY: chain pinned to Base Sepolia (84532) everywhere; keys are only
  ever read from `.agent-wallet.json` / `.provider-wallet.json` / `.env`.
