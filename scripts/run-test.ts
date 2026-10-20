/**
 * Test runner for the scripts/ suite.
 *
 * The project uses Next.js path aliases (`@/agent/wallet`), which plain
 * `node --experimental-strip-types` cannot resolve. `jiti` is already a
 * transitive dependency (via shadcn) and resolves aliases, so this runner
 * points it at the repo root.
 *
 *   node scripts/run-test.ts <script.ts> [args...]
 */
import { createJiti } from "jiti";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/run-test.ts <script.ts>");
  process.exit(2);
}

const root = process.cwd();
const jiti = createJiti(pathToFileURL(path.join(root, "scripts/")).href, {
  alias: {
    "@": root,
  },
  interopDefault: true,
  fsCache: false,
  moduleCache: false,
});

try {
  await jiti.import(pathToFileURL(path.resolve(root, target)).href);
} catch (err) {
  console.error("\nRUNNER FAILURE:", err instanceof Error ? err.stack : err);
  process.exit(1);
}
