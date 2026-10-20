import type { ReactNode } from "react";

/**
 * Renders the small subset of markdown the agent actually uses: `**bold**`
 * and `` `code` ``.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent writes its replies as markdown (it is prompted to bold the
 * amount, the address, and the words the user should reply with). The chat
 * bubble rendered that text verbatim, so users saw literal `**1 USDC**` and
 * `**yes**` instead of formatting.
 *
 * A full markdown renderer is overkill for two inline marks and would add a
 * dependency plus an XSS surface. This splits on the delimiters and renders
 * React elements directly — no dangerouslySetInnerHTML anywhere.
 */
export function InlineMarkdown({ text }: { text: string }): ReactNode {
  // Split on **bold** and `code`, keeping the delimiters so we can tell
  // which style each captured group uses.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              key={i}
              className="rounded bg-background/40 px-1 py-0.5 font-mono text-[0.9em]"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
