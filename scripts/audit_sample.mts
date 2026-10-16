// Draws an audit sample with a fixed seed:
//   npx tsx scripts/audit_sample.mts dev    tuning sample (top 30 BDR, 40 random BDR, 15 address rule moves, 10 AE)
//   npx tsx scripts/audit_sample.mts test   held out sample (60 random BDR, none of them in the tuning sample)
// The draw follows today's rules and data, so it reproduces the committed samples only against the routing they were
// drawn from (October 14, 2026); the committed samples in audit/ are the record of what was audited. The full sample
// (names and prescribers, for the researchers) goes to audit/<name>_sample.full.json, which is git ignored; the
// committed audit/<name>_sample.json lists group practices in full and a prescriber billing alone only by queue and area.
import fs from "node:fs";
import { build, loadInputs, QUEUE, type Practice } from "../src/engine.ts";
import { rng } from "../src/eval.ts";

const which = process.argv[2] ?? "dev";
const name = which === "test" ? "heldout" : "dev";
const run = build({ ...loadInputs(), audit: undefined });
const draw = <T>(xs: T[], n: number, seed: number) => {
  const r = rng(seed), a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};
const view = (p: Practice, group: string) => ({
  group, key: p.key, name: p.name, queue: QUEUE[p.segment], reason: p.segmentWhy, rank: p.rank, tier: p.tier,
  site: `${p.site.addr}, ${p.site.city}, NY ${p.site.zip.slice(0, 5)}`, area: `${p.territory.region}: ${p.territory.area}`,
  medicareGroupSize: p.orgMembers, phone: p.phone,
  prescribers: p.prescribers.slice(0, 6).map((r) => `${r.first} ${r.last}, ${r.credential || "?"}, ${r.specialty}, NPI ${r.npi}`),
  morePrescribers: Math.max(0, p.prescribers.length - 6), claims: p.claims, topDrugs: p.drugs.slice(0, 3).map(([s]) => s),
});
const bdr = run.practices.filter((p) => p.segment === "independent");
let out;
if (which === "dev") {
  const moved = run.practices.filter((p) => /address where|HRSA|address says/.test(p.segmentWhy));
  const ae = run.practices.filter((p) => p.segment === "large_group");
  const top = bdr.slice(0, 30);
  const rest = bdr.filter((p) => !top.includes(p));
  out = [
    ...top.map((p) => view(p, "bdr_top")),
    ...draw(rest, 40, 101).map((p) => view(p, "bdr_random")),
    ...draw(moved, 15, 202).map((p) => view(p, "enterprise_by_address")),
    ...draw(ae, 10, 303).map((p) => view(p, "ae")),
  ];
} else {
  const full = "audit/dev_sample.full.json";
  if (!fs.existsSync(full)) throw new Error("the held out draw excludes the tuning sample, which needs audit/dev_sample.full.json");
  const dev = new Set((JSON.parse(fs.readFileSync(full, "utf8")) as { key: string }[]).map((x) => x.key));
  out = draw(bdr.filter((p) => !dev.has(p.key)), 60, 909).map((p) => view(p, "bdr_heldout"));
}
fs.mkdirSync("audit", { recursive: true });
fs.writeFileSync(`audit/${name}_sample.full.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`audit/${name}_sample.json`, JSON.stringify(publicSample(out), null, 1) + "\n");
console.log(`${which}: ${out.length} accounts -> audit/${name}_sample.full.json (researchers) and audit/${name}_sample.json (public)`);

export function publicSample(rows: ReturnType<typeof view>[]) {
  return rows.map((a) => (a.key.startsWith("npi:") ? { group: a.group, solo: true, area: a.area, queue: a.queue } : a));
}
