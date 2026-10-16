// priormap command line: fetch (refresh the snapshots), run (build and export), eval (measure the phone check).
import fs from "node:fs";
import path from "node:path";
import { fetchAll } from "./fetch.ts";
import { build, loadInputs, QUEUE, type Segment } from "./engine.ts";
import { writeAll } from "./export.ts";
import { CONTROLS, runEval, type Injection } from "./eval.ts";
import { summarize } from "./summary.ts";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "fetch") {
  await fetchAll("NY", args[0]);
} else if (cmd === "run") {
  const inp = loadInputs();
  const run = build(inp);
  writeAll(run);
  const ev = runEval(inp);
  const audit = (name: string) => (fs.existsSync(`docs/audit_${name}.json`) ? JSON.parse(fs.readFileSync(`docs/audit_${name}.json`, "utf8")) : undefined);
  const s = summarize(inp, run, ev, { heldout: audit("heldout"), dev: audit("dev") });
  fs.writeFileSync(path.resolve("leads/summary.json"), JSON.stringify(s, null, 1) + "\n");
  fs.writeFileSync(path.resolve("app/card.json"), JSON.stringify(s.card, null, 1) + "\n");
  console.log(`drugs: ${run.gate.kept.length} kept, ${run.gate.dropped.length} not on any New York plan`);
  console.log(`prescribers: ${run.withKeptDrugs} with a kept drug: ${run.inAccounts} in accounts, ${run.skipped.length} skipped`);
  console.log(`accounts: ${run.practices.length}`);
  for (const seg of Object.keys(QUEUE) as Segment[]) {
    const q = run.practices.filter((p) => p.segment === seg);
    console.log(`  ${QUEUE[seg].padEnd(28)} ${String(q.length).padStart(5)} ${q.length === 1 ? "account " : "accounts"}  ${String(q.reduce((a, p) => a + p.claims, 0)).padStart(7)} claims`);
  }
  console.log(`phone: ${JSON.stringify(s.phone.counts)}`);
  console.log(`eval: recall ${(ev.recall * 100).toFixed(1)}% on ${ev.cleanPractices} clean accounts x ${Object.keys(ev.perKind).filter((k) => !CONTROLS.has(k as Injection)).length} corruptions, false flags ${ev.falseFlags} of ${[...CONTROLS].reduce((a, k) => a + ev.perKind[k].n, 0)} controls`);
} else if (cmd === "eval") {
  console.log(JSON.stringify(runEval(loadInputs()), null, 1));
} else {
  console.error("usage: tsx src/cli.ts fetch [formulary|partd|nppes|dac] | run | eval");
  process.exit(1);
}
