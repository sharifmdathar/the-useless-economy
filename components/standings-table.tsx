"use client";

import { providerName, type StandingsTable } from "@/agent/standings";

/**
 * The standings table, rendered from the RECORDED tool result.
 *
 * The agent's chat bubble used to carry the scores as prose, and the model
 * occasionally restated them wrong (a 3 called a five, an invented
 * tie-break). The numbers now come from `run_gig_economy`'s own output, so
 * what the user reads is what the judge actually recorded.
 */
export function StandingsTableView({ table }: { table: StandingsTable }) {
  return (
    <div className="border border-border bg-background/40">
      {table.job && (
        <div className="border-b border-border px-3 py-2 text-sm">
          <span className="text-muted-foreground">Job: </span>
          <span className="font-medium">{table.job}</span>
        </div>
      )}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-2 font-normal">Provider</th>
            <th className="px-3 py-2 font-normal">Score</th>
            <th className="px-3 py-2 font-normal">Judge&apos;s note</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => {
            const isWinner = table.winner?.provider === row.provider;
            return (
              <tr
                key={row.provider}
                className={isWinner ? "bg-primary/10" : undefined}
              >
                <td className="px-3 py-2 font-medium">
                  {providerName(row.provider)}
                  {isWinner && (
                    <span className="ml-2 text-primary">★ winner</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">
                  {row.score}/5
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.feedback}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {table.excluded && table.excluded.length > 0 && (
        <div className="border-t border-border px-3 py-2 text-sm text-muted-foreground">
          Sat out: {table.excluded.map(providerName).join(", ")}
        </div>
      )}
    </div>
  );
}
