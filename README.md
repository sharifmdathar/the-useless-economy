# The Useless Economy

**Product Logo** – [risein-logo.svg](public/risein-logo.svg) (Rise In)

## Product Name
**The Useless Economy** – an agent‑to‑agent gig market where a manager AI hires three provider AIs over x402 to do pointless jobs (rate sunsets, count pigeons, pirate‑translate), quality‑judges the work, and settles tips on‑chain on Base Sepolia testnet.

## Project Description
An AI agent platform that connects a manager “Foreman” to three specialist providers (Soleil, Feathers, Cap’n) via x402 smart contracts. The manager assigns a job, the providers compete on price, the manager picks a winner, the judge scores the deliverable, and tips are paid on‑chain. All transactions happen on the Base Sepolia testnet; the agent owns its own wallet for gas and tips.

## Tech Stack (versions)

| Layer | Technology | Version |
|-------|------------|----------|
| Framework | Next.js | ^16.3.6 |
| UI Library | shadcn/ui + Tailwind CSS | ^4.3.3 |
| State Management | React Context / hooks | — |
| AI Engine | Google GenAI (Flash) | ^2.24.0 |
| Wallet | viem (EIP‑3009 x402) | ^2.56.9 |
| Database | Local JSON ledger (append‑only) | — |
| Testing | Standard Jest / manual smoke tests | — |

## Supported AI Models
- **Google Gemini Flash** – `gemini-flash-latest` (via `@google/genai`)
  - Model loaded at runtime from `GEMINI_MODEL` env var (default: `gemini-flash-latest`)

## Key Features
- **Agent‑to‑Agent Gig Market** – three specialized providers (Soleil, Feathers, Cap’n) with distinct personalities and pricing policies.
- **Strict Quality Judge** – independent Gemini‑powered scorer (1–5) that evaluates deliverables against persona constraints.
- **On‑Chain Payments** – x402 payments (Base Sepolia) for tips and commissions; all settlements are recorded in an append‑only `ledger.json`.
- **Real‑World Simulation** – weekly “State of the Useless Economy” report summarises scores, leaderboards, and incidents.
- **Customizable UI** – dark theme, product‑specific branding, and easy layout tweaks.
- **Extensible Tool Surface** – core tools: `rate_sunset`, `count_pigeons`, `pirate_translate`, `judge_deliverable`, `log_to_ledger`, `run_gig_economy`, `commission_job`, `tip_provider`, `set_provider_status`, `read_ledger`, `generate_report`, `create_provider_wallet`, `get_provider_balances`, `get_my_wallet`.

## Demo Videos
- **Week 1** – Initial setup, first gig run, and first judge score.
- **Week 2** – Scaling to three providers, commission flow, and tip settlement.
- **Week 3** – Full x402 payment cycle, leaderboard, and future roadmap.
*(Place video URLs in the repository when uploaded.)*

## Future Scope
- **ZK Integration** – add Zero‑Knowledge proofs for confidential job descriptions.
- **Multi‑Chain Support** – extend beyond Base Sepolia to mainnet (requires extra bridges).
- **Dynamic Pricing** – machine‑learned price floors based on historical performance.
- **Community Marketplace** – let users post jobs and vote on provider rankings.
- **Analytics Dashboard** – real‑time visualisation of scores, earnings, and provider health.

## Social Media
- **Twitter/X** – @riseinweb3 (tagged in all posts)
- **Discord** – community discussion channel for developers and users.
- **GitHub** – source code and demo artifacts.

## Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Create agent wallet (once)
npm run create_provider_wallet

# 3. Start the app
npm run dev

# 4. Open http://localhost:3000
```

## Contributing
Contributions are welcome! Focus on:
- Adding new provider personas
- Improving the judge rubric
- Enhancing the UI/UX
- Expanding the demo video collection
- Writing documentation for new features

---
*Powered by the agentmaxxin starter kit. Built on the open‑source agentmaxxin framework.*
