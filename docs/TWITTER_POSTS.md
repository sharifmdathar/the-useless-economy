# Twitter/X posts — The Useless Economy (RiseIn Week 2)

Program: **RiseIn — Build an AI Agent** (`@riseinweb3`)
Product page: create a dedicated account and put its URL in the README's Social Media section.
Every post must tag `@riseinweb3`. Cadence: **3 posts per week**.

Product name (for the README demo-link format): `the-useless-economy`

---

## Week 1 — post 1 (the original gig market)

> Week 1 of The Useless Economy: a gig market where the workers are AI agents
> and the customers are AI agents.
>
> One prompt → 3 providers → an independent judge → a ranked winner.
>
> Soleil rates sunsets. Feathers counts pigeons. Cap'n pirate-translates.
>
> The deliverables are useless. The market mechanics are not.
>
> Built with @riseinweb3

Attach: the Week 1 demo video link (or the standings table screenshot).

---

## Week 1 — post 2 (what "judge" means here)

> The judge is a separate agent, not a function.
>
> It scores each deliverable 1–5 with written feedback — "Flawlessly radiant, a
> poetic sunlit masterpiece" — and the score decides the payout.
>
> Verdict first, money second.
>
> Built with @riseinweb3

Attach: a screenshot of the standings table with the feedback column.

---

## Week 1 — post 3 (open the tool call)

> Every step is inspectable.
>
> One click on the tool call in the chat and you see the raw JSON that went in
> and the raw JSON that came back — the job, the winner, the standings, every
> deliverable in full.
>
> No magic. Just an agent calling tools.
>
> Built with @riseinweb3

Attach: the expanded `run_gig_economy` tool call.

---

## Week 2 — post 1 (feature announcement)

> Shipping v2 of The Useless Economy 🛠️
>
> The agent now moves money from a natural-language prompt:
>
> → "send 1 USDC to 0x..."
> → parses token, amount, recipient
> → shows a review card
> → you approve
> → settles on-chain in USDC on Base Sepolia
>
> Approval before signing. Always.
>
> Built with @riseinweb3

Attach: the Week 2 demo video link (or a 30s clip of the approval card).

---

## Week 2 — post 2 (the x402 mechanic)

> x402 = HTTP 402 Payment Required, rebuilt for AI agents.
>
> The Useless Economy runs 3 provider agents that charge per call. The foreman:
> 1. gets a 402 with price + payTo + asset
> 2. signs an EIP-3009 authorization with its own wallet
> 3. retries with an X-PAYMENT header
> 4. provider verifies + settles on-chain
>
> No API keys. No billing portal. A wallet and a signature.
>
> Built with @riseinweb3

Attach: a screen recording of the 402 → sign → settle flow.

---

## Week 2 — post 3 (the market)

> An AI marketplace where the workers are agents and the customers are agents.
>
> Soleil rates sunsets. Feathers counts pigeons. Cap'n pirate-translates.
>
> The Foreman hires all 3 over x402, scores their work 1–5, tips the winner in USDC, blacklists the failures.
>
> The deliverables are useless. The market mechanics are not.
>
> Built with @riseinweb3

Attach: the leaderboard / report.md screenshot.

---

## Week 3 — post 1 (the wallet)

> Week 3 of The Useless Economy: the agent got a wallet.
>
> Not a custodial account, not an API key — its own key, its own address, its
> own balance. It spends USDC on Base Sepolia testnet to buy its own work.
>
> 💸 402 Payment Required → sign → settle, in one agent loop.
>
> Built with @riseinweb3

Attach: the Week 3 demo video link (or the 402 challenge screenshot).

---

## Week 3 — post 2 (the x402 challenge)

> Ask a provider for a quote without paying, and it answers:
>
> 402 Payment Required
> price: 0.05 USDC
> asset: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
> payTo: 0xc71DAa8fD15B713Fe27406e25bB9AdfA1fea5025
> facilitator: https://x402.org/facilitator
>
> The agent signs that with its own key and pays. No billing portal.
>
> Built with @riseinweb3

Attach: the raw 402 response.

---

## Week 3 — post 3 (tips on-chain)

> The agent doesn't just pay for work — it rewards it.
>
> Tip Soleil 0.005 USDC → signed locally → settled on-chain → transaction
> hash attached. The ledger records the tip separately from the price of the
> work, so a tip can never be mistaken for a commission.
>
> Every cent has a receipt.
>
> Built with @riseinweb3

Attach: the expanded `tip_provider` tool call showing the tx hash.

---

## Pinned post (on the product page)

> The Useless Economy — an AI agent that hires other AI agents, judges them, and pays them in crypto.
>
> 🤖 3 provider personas
> ⚖️ independent 1–5 judge
> 💸 x402 payments (EIP-3009 USDC) on Base Sepolia
> 🧾 append-only ledger
> 🛡️ hard spend caps + kill switch
>
> Built with @riseinweb3

Pin the Week 2 demo video to the top of the product page.

---

## Checklist before posting

- [ ] Dedicated product account created (not a personal account)
- [ ] Product account URL pasted into README → Social Media
- [ ] `@riseinweb3` tagged in **every** post
- [ ] 3 posts scheduled/published per week
- [ ] Demo video link in the README in this exact format:
      ```
      Week 1 (the-useless-economy.v1): <url>
      Week 2 (the-useless-economy.v2): <url>
      Week 3 (the-useless-economy.v3): <url>
      ```
- [ ] Pinned post set
