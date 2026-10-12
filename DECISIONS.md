# DECISIONS.md — judgment calls log

- **2026-10-13 — Scaffold strategy:** `npx agentmaxxin` failed under the user's npm
  `allow-scripts` policy (EALLOWSCRIPTS on project-scoped installs). Extracted the
  agentmaxxin@0.1.0 template tarball directly, removed the `bin`/`files` scaffolder
  metadata from package.json, and added `allowScripts: {}` plus entries for
  `@google/genai` / `protobufjs` so `npm install` runs clean. Kit source itself untouched.
- **2026-10-13 — Broken `cn` imports in template:** the published agentmaxxin@0.1.0
  tarball ships UI files importing `cn` from `"cn"` (a phantom module — its
  `components.json` shadcn alias never materialized). Also `lib/utils.ts` was an
  empty stub that re-exported from itself. Rewrote `lib/utils.ts` as the standard
  shadcn helper (clsx + tailwind-merge) and repointed every `"cn"` import to
  `@/lib/utils`. Added `tailwind-merge` (small, standard for shadcn cn) — justified
  since the kit's own UI depends on it and the kit was missing the dep, not the reverse.
- **2026-10-13 — Phase 1+2 as one build:** provider routes (Soleil/Feathers/Cap'n
  personas in `app/providers/*`, quote desks at each `/quote`), strict judge in
  `lib/judge.ts` (separate Gemini call, length-heuristic fallback without a key),
  append-only serialized `ledger.json` in `lib/ledger.ts`, and the full manager
  toolset in `agent/tools.ts` (list_providers, get_quote, commission_job,
  judge_deliverable, tip_provider, set_provider_status, read_ledger,
  generate_report; kept the kit's get_my_wallet). Phase 1 "free economy" is the
  same routes with the 402 wall disabled until keys exist, so Phase 1 and 2 run
  off one codebase with payment logic dormant rather than a throwaway scaffold.
- **2026-10-13 — Placeholder payTo:** the registry carries wallet addresses for
  each provider; until Phase 3 funding, routes 402 with the placeholder slug so
  free-run testing stays possible via the paymentHeader===null && price===gate.
  `payAndFetch` from the kit signs and retries (its signature header remains the
  kit's own demo format — see Phase 3 for the real x402 scheme swap).
- **2026-10-13 — Hard caps in code, not prompts:** weekly cap (1 USDC rolling
  7d) and kill switch are enforced inside commission_job and tip_provider so
  the LLM cannot spend its way past them; DECISIONS notes each enforcement point.
- **2026-10-13 — Week 2 rescope (user request):** user asked for the pure
  TypeScript tools — rate_sunset/count_pigeons/pirate_translate as inline Gemini
  calls in agent/tools.ts, judge_deliverable (strict 1-5, {score, feedback}),
  log_to_ledger (append-only ledger.json), and run_gig_economy (job -> all 3
  providers -> judge all 3 -> log -> winner summary). agentes loop restored to
  the kit's simple design with MAX_STEPS=10 and the Foreman system prompt.
  The earlier HTTP provider routes + lib/* market modules stay in the repo for
  Week 3 (x402), but the active tool surface is now exactly the Week-2 spec —
  no crypto in tools.ts.
- **2026-10-13 — Key caveat:** the pasted GEMINI_API_KEY's project is blocked
  for inference ("Your project has been denied access"; ListModels 200 but every
  generateContent 403). All live persona runs are blocked until the user creates
  a fresh AI Studio key/project. Typecheck + build verified clean meanwhile.
