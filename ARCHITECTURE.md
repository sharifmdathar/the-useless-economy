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
   judge (strict, independent Gemini call, 1-5)
                              ▼
   ledger.json (append-only, serialized writes)
                              ▼
   tips (on-chain USDC transfer) → report.md (weekly)
```

## Files that matter

| Path                    | Role                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/tools.ts`        | Every tool: 3 persona providers, judge, ledger, run_gig_economy, commission_job (x402 + negotiation), tip_provider (on-chain), set_provider_status, read_ledger, generate_report, wallet tools. Hard caps + KILL_SWITCH live here. |
| `agent/agent.ts`        | The gemini loop (MAX_STEPS=10, Foreman persona).                                                                                                                                                                                   |
| `agent/wallet.ts`       | EIP-3009 x402 buyer + seller (sign/verify/settle, USDC Base Sepolia).                                                                                                                                                              |
| `lib/x402-seller.ts`    | Shared provider-route guard: 402 requirements / verify / settle.                                                                                                                                                                   |
| `lib/judge.ts`          | Independent strict judge prompt + heuristic fallback.                                                                                                                                                                              |
| `lib/ledger.ts`         | Append-only ledger module used by provider-side flows.                                                                                                                                                                             |
| `app/providers/*`       | The three provider services (personas + x402 walls).                                                                                                                                                                               |
| `ledger.json`           | Append-only market data: {ts, jobType, provider, quotedPrice, paidAmount, txHash?, qualityScore, verdict, tipUsdc}                                                                                                                 |
| `.provider-status.json` | Blacklist state.                                                                                                                                                                                                                   |

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
