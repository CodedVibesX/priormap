// How often each drug needs prior authorization on the Medicare Part D plans sold in New York, from CMS's 2026
// Prescription Drug Plan Formulary files. A plan "requires PA" for a drug when every product of that drug on its
// formulary carries PRIOR_AUTHORIZATION_YN = Y, so there is no version a practice can prescribe without one.
import { DRUGS, type Drug } from "./drugs.ts";

export interface DrugPA {
  stem: string;
  brand: string;
  /** New York plans whose formulary lists the drug at all. */
  plansCovering: number;
  /** Of those, plans where every listed product of the drug needs prior authorization. */
  plansAllPA: number;
  /** Plans where at least one listed product needs it. */
  plansAnyPA: number;
  rate: number;
  rxcuis: string[];
}

export interface FormularySummary {
  release: string;
  nyPlans: number;
  nyFormularies: number;
  drugs: DrugPA[];
}

/** A column's index, or a loud failure when a monthly release renames it (a silent -1 would read the wrong field). */
export function col(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`formulary file is missing column ${name}`);
  return i;
}

/** Plans sold in New York: Medicare Advantage plans with a New York county row, plus PDPs in PDP region 03. */
export function nyPlans(planInfo: string, nyPdpRegion = "03"): Map<string, string> {
  const lines = planInfo.split(/\r?\n/);
  const h = lines[0].split("|");
  const at = (k: string) => col(h, k);
  const [iC, iP, iS, iF, iSt, iPdp, iSup] = ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "FORMULARY_ID", "STATE", "PDP_REGION_CODE", "PLAN_SUPPRESSED_YN"].map(at);
  const plans = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = line.split("|");
    if (c[iSup] === "Y") continue;
    const inNY = c[iSt] === "NY" || (c[iC].startsWith("S") && c[iPdp].trim() === nyPdpRegion);
    if (inNY) plans.set(`${c[iC]}-${c[iP]}-${c[iS]}`, c[iF]);
  }
  return plans;
}

/** RxCUI to drug stem, from RxNorm product names such as "dupilumab 300 MG/2ML Prefilled Syringe [Dupixent]". */
export function rxcuiStems(concepts: { rxcui: string; name: string }[], drugs: Drug[] = DRUGS): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of concepts) {
    const n = c.name.toLowerCase();
    const d = drugs.find((x) => new RegExp(`\\b${x.stem}\\b`).test(n));
    if (d) out.set(c.rxcui, d.stem);
  }
  return out;
}

export function paRates(formulary: string, plans: Map<string, string>, stems: Map<string, string>, drugs: Drug[] = DRUGS): DrugPA[] {
  const lines = formulary.split(/\r?\n/);
  const h = lines[0].split("|");
  const iF = col(h, "FORMULARY_ID"), iR = col(h, "RXCUI"), iPA = col(h, "PRIOR_AUTHORIZATION_YN");
  // formulary -> stem -> { listed, needPA } product counts (by RxCUI, so NDC duplicates of one product count once)
  const byForm = new Map<string, Map<string, Map<string, boolean>>>();
  const wanted = new Set(plans.values());
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = line.split("|");
    if (!wanted.has(c[iF])) continue;
    const stem = stems.get(c[iR]);
    if (!stem) continue;
    const f = byForm.get(c[iF]) ?? new Map();
    byForm.set(c[iF], f);
    const s = f.get(stem) ?? new Map<string, boolean>();
    f.set(stem, s);
    s.set(c[iR], (s.get(c[iR]) ?? false) || c[iPA] === "Y");
  }
  return drugs.map((d) => {
    let covering = 0, allPA = 0, anyPA = 0;
    for (const formId of plans.values()) {
      const s = byForm.get(formId)?.get(d.stem);
      if (!s || !s.size) continue;
      covering++;
      const flags = [...s.values()];
      if (flags.every(Boolean)) allPA++;
      if (flags.some(Boolean)) anyPA++;
    }
    const rxcuis = [...stems].filter(([, st]) => st === d.stem).map(([r]) => r).sort();
    return { stem: d.stem, brand: d.brand, plansCovering: covering, plansAllPA: allPA, plansAnyPA: anyPA, rate: covering ? allPA / covering : 0, rxcuis };
  });
}
