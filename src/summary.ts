// The numbers the README and the card quote, computed from a run, so no number is ever typed by hand.
import { QUEUE, type Inputs, type Run, type Segment } from "./engine.ts";
import { CONTROLS, type EvalResult, type Injection } from "./eval.ts";
import { DRUGS } from "./drugs.ts";
import { PHONE_LABEL, formatPhone, type PhoneCheck } from "./phone.ts";

const brand = (stem: string) => DRUGS.find((d) => d.stem === stem)?.brand ?? stem;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** One audit's score, as scripts/audit_report.mts writes it to docs/audit_<name>.json. */
export interface AuditScore { ok: number; n: number; unclear: number; low: number; high: number; misses: Record<string, number> }
export interface Audits {
  heldout?: { bdrAtAudit: AuditScore; bdrAtAuditGroups?: AuditScore; bdrAtAuditSolos?: AuditScore; total: number; agreedFirstPass: number; tiebreaks?: number };
  dev?: { bdrAtAudit: AuditScore; bdrNow: AuditScore; leftBdr: AuditScore; bdr_top?: AuditScore; ae?: AuditScore; total: number };
}

export function summarize(inp: Inputs, run: Run, ev: EvalResult, audits: Audits = {}) {
  const { practices, prescribers, skipped, gate } = run;
  const bySeg = Object.fromEntries(
    (Object.keys(QUEUE) as Segment[]).map((s) => {
      const q = practices.filter((p) => p.segment === s);
      return [s, { queue: QUEUE[s], accounts: q.length, prescribers: q.reduce((a, p) => a + p.prescribers.length, 0), claims: q.reduce((a, p) => a + p.claims, 0) }];
    }),
  ) as Record<Segment, { queue: string; accounts: number; prescribers: number; claims: number }>;
  const totalClaims = practices.reduce((a, p) => a + p.claims, 0);

  const skipReasons: Record<string, number> = {};
  for (const s of skipped) {
    const k = s.reason.startsWith("practice location is in") ? "practice location outside New York" : s.reason.startsWith("not a practice") ? "not a practice a BDR can sell to" : s.reason.startsWith("Medicare's clinician file lists them only outside") ? "moved: Medicare lists them only outside New York" : s.reason.startsWith("audited:") ? "audited: not a practice, or moved" : s.reason.replace(/ZIP \d+/, "ZIP");
    skipReasons[k] = (skipReasons[k] ?? 0) + 1;
  }

  // phone: accounts where both directories list the same site, so the phones can be compared
  const comparable = practices.filter((p) => !["no_shared_site", "no_medicare_row", "one_missing"].includes(p.phoneCheck));
  const counts: Record<string, number> = {};
  for (const p of practices) counts[p.phoneCheck] = (counts[p.phoneCheck] ?? 0) + 1;
  const disagree = comparable.filter((p) => p.phoneCheck !== "agree" && p.phoneCheck !== "extension");
  const extension = comparable.filter((p) => p.phoneCheck === "extension");
  const typoLike = comparable.filter((p) => ["swap", "one_digit", "area_code", "malformed"].includes(p.phoneCheck));
  const bdr = practices.filter((p) => p.segment === "independent");
  const example = (p: (typeof practices)[number]) => {
    const r = p.prescribers.find((x) => x.npi === p.judgeNpi) ?? p.prescribers[0];
    return {
      practice: p.name, rank: p.rank, queue: QUEUE[p.segment], area: p.territory.area, check: p.phoneCheck as PhoneCheck, label: PHONE_LABEL[p.phoneCheck as PhoneCheck],
      medicare: formatPhone(p.medicareListed), registry: formatPhone(r.nppes.loc.phone), site: `${p.site.addr}, ${p.site.zip.slice(0, 5)}`, registryUpdated: r.nppes.updated,
    };
  };
  const typoExamples = typoLike.slice(0, 8).map(example);

  // the published files name the customer practice Forus wrote about, never the clinician who prescribes for it
  const customers = practices.filter((p) => p.customer).map((p) => ({ customer: p.customer!.name, source: p.customer!.source, area: p.territory.area }));

  const regions: Record<string, { accounts: number; claims: number }> = {};
  for (const p of bdr) {
    const r = (regions[p.territory.region] ??= { accounts: 0, claims: 0 });
    r.accounts++;
    r.claims += p.claims;
  }

  const drugs = gate.kept
    .map((d) => ({ brand: d.brand, stem: d.stem, area: d.area, named: d.source !== "class", paRate: Math.round(d.pa.rate * 1000) / 10, plans: d.pa.plansCovering, claims: practices.reduce((a, p) => a + (p.drugs.find(([s]) => s === d.stem)?.[1] ?? 0), 0) }))
    .sort((a, b) => b.claims - a.claims);

  const summary = {
    sources: {
      partd: "Medicare Part D Prescribers by Provider and Drug, 2024",
      formulary: `${inp.formulary.source.name} (${inp.formulary.nyPlans} New York plans on ${inp.formulary.nyFormularies} formularies)`,
      dacModified: inp.dacModified,
    },
    drugs: { kept: drugs, dropped: gate.dropped, leftOut: gate.leftOut, minPaRate: Math.min(...drugs.map((d) => d.paRate)), nyPlans: inp.formulary.nyPlans },
    funnel: {
      partdRows: inp.partd.length,
      prescribersInPartD: new Set(inp.partd.map((r) => r.npi)).size,
      prescribersWithKeptDrugs: run.withKeptDrugs,
      skipped: skipped.length,
      skipReasons,
      prescribers: run.inAccounts,
      accounts: practices.length,
      claims: totalClaims,
    },
    segments: bySeg,
    independents: {
      accounts: bdr.length,
      claimsShare: pct(bySeg.independent.claims, totalClaims),
      solo: bdr.filter((p) => p.prescribers.length === 1 && !p.orgPac).length,
      regions,
      tierA: bdr.filter((p) => p.tier === "A").length,
      dialReady: bdr.filter((p) => p.tier === "A" && p.phoneCheck === "agree").length,
    },
    customers,
    phone: {
      counts,
      comparable: comparable.length,
      disagree: disagree.length,
      disagreePct: pct(disagree.length, comparable.length),
      typoLike: typoLike.length,
      extension: extension.length,
      extensionExamples: extension.slice(0, 4).map(example),
      bdrDisagree: disagree.filter((p) => p.segment === "independent").length,
      typoExamples,
    },
    eval: ev,
  };

  // the map: every New York ZIP as a faint dot, then each account at its site ZIP, in rank order
  const SEGS = Object.keys(QUEUE) as Segment[];
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const zips = inp.zips ?? {};
  const mapAccounts = practices
    .map((p) => ({ p, at: zips[p.site.zip.slice(0, 5)] ?? zips[p.prescribers[0].nppes.loc.zip.slice(0, 5)] }))
    .filter((x) => x.at)
    .map(({ p, at }) => [r3(at[0]), r3(at[1]), p.claims, SEGS.indexOf(p.segment)]);

  const card = {
    asOf: inp.formulary.fetched,
    nyPlans: inp.formulary.nyPlans,
    drugCount: drugs.length,
    minPaRate: summary.drugs.minPaRate,
    drugs: drugs.slice(0, 8).map((d) => ({ brand: d.brand, paRate: d.paRate, claims: d.claims })),
    prescribers: run.inAccounts,
    accounts: practices.length,
    claims: totalClaims,
    segments: (Object.keys(QUEUE) as Segment[]).map((s) => ({ segment: s, ...bySeg[s] })),
    independents: summary.independents,
    firstLine: bdr[0] ? { practice: bdr[0].name, line: bdr[0].talkingPoint } : null,
    // the public card shows group practices only: no individual clinician is named on it
    top: bdr.filter((p) => p.orgPac && p.prescribers.length > 1).slice(0, 12).map((p) => ({
      name: p.name, area: p.territory.area, region: p.territory.region, claims: p.claims, prescribers: p.prescribers.length, tier: p.tier,
      drugs: p.drugs.slice(0, 2).map(([s]) => brand(s)), phone: p.phoneCheck,
    })),
    customers,
    phone: { comparable: comparable.length, disagree: disagree.length, disagreePct: summary.phone.disagreePct, typoLike: typoLike.length, extension: extension.length,
      bdrDisagree: summary.phone.bdrDisagree,
      counts: Object.fromEntries(["swap", "one_digit", "area_code", "same_exchange", "differ", "malformed"].map((k) => [k, counts[k] ?? 0])),
      // the hero example: a swapped pair at a group practice in the BDR queue (a group name, not a person's)
      hero: typoLike.filter((p) => p.phoneCheck === "swap" && p.segment === "independent" && /ASSOCIATES|GROUP|PC$|PLLC$/i.test(p.name) && !/^Dr\b|\bMD\b|\bDO\b|, M\.?D/i.test(p.name)).map(example)[0] ?? typoExamples[0] ?? null, examples: typoExamples.slice(0, 3), extensionExample: extension.slice(0, 1).map(example)[0] ?? null },
    eval: { recall: Math.round(ev.recall * 1000) / 10, falseFlags: ev.falseFlags, clean: ev.cleanPractices, injected: Object.entries(ev.perKind).filter(([k]) => !CONTROLS.has(k as Injection)).reduce((a, [, v]) => a + v.n, 0), exact: Object.entries(ev.perKind).filter(([k]) => !CONTROLS.has(k as Injection)).reduce((a, [, v]) => a + v.exact, 0), caught: Object.entries(ev.perKind).filter(([k]) => !CONTROLS.has(k as Injection)).reduce((a, [, v]) => a + v.caught, 0), controls: [...CONTROLS].reduce((a, k) => a + (ev.perKind[k]?.n ?? 0), 0) },
    map: { segments: SEGS, zips: Object.values(zips).map(([la, lo]) => [r3(la), r3(lo)]), accounts: mapAccounts, unmapped: practices.length - mapAccounts.length },
    // measured, not claimed: the held out audit's score, and the tuning sample's before and after
    accuracy: audits.heldout ? { heldout: audits.heldout.bdrAtAudit, groups: audits.heldout.bdrAtAuditGroups ?? null, solos: audits.heldout.bdrAtAuditSolos ?? null, heldoutTotal: audits.heldout.total, tiebreaks: audits.heldout.tiebreaks ?? 0, corrected: run.audited, dev: audits.dev ? { before: audits.dev.bdrAtAudit, after: audits.dev.bdrNow, removed: audits.dev.leftBdr, top: audits.dev.bdr_top ?? null, ae: audits.dev.ae ?? null } : null } : null,
  };
  return { ...summary, card };
}
