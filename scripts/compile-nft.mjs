/**
 * Compile contracts/UselessNFT.sol with solc and write the artifacts the app
 * needs: contracts/UselessNFT.abi.json and contracts/UselessNFT.bytecode.json.
 *
 * The artifacts are COMMITTED, so the app and the deploy script work without
 * a Solidity toolchain installed. Re-run this only when the .sol changes:
 *
 *   npm run compile:nft
 *
 * solc is a devDependency; if it is not installed the script says so instead
 * of failing obscurely.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let solc;
try {
  solc = (await import("solc")).default;
} catch {
  console.error(
    "solc is not installed. Run `npm install` (it is a devDependency) and try again.",
  );
  process.exit(1);
}

const source = fs.readFileSync(
  path.join(root, "contracts", "UselessNFT.sol"),
  "utf8",
);

const input = {
  language: "Solidity",
  sources: { "UselessNFT.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter(
  (e) => e.severity === "error" || e.severity === "warning",
);
for (const e of errors ?? []) {
  console.log(e.severity.toUpperCase() + ": " + e.formattedMessage);
}
if (errors?.some((e) => e.severity === "error")) {
  process.exit(1);
}

const contract =
  output.contracts?.["UselessNFT.sol"]?.["UselessNFT"];
if (!contract) {
  console.error("Compilation produced no UselessNFT contract.");
  process.exit(1);
}

fs.writeFileSync(
  path.join(root, "contracts", "UselessNFT.abi.json"),
  JSON.stringify(contract.abi, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(root, "contracts", "UselessNFT.bytecode.json"),
  JSON.stringify(
    {
      compiler: `solc ${solc.version()}`,
      optimizer: { enabled: true, runs: 200 },
      bytecode: "0x" + contract.evm.bytecode.object,
      deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `Compiled UselessNFT with ${solc.version()} — init code ${
    (contract.evm.bytecode.object.length / 2)
  } bytes, runtime ${(contract.evm.deployedBytecode.object.length / 2)} bytes.`,
);
console.log("Wrote contracts/UselessNFT.abi.json and contracts/UselessNFT.bytecode.json");
