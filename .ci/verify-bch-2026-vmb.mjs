import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createVirtualMachineBch2026,
  decodeTransaction,
  decodeTransactionOutputs,
  hexToBin,
} from "@bitauth/libauth";

const generatedRoot = resolve(
  process.argv[2] ?? ".ci/libauth/src/lib/vmb-tests/generated",
);

const fixtureSets = {
  standard: [
    "chip.bitwise",
    "chip.functions",
    "chip.loops",
    "chip.p2s",
    "chip.flow-control",
  ],
  nonstandard: ["chip.bitwise"],
  invalid: [
    "chip.bitwise",
    "chip.functions",
    "chip.loops",
    "chip.flow-control",
  ],
};

const fullCorpus = process.argv.includes("--full");
const standardVm = createVirtualMachineBch2026(true);
const nonstandardVm = createVirtualMachineBch2026(false);
const failures = [];
let totalVectors = 0;
let totalFiles = 0;

async function readVectors(mode, name) {
  const path = join(
    generatedRoot,
    `bch_2026_${mode}`,
    `${name}.vmb_tests.json`,
  );
  const content = await readFile(path, "utf8");
  const vectors = JSON.parse(content);
  if (!Array.isArray(vectors)) {
    throw new Error(`Invalid VMB fixture file: ${path}`);
  }
  return { path, vectors };
}

async function selectedFixtureSets() {
  if (!fullCorpus) return fixtureSets;
  const modes = ["standard", "nonstandard", "invalid"];
  const discovered = {};
  for (const mode of modes) {
    const directory = join(generatedRoot, `bch_2026_${mode}`);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".vmb_tests.json"))
      .sort();
    if (files.length === 0) {
      throw new Error(`Full BCH 2026 corpus is missing fixture files for mode ${mode}.`);
    }
    discovered[mode] = files.map((file) =>
      file.slice(0, -".vmb_tests.json".length),
    );
  }
  return discovered;
}

function accepts(vm, transactionHex, sourceOutputsHex) {
  try {
    const transaction = decodeTransaction(hexToBin(transactionHex));
    if (typeof transaction === "string") return false;
    const sourceOutputs = decodeTransactionOutputs(hexToBin(sourceOutputsHex));
    if (typeof sourceOutputs === "string") return false;
    return vm.verify({ transaction, sourceOutputs }) === true;
  } catch {
    return false;
  }
}

const activeFixtureSets = await selectedFixtureSets();

for (const [mode, names] of Object.entries(activeFixtureSets)) {
  for (const name of names) {
    const { path, vectors } = await readVectors(mode, name);
    totalFiles += 1;
    totalVectors += vectors.length;

    for (const vector of vectors) {
      const [id, description, , , transactionHex, sourceOutputsHex] = vector;
      if (
        typeof id !== "string" ||
        typeof description !== "string" ||
        typeof transactionHex !== "string" ||
        typeof sourceOutputsHex !== "string"
      ) {
        failures.push(`${path}: malformed vector record`);
        continue;
      }

      const standardExpected = mode === "standard";
      const nonstandardExpected = mode !== "invalid";
      const standardActual = accepts(standardVm, transactionHex, sourceOutputsHex);
      const nonstandardActual = accepts(nonstandardVm, transactionHex, sourceOutputsHex);

      if (standardActual !== standardExpected) {
        failures.push(
          `${mode}/${name} ${id}: standard VM expected ${standardExpected ? "accept" : "reject"}; ${standardActual ? "accepted" : "rejected"} — ${description}`,
        );
      }
      if (nonstandardActual !== nonstandardExpected) {
        failures.push(
          `${mode}/${name} ${id}: nonstandard VM expected ${nonstandardExpected ? "accept" : "reject"}; ${nonstandardActual ? "accepted" : "rejected"} — ${description}`,
        );
      }
    }
  }
}

console.log(
  `BCH 2026 ${fullCorpus ? "discovered" : "targeted"} VMB suite: ${totalVectors} vectors across ${totalFiles} fixture files.`,
);
console.log(
  "Coverage: bitwise operations, functions, bounded loops, Pay-to-Script, and flow control.",
);
console.log(
  "Both standard and nonstandard BCH 2026 VM policies were checked against upstream expected outcomes.",
);

if (failures.length > 0) {
  console.error(`BCH 2026 VMB mismatches: ${failures.length}`);
  for (const failure of failures.slice(0, 50)) console.error(" - " + failure);
  if (failures.length > 50) {
    console.error(` - ... and ${failures.length - 50} more`);
  }
  process.exitCode = 1;
} else {
  console.log("All selected upstream BCH 2026 VMB vectors passed.");
}
