// Scores an audit: reads the final labels the audit workflow produced (one researcher, one skeptic, a tiebreak where
// they disagreed), joins them to the routing the rules give today (no audit corrections: the audit measures the
// rules), prints precision with a 95% Wilson interval, and writes the labels with their sources to docs/.
//   npx tsx scripts/audit_report.mts <final_labels.json> <full_sample.json> <dev|heldout>
// What is published: for each group practice, its label, how the label was decided, its queues and the public pages
// the researchers cited. The researchers' written notes are not published: they discuss individual clinicians, and
// rewriting them safely by machine proved unreliable. Prescribers who bill alone are published only as counts by label.
import fs from "node:fs";
import { build, loadInputs, QUEUE } from "../src/engine.ts";
import { csv } from "../src/export.ts";

export interface Final {
  i: number; final: string; method: string;
  first?: { label: string; confidence: string; owner: string; evidence: { url: string; fact: string }[]; note: string };
  verify?: { agree: boolean; label: string; evidence: { url: string; fact: string }[] } | null;
  tiebreak?: { label: string; confidence: string; owner: string; evidence: { url: string; fact: string }[]; note: string } | null;
}

export const SELLABLE = new Set(["independent_specialty", "independent_primary_or_multispecialty"]);

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96) {
  if (!n) return { low: 0, high: 0 };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

/** Sources never published: property, tax and corporate registry lookups, and obituaries. */
export const PRIVATE_URL =
  /propertyinformationportal|a836|nyc\.gov\/site\/finance|data\.cityofnewyork\.us|propertyshark|zola|acris|streeteasy|zillow|realtor|bizapedia|opencorporates|corporationwiki|obituar|legacy\.com|tributearchive|dignitymemorial/i;
/** Federal names and addresses carry hyphens; the published files write them with a space. */
export const dashless = (s: string) => s.replace(/\s*[‐-―−-]+\s*/g, " ").replace(/\s+/g, " ").trim();

const [labelsFile, sampleFile, name] = process.argv.slice(2);
if (labelsFile) {
  const finals: Final[] = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
  const sample: { key: string; group: string; name: string; site: string; queue: string; area: string; claims: number }[] =
    JSON.parse(fs.readFileSync(sampleFile, "utf8"));
  const rules = new Map(build({ ...loadInputs(), audit: undefined }).practices.map((p) => [p.key, p]));
  const corrected = new Map(build(loadInputs()).practices.map((p) => [p.key, p]));
  const queueOf = (m: typeof rules, key: string) => { const p = m.get(key); return p ? QUEUE[p.segment] : "not an account"; };
  const rows = finals.map((f) => {
    const s = sample[f.i];
    const best = f.method === "agreed" ? f.first : f.tiebreak ?? f.first;
    const urls = [...new Set((best?.evidence ?? []).map((e) => e.url.trim()).filter((u) => /^https?:\/\//.test(u) && !PRIVATE_URL.test(u)))];
    return { s, f, best, urls, solo: s.key.startsWith("npi:"), queueNow: queueOf(rules, s.key), queueCorrected: queueOf(corrected, s.key) };
  });
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const count = (rs: typeof rows) => rs.reduce((a, r) => ((a[r.f.final] = (a[r.f.final] ?? 0) + 1), a), {} as Record<string, number>);
  const report = (label: string, rs: typeof rows) => {
    const known = rs.filter((r) => r.f.final !== "unclear");
    const ok = known.filter((r) => SELLABLE.has(r.f.final)).length;
    const w = wilson(ok, known.length);
    const misses: Record<string, number> = {}, sellable: Record<string, number> = {};
    for (const r of known) (SELLABLE.has(r.f.final) ? sellable : misses)[r.f.final] = ((SELLABLE.has(r.f.final) ? sellable : misses)[r.f.final] ?? 0) + 1;
    const claims = known.reduce((a, r) => a + (r.s.claims ?? 0), 0), okClaims = known.filter((r) => SELLABLE.has(r.f.final)).reduce((a, r) => a + (r.s.claims ?? 0), 0);
    console.log(`${label}: ${ok} of ${known.length} sellable (${pct(ok / (known.length || 1))}, 95% CI ${pct(w.low)} to ${pct(w.high)}); by claims ${pct(okClaims / (claims || 1))}; unclear ${rs.length - known.length}; misses ${JSON.stringify(misses)}`);
    return { ok, n: known.length, unclear: rs.length - known.length, low: w.low, high: w.high, misses, sellable, claims: { ok: okClaims, n: claims } };
  };
  const out: Record<string, unknown> = {};
  const bdrAtAudit = rows.filter((r) => r.s.group.startsWith("bdr"));
  out.bdrAtAudit = report("BDR accounts as routed when sampled", bdrAtAudit);
  out.bdrAtAuditGroups = report("of those, group practices (published with sources)", bdrAtAudit.filter((r) => !r.solo));
  out.bdrAtAuditSolos = report("of those, prescribers billing alone (counts only)", bdrAtAudit.filter((r) => r.solo));
  out.bdrNow = report("of those, routed to BDR by today's rules", bdrAtAudit.filter((r) => r.queueNow === "BDR"));
  out.leftBdr = report("of those, routed out of BDR by today's rules", bdrAtAudit.filter((r) => r.queueNow !== "BDR"));
  for (const g of [...new Set(rows.map((r) => r.s.group))]) out[g] = report(`group ${g}`, rows.filter((r) => r.s.group === g));
  out.soloLabels = Object.fromEntries([...new Set(rows.map((r) => r.s.group))].map((g) => [g, count(rows.filter((r) => r.solo && r.s.group === g))]));
  out.groupsWithSources = { withSources: rows.filter((r) => !r.solo && r.urls.length).length, groups: rows.filter((r) => !r.solo).length };
  out.agreedFirstPass = rows.filter((r) => r.f.method === "agreed").length;
  out.tiebreaks = rows.filter((r) => r.f.method === "tiebreak").length;
  out.total = rows.length;
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync(`docs/audit_${name}.json`, JSON.stringify(out, null, 1) + "\n");
  fs.writeFileSync(`docs/audit_${name}.csv`, csv(
    ["sample", "practice", "site", "queue_when_sampled", "queue_by_rules_today", "queue_after_audit_corrections", "label", "how_decided", "confidence", "source_1", "source_2", "source_3"],
    rows.filter((r) => !r.solo).map(({ s, f, best, urls, queueNow, queueCorrected }) =>
      [s.group, dashless(s.name), dashless(s.site), s.queue, queueNow, queueCorrected, f.final, f.method, best?.confidence ?? "", urls[0] ?? "", urls[1] ?? "", urls[2] ?? ""]),
  ));
  console.log(`wrote docs/audit_${name}.csv and docs/audit_${name}.json`);
}
