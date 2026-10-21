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
  providers -> judge all 3 -> log -> winner summary). agent loop restored to
  the kit's simple design with MAX_STEPS=10 and the Foreman system prompt.
  The earlier HTTP provider routes + lib/* market modules stay in the repo for
  Week 3 (x402), but the active tool surface is now exactly the Week-2 spec —
  no crypto in tools.ts.
- **2026-10-13 — Key caveat:** the pasted GEMINI_API_KEY's project is blocked
  for inference ("Your project has been denied access"; ListModels 200 but every
  generateContent 403). All live persona runs are blocked until the user creates
  a fresh AI Studio key/project. Typecheck + build verified clean meanwhile.
- **2026-10-13 — Week 3 payment scheme:** the kit's payAndFetch/verifyPayment sign a
  custom JSON blob; that never goes on-chain and is not what the public x402
  facilitator validates. Implementing the real flow instead: buyer signs an
  EIP-3009 transferWithAuthorization (USDC on Base Sepolia), seller verifies the
  signature locally and settles on-chain, then returns X-PAYMENT-RESPONSE with the
  tx hash. Facilitator keeps being hit for scheme validation only.
- **2026-10-13 — Testnet-only guard:** Testnet-only: never mainnet; chain pinned to
  baseSepolia in every viem client; no key ever logged or echoed; .agent-wallet.json
  gitignored; kill switch + caps enforced in tool code, not in prompts.
- **2026-10-13 — payTo placeholder addresses:** registry ships 0x...01/02/03 as
  Soleil/Feathers/Cap'n payTo defaults. These are NOT real wallets; a real
  deployment sets PROVIDER_PAY_TO_OVERRIDE in .env (single sink) or edits the
  registry after creating .provider-wallet.json via the new createProviderWallet
  helper. The test "provider balance rises" therefore checks whatever address the
  requirement advertised and was actually settled to.
- **2026-10-13 — Week 3 x402 flow verified at the wire level:** with PAYWALL=1,
  curl tests against /providers/rate-sunset confirmed: (a) unpaid call -> real
  x402 402 with {scheme, price, asset=Base Sepolia USDC, payTo, facilitator};
  (b) forged X-PAYMENT -> 402 "Invalid authorization" (verifyTypedData rejects);
  (c) a genuinely signed EIP-3009 authorization from a throwaway buyer key passed
  local verification and reached the on-chain settle call, reverting ONLY because
  the settlement wallet has zero testnet ETH ("gas required exceeds allowance");
  (d) a genuinely signed below-floor payment -> 402 "Payment below persona floor"
  (0.005 < Soleil's 0.03). The throwaway buyer key (all-ones test vector, no
  funds) was used only in /tmp for these wire tests, never registered as the
  agent's wallet, and the test script was deleted after use — agent keys still
  come only from .agent-wallet.json/.env per the charter.
- **2026-10-13 — Settlement wallet zero-gas limitation:** the full on-chain
  settlement (txHash in ledger, provider balance rises) requires the settlement
  wallet to hold Base Sepolia ETH for gas and the agent wallet to hold testnet
  USDC; both are faucet steps only the user can perform.  Code path is verified up to the contract call and the revert was handled cleanly
  (502 with reason).
- **2026-10-16 — One LLM adapter behind `LLM_PROVIDER`:** persona/judge calls
  previously hit Gemini directly (`lib/provider-gemini.ts` + an inline
  `GoogleGenAI` in `agent/tools.ts`). Everything now funnels through `callLLM`
  in `lib/llm.ts`, so the provider is an env choice: `LLM_PROVIDER=gemini` or
  `groq` (OpenAI-compatible `/openai/v1`). A missing key for the selected
  provider falls through to the other one (STRICT_PROVIDER=1 makes it a hard
  error), and on Groq the persona/judge traffic goes to `GROQ_CHEAP_MODEL` —
  each Groq model has its own free-tier quota, so the cheap model doubles as
  the 429 fallback instead of retrying into the same wall. The agent loop keeps
  ONE history representation (the OpenAI `tool_calls` / `role:"tool"` shape)
  and translates to Gemini `Content` parts on the Gemini branch.
  `lib/provider-gemini.ts` stays as a shim re-exporting the adapter so the
  provider routes needed no edits.
- **2026-10-17 — Gemini 3+ tool-loop replays, two separate 400s:** (a) Gemini
  returns an opaque `thoughtSignature` on the functionCall PART and rejects a
  replay without it; the SDK's `response.functionCalls` getter strips it, so
  the loop now reads `candidates[0].content.parts` and carries the signature
  alongside each call. (b) `functionResponse.response` must be a protobuf
  Struct, so the persona tools' bare-string results are wrapped as
  `{output: ...}`. Verified live: single-hop `run_gig_economy`, string-returning
  `rate_sunset`, two sequential tool calls in one turn, and the Groq branch
  (real tool call, zero errored steps).
- **2026-10-17 — Deleted `lib/judge.ts`:** dead code — nothing imports it and
  the live judge has been `JUDGE_SYSTEM` + `judge()` in `agent/tools.ts` since
  the Week-2 rescope. `lib/ledger.ts` and `lib/manager-prompt.ts` are equally
  unreferenced and were left in place pending confirmation that nothing
  external depends on them.
- **2026-10-17 — Data-loss incident (recovery note):** an accidental
  `git reset --hard` discarded the uncommitted Oct-16 work plus untracked files
  (`lib/llm.ts`, `tmp/verify/*`). Almost everything was restored byte-exactly
  from the original TypeScript embedded in the `.next` source maps
  (`sourcesContent`); the working tree now matches the pre-reset state. NOT
  recovered: the `README.md` edits made after commit `263f64d`, the
  `demo-video-guide-w2.md` draft, and the `lib/judge.ts` edits (moot — file
  deleted). Commit early; `.next` was the only reason this came back.

- **2026-10-21 — Week 2 advanced: the NFT contract (UselessNFT.sol):** the
  advanced brief asks for a DEPLOYED smart contract the agent can call through
  its own tools, plus an in-chat interface where the user uploads an image,
  enters a name, a description and metadata, and then authorizes the mint.
  Written as `contracts/UselessNFT.sol` — a self-contained ERC-721 with a
  small on-chain marketplace, so ONE deployment covers minting, buying and
  selling. Two choices worth recording:
  (a) NO OpenZeppelin dependency. The contract imports nothing, so it
  compiles with a bare `solc` and deploys from a plain Node script.
  (b) Payment is a plain ERC-20 `transferFrom`, not EIP-3009. The contract
  pulls the USDC itself, so it has no opinion about how the buyer authorised
  the spend, and the marketplace half works with any wallet that can sign an
  `approve`.
  The contract enforces two rules itself rather than trusting the app: only
  the MINTER may mint, and the USDC transfer is the LAST thing `buy()` does —
  if the payment fails the whole transaction reverts, so a token can never
  change hands without the money moving.
- **2026-10-21 — The mint keeps the transfer's two-phase shape:** `mint_nft`
  files a PENDING intent and the chat renders an interactive card; nothing is
  signed until the user presses Mint. The reason is the same one as the
  transfers: the model reads "mint an NFT called X" well and guesses what the
  user wanted the NFT to LOOK like badly. The card (upload, name, description,
  traits, review, mint) is the interface the brief asks for.
- **2026-10-21 — The image is downscaled in the browser:** the metadata is
  stored on-chain as a URI and served by this app, so the image is embedded as
  a data URI and its SIZE becomes a cost. The card draws the upload onto a
  canvas at most 512px on its long edge and re-encodes it as JPEG, stepping
  the quality down until it fits ~180 KB. A 4 MB screenshot therefore never
  becomes a 4 MB request body.
- **2026-10-21 — The tokenURI points at the app's own API, not at IPFS:** the
  metadata document is written to disk when the mint is approved (before the
  contract call, so a failed mint can be retried without re-uploading), and the
  tokenURI is `${APP_URL}/api/nfts/<mintId>`. The document embeds the image,
  so it is self-contained: one fetch returns the metadata AND the picture.
  IPFS/Arweave pinning is the production answer and is in Future Scope; it
  was skipped because it needs a pinning API key this repo does not have, and
  a token whose URI 404s is worse than a token whose URI points at a server
  that is still running.
- **2026-10-21 — The contract is NOT deployed on Base Sepolia:** both project
  wallets hold 0 testnet ETH and every reachable faucet (portal.base.org,
  Chainlink, dRPC, QuickNode, Tenderly, thirdweb, the CDP faucet) is
  captcha- or account-gated, so there is no gas to pay for a deployment. The
  code path is complete and `npm run deploy:nft` is ready; it needs about
  0.001 Base Sepolia ETH in the agent wallet and nothing else. Rather than
  ship an unverified contract, the whole thing was executed against a LOCAL
  EVM (ganache) — `npm run test:nft` proves the contract's own rules, and
  `npm run test:nft-app` drives the app's own `agent/nft.ts` through
  file -> approve -> mint -> list -> buy, with the real contract and the real
  viem calls. The mock USDC is placed at the canonical Base Sepolia USDC
  address with `evm_setAccountCode`, so the app's hard-coded address resolves
  with no test-only branch in the app itself.
