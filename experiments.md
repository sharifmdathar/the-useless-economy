# Experiments — The Useless Economy

Methodology for the weekly "State of the Useless Economy" report. Fill each table
in as runs complete; every number should be reproducible from ledger.json.

## 1. Same job across providers (quality spread)

Run `run_gig_economy` on one identical job per row and record scores.

| date | job | soleil score | feathers score | capn score | winner | notes |
| ---- | --- | ------------ | -------------- | ---------- | ------ | ----- |
|      |     |              |                |            |        |       |

## 2. Counter-offer acceptance rate (target: 50%)

`commission_job` with a `counterOffer` between floor and ask. Record accept/reject
per attempt. Soleil floors at 0.03 (ask 0.05) → counteroffers in [0.03, 0.05)
should always be accepted in code; spread targets across ALL providers, Cap'n
never accepts (floor == ask) by persona.

| date | provider | counterOffer | outcome | notes |
| ---- | -------- | ------------ | ------- | ----- |
|      |          |              |         |       |

Target: **50% overall acceptance** achieved by mixing providers/job sizes; log
any deviation as an incident in report.md.

## 3. Tip vs no-Tip effect on next-job quality

A/B: for each provider, alternate tipped and untipped commissions and compare
the judge score of the NEXT job from that provider.

| date | provider | tipped previous job? | tip size | next-job score | delta vs provider avg |
| ---- | -------- | -------------------- | -------- | -------------- | --------------------- |
|      |          |                      |          |                |                       |

(Score is produced by the independent judge, not the manager, so the A/B is not
self-graded. If tip effect shows up, note it in DECISIONS.md too.)
