// The engine: prescribers of prior auth drugs, rolled up to practices, segmented, placed in a territory, ranked,
// and phone checked. Pure functions over the committed snapshots in data/, so a run is deterministic.
import fs from "node:fs";
import path from "node:path";
import { DRUGS, LEFT_OUT, type Drug } from "./drugs.ts";
import type { DrugPA } from "./formulary.ts";
import type { NppesRecord } from "./fetch.ts";
import { buildingKey, comparePhones, digits10, isNyNumber, sameSite, siteKey, type PhoneCheck } from "./phone.ts";
import { territory, type CountyMap, type Territory } from "./territory.ts";
import { auditAction, type AuditLabel } from "./audit.ts";

/** A drug counts when it is on at least one New York plan and needs prior auth on at least this share of them. */
export const PA_GATE = 0.5;
/** Medicare groups with at least this many enrolled clinicians are routed as large groups, not BDR calls. */
export const LARGE_GROUP = 50;
/** Groups this big are a system sized sale, whoever owns them. */
export const SYSTEM_SIZE = 300;
/** A group is part of a system when at least this share of its prescribers, and at least MIN_SHARED of them, also bill under it. */
export const AFFILIATED_SHARE = 0.5;
export const MIN_SHARED = 2;
/** Part D's specialty for residents and fellows: a trainee is never an account. */
export const TRAINEE = "Student in an Organized Health Care Education/Training Program";

export interface DacRow { npi: string; facility: string; orgPac: string; orgMembers: number; addr: string; city: string; state: string; zip: string; phone: string; spec: string }
export interface PartDRow { npi: string; last: string; first: string; city: string; type: string; brand: string; generic: string; claims: number; fills30: number; cost: number }
export interface Customer { name: string; pattern: string; where: string; source: string; npis?: string[] }
export interface HrsaSite { name: string; addr: string; city: string; zip: string; org: string }

export interface Inputs {
  formulary: { drugs: DrugPA[]; nyPlans: number; nyFormularies: number; fetched: string; source: { name: string } };
  partd: PartDRow[];
  nppes: Record<string, NppesRecord>;
  dac: DacRow[];
  dacModified: string;
  customers: Customer[];
  /** Census ZIP to county, for territories (falls back to ZIP prefixes when absent). */
  counties?: CountyMap;
  /** HRSA health center sites in New York: safety net clinics. */
  hrsa?: HrsaSite[];
  /** Census ZIP centroids (lat, lon), only for drawing the card's map. */
  zips?: Record<string, [number, number]>;
  /** Audit labels (audit/labels.json). Absent, the rules alone route every account: that is what the audit measures. */
  audit?: AuditLabel[];
}

export type Segment = "independent" | "unverified" | "large_group" | "enterprise" | "forus_customer";
export const QUEUE: Record<Segment, string> = {
  independent: "BDR",
  unverified: "Research: verify first",
  large_group: "AE: multi site group",
  enterprise: "Enterprise: health system",
  forus_customer: "Account manager: expansion",
};

export interface Prescriber {
  npi: string;
  name: string;
  first: string;
  last: string;
  credential: string;
  specialty: string;
  claims: number;
  cost: number;
  drugs: Map<string, number>;
  nppes: NppesRecord;
  home?: DacRow;
  phoneCheck: PhoneCheck | "no_medicare_row";
  /** The Medicare number the check compared against the registry ("" when nothing was comparable). */
  medicarePhone: string;
}

export interface Practice {
  key: string;
  name: string;
  orgPac: string;
  orgMembers: number;
  segment: Segment;
  segmentWhy: string;
  customer?: Customer;
  site: { addr: string; city: string; zip: string };
  territory: Territory;
  prescribers: Prescriber[];
  /** Prescribers with no Medicare group who list this group's site and phone, attached to it. */
  attached: number;
  claims: number;
  cost: number;
  drugs: [string, number][];
  areas: string[];
  specialties: string[];
  phone: string;
  altPhone: string;
  fax: string;
  phoneCheck: PhoneCheck | "no_medicare_row";
  /** One sentence a rep can open with, built only from the account's own numbers. */
  talkingPoint: string;
  /** The Medicare number as listed, digits only, even when malformed: what the check saw. */
  medicareListed: string;
  /** The prescriber whose registry phone the check compared. */
  judgeNpi: string;
  rank: number;
  queueRank: number;
  tier: "A" | "B" | "C";
}

export interface Skip { npi: string; name: string; claims: number; reason: string }

export function loadInputs(dir = path.resolve("data")): Inputs {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const zipRows = <T>(j: { cols: readonly string[]; rows: unknown[][] }): T[] =>
    j.rows.map((r) => Object.fromEntries(j.cols.map((c, i) => [c, typeof r[i] === "number" ? r[i] : String(r[i] ?? "")])) as T);
  const dac = read("dac.json");
  return {
    formulary: read("formulary_ny.json"),
    partd: zipRows<PartDRow>(read("partd_ny.json")),
    nppes: read("nppes.json").records,
    dac: zipRows<DacRow>(dac),
    dacModified: dac.modified,
    customers: read("forus_customers.json").customers,
    counties: has("zip_county_ny.json") ? read("zip_county_ny.json") : undefined,
    hrsa: has("hrsa_ny.json") ? read("hrsa_ny.json").sites : undefined,
    zips: has("zcta_ny.json") ? read("zcta_ny.json").points : undefined,
    audit: fs.existsSync(path.join(dir, "..", "audit", "labels.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "..", "audit", "labels.json"), "utf8")).labels : undefined,
  };
}

export function gateDrugs(pa: DrugPA[], drugs: Drug[] = DRUGS) {
  const kept: (Drug & { pa: DrugPA })[] = [];
  const dropped: { stem: string; brand: string; reason: string }[] = [];
  for (const d of drugs) {
    const p = pa.find((x) => x.stem === d.stem);
    if (!p || p.plansCovering === 0) dropped.push({ stem: d.stem, brand: d.brand, reason: "no 2026 New York Medicare plan lists it" });
    else if (p.rate < PA_GATE) dropped.push({ stem: d.stem, brand: d.brand, reason: `needs prior auth on only ${Math.round(p.rate * 100)}% of the New York plans that list it` });
    else kept.push({ ...d, pa: p });
  }
  return { kept, dropped, leftOut: LEFT_OUT };
}

// Hospital, academic, payer owned and safety net groups have their own prior auth and specialty pharmacy teams:
// a different sale. The reason always quotes the word that matched, so a rep can see why.
const SYSTEM = /\b(HOSPITALS?|MEDICAL CENTER|MED CTR|HEALTH SYSTEMS?|HEALTH CARE SYSTEM|HEALTHCARE SYSTEM|HEALTH NETWORK|HEALTH PARTNERS|HEALTH CARE CORPORATION|UNIVERSITY|COLLEGE|SCHOOL OF MEDICINE|DEPARTMENT|FACULTY PRACTICE|FACULTY GROUP|FPP|HEALTH AND HOSPITALS|ACADEMIC|CANCER INSTITUTE|CANCER CENTER|PHYSICIAN SERVICES|PHYSICIAN AFFILIATE|COMMUNITY HEALTH|HEALTH CENTERS?|FQHC|RESEARCH FOUNDATION|NORTHWELL|NORTH SHORE|LIJ|MOUNT SINAI|MONTEFIORE|NYU|LANGONE|PRESBYTERIAN|WEILL|COLUMBIA|CORNELL|SUNY|STONY BROOK|ROCHESTER REGIONAL|KALEIDA|CATHOLIC HEALTH|ALBANY MED|WESTCHESTER MEDICAL|ST\.? JOHN|ST\.? BARNABAS|MAIMONIDES|LENOX HILL|SPECIAL SURGERY|RUPTURED AND CRIPPLED|MEMORIAL SLOAN|MSK|ROSWELL PARK|RPCI|OPTUM|NUVANCE|GUTHRIE|GARNET HEALTH|ONE MEDICAL)\b/;
// Words in a practice address that put it inside a hospital or a medical school.
// A word that is part of a street name ("Medical Center Dr", "University Ave") does not count.
const CAMPUS_ADDRESS = /\b(HOSPITAL|MEDICAL CENTER|MED CTR|DEPT|DEPARTMENT|UNIVERSITY|SCHOOL OF MEDICINE)\b(?!\s+(DR|DRIVE|RD|ROAD|AVE|AVENUE|ST|STREET|WAY|BLVD|PKWY|PARKWAY|PL|PLACE|PLZ|PLAZA|LN|LANE|CT|CIR|SQ|HWY|TPKE)\b)/;
/** A campus: at least this many clinicians at the address bill under a system named group, and they outnumber the rest two to one. */
export const CAMPUS_MIN = 3;
// Medicare groups that are not a practice a BDR can sell to: monitoring and telehealth vendors, nursing homes,
// hospitalists, urgent care, rehab, house calls, and agencies.
const NOT_PRACTICE = /\b(NEUROPHYSIOLOGY|NEUROMONITORING|INTRAOPERATIVE|TELEHEALTH|TELEMEDICINE|TELECARE|ON DEMAND|NURSING|SKILLED|HOSPITALISTS?|URGENT|ANESTHESIA|ANESTHESIOLOGY|HOUSING|COUNTY OF|STATE OF NEW YORK|COMPTROLLER|CEREBRAL PALSY|NYSARC|INSTITUTE OF TECHNOLOGY|HOME CARE|HOSPICE|DIALYSIS|REHABILITATION|PHYSICAL THERAPY|MOBILE|HOUSE CALLS)\b|^[A-Z.' ]+ COUNTY$/;

export interface Affiliation { system: string; shared: number; of: number }
export interface SiteFlag { why: string }

export function segmentOf(facility: string, orgMembers: number, customers: Customer[], aff?: Affiliation, site?: SiteFlag, unlisted = false, npis: string[] = []): { segment: Segment; why: string; customer?: Customer } {
  const name = facility.toUpperCase();
  // a known customer by its group name, or by a prescriber's NPI (a founder who bills alone has no group name to match)
  const customer = customers.find((c) => (name && new RegExp(`\\b(${c.pattern})\\b`).test(name)) || (c.npis ?? []).some((n) => npis.includes(n)));
  if (customer) return { segment: "forus_customer", why: `named as a Forus customer on forus.com (${customer.where})`, customer };
  const sys = name.match(SYSTEM);
  if (sys) return { segment: "enterprise", why: `Medicare group name says "${sys[0]}"` };
  if (orgMembers >= SYSTEM_SIZE) return { segment: "enterprise", why: `${orgMembers} clinicians in the Medicare group: a system sized account` };
  if (aff) return { segment: "enterprise", why: `${aff.shared} of its ${aff.of} prescribers also bill under ${titleCase(aff.system)}` };
  if (site) return { segment: "enterprise", why: site.why };
  if (orgMembers >= LARGE_GROUP) return { segment: "large_group", why: `${orgMembers} clinicians enrolled in the Medicare group` };
  if (unlisted) return { segment: "unverified", why: "in no Medicare group and not in Medicare's clinician file: often a nursing home or program clinician, or a stale address" };
  return { segment: "independent", why: orgMembers ? `${orgMembers} clinicians enrolled in the Medicare group` : "bills alone in Medicare's file, with no Medicare group at this address" };
}

/** True when a Medicare group reads as a system by name or size (the test segmentOf applies, minus affiliation). */
export const isSystemGroup = (facility: string, orgMembers: number) => SYSTEM.test(facility.toUpperCase()) || orgMembers >= SYSTEM_SIZE;
export const notPractice = (facility: string) => facility.toUpperCase().match(NOT_PRACTICE)?.[0];

const SMALL = new Set(["AND", "OF", "THE", "AT", "FOR", "IN", "ON"]);
const KEEP = new Set(["PC", "PLLC", "LLC", "LLP", "MD", "DO", "NP", "PA", "NY", "NYC", "USA", "II", "III", "GI", "ENT", "PT", "LP", "FAAD", "FACP", "FACR", "LI"]);
export function titleCase(s: string): string {
  return s
    .toUpperCase()
    .split(/(\s+)/)
    .map((w, i) => {
      const bare = w.replace(/[^A-Z]/g, "");
      if (KEEP.has(bare)) return w;
      if (i > 0 && SMALL.has(w)) return w.toLowerCase();
      return w.replace(/[A-Z][A-Z']*/g, (m) => m[0] + m.slice(1).toLowerCase());
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The Medicare row a prescriber is grouped by. A ranked choice, never file order, so the same data always routes the
 * same way: a group at the registry address, then any row there, then a group in the same ZIP, then any group; ties go
 * to the group listing this prescriber at the most sites, then the smaller group (a practice over a system that also
 * credentials the clinician), then the lower PAC ID.
 */
function pickHome(n: NppesRecord, rows: DacRow[]): DacRow | undefined {
  const ny = rows.filter((r) => r.state === "NY");
  const sitesFor = new Map<string, number>();
  for (const r of ny) if (r.orgPac) sitesFor.set(r.orgPac, (sitesFor.get(r.orgPac) ?? 0) + 1);
  const best = (cands: DacRow[]) =>
    [...cands].sort((a, b) =>
      (sitesFor.get(b.orgPac) ?? 0) - (sitesFor.get(a.orgPac) ?? 0) ||
      a.orgMembers - b.orgMembers ||
      a.orgPac.localeCompare(b.orgPac) ||
      a.addr.localeCompare(b.addr) ||
      a.zip.localeCompare(b.zip) ||
      a.phone.localeCompare(b.phone),
    )[0];
  const zip5 = n.loc.zip.slice(0, 5);
  // (a group at the registry address wins inside the first pass: the ranking puts group rows ahead of rows with no group)
  for (const pass of [
    (r: DacRow) => sameSite(r, n.loc),
    (r: DacRow) => !!r.orgPac && r.zip.slice(0, 5) === zip5,
    (r: DacRow) => !!r.orgPac,
    () => true,
  ]) {
    const hit = best(ny.filter(pass));
    if (hit) return hit;
  }
  return undefined;
}

/** The check, and the Medicare number it compared, so the account's phone is always the number that was checked. */
function prescriberPhoneCheck(n: NppesRecord, rows: DacRow[]): { check: PhoneCheck | "no_medicare_row"; medicare: string } {
  if (!rows.length) return { check: "no_medicare_row", medicare: "" };
  const same = rows.filter((r) => sameSite(r, n.loc));
  if (!same.length) return { check: "no_shared_site", medicare: "" };
  // When Medicare lists several phones at the site, the closest one is the fair comparison.
  const order: PhoneCheck[] = ["agree", "extension", "swap", "one_digit", "area_code", "same_exchange", "malformed", "differ", "one_missing"];
  // sorted by phone, so a tie between two listings never depends on the file's order
  const checks = [...same].sort((a, b) => a.phone.localeCompare(b.phone)).map((r) => ({ check: comparePhones(n.loc.phone, r.phone), medicare: r.phone }));
  for (const c of order) {
    const hit = checks.find((x) => x.check === c);
    if (hit) return hit;
  }
  return checks[0];
}

/** Which number goes in HubSpot's Phone Number: Medicare's, unless only the registry's rings in New York. */
export function choosePhones(medicare: string, registry: string, comparable: boolean): { phone: string; alt: string } {
  const ok = (d: string) => (d && !d.startsWith("!") ? d : "");
  const m = ok(digits10(medicare)), r = ok(digits10(registry));
  if (!m || !r || m === r) return { phone: m || r, alt: "" };
  if (!comparable) return { phone: m, alt: "" };
  if (!isNyNumber(m) && isNyNumber(r)) return { phone: r, alt: m };
  return { phone: m, alt: r };
}

export function build(inp: Inputs) {
  const gate = gateDrugs(inp.formulary.drugs);
  const keptStems = new Map(gate.kept.map((d) => [d.stem, d]));
  const dacBy = new Map<string, DacRow[]>();
  for (const r of inp.dac) (dacBy.get(r.npi) ?? dacBy.set(r.npi, []).get(r.npi)!).push(r);
  const orgRows = new Map<string, DacRow[]>();
  for (const r of inp.dac) if (r.orgPac) (orgRows.get(r.orgPac) ?? orgRows.set(r.orgPac, []).get(r.orgPac)!).push(r);

  // 1. prescribers: Part D claims for the drugs that pass the prior auth gate
  const by = new Map<string, { rows: PartDRow[]; claims: number; cost: number; drugs: Map<string, number> }>();
  let droppedClaims = 0;
  for (const r of inp.partd) {
    const stem = [...keptStems.keys()].find((s) => r.generic.toLowerCase().includes(s));
    if (!stem) { droppedClaims += r.claims; continue; }
    const o = by.get(r.npi) ?? { rows: [] as PartDRow[], claims: 0, cost: 0, drugs: new Map<string, number>() };
    by.set(r.npi, o);
    o.rows.push(r);
    o.claims += r.claims;
    o.cost += r.cost;
    o.drugs.set(stem, (o.drugs.get(stem) ?? 0) + r.claims);
  }

  const skipped: Skip[] = [];
  const prescribers: Prescriber[] = [];
  for (const [npi, o] of by) {
    const r0 = o.rows[0];
    const label = `${r0.first} ${r0.last}`.trim();
    const n = inp.nppes[npi];
    if (!n) { skipped.push({ npi, name: label, claims: o.claims, reason: "not found in the NPI registry" }); continue; }
    if (n.loc.state !== "NY") { skipped.push({ npi, name: label, claims: o.claims, reason: `practice location is in ${n.loc.state || "an unknown state"} per the NPI registry, though Part D lists New York` }); continue; }
    if (r0.type === TRAINEE) { skipped.push({ npi, name: label, claims: o.claims, reason: "a resident or fellow in training (Part D specialty)" }); continue; }
    const rows = dacBy.get(npi) ?? [];
    // Medicare's clinician file is newer than most registry entries: when it lists the prescriber only elsewhere, they moved
    if (rows.length && !rows.some((r) => r.state === "NY")) {
      const states = [...new Set(rows.map((r) => r.state))].sort().join(", ");
      skipped.push({ npi, name: label, claims: o.claims, reason: `Medicare's clinician file lists them only outside New York (${states}): the registry's New York address is stale` });
      continue;
    }
    const pc = prescriberPhoneCheck(n, rows);
    prescribers.push({
      npi, name: n.name || label, first: r0.first, last: r0.last, credential: n.credential, specialty: r0.type || n.taxonomy,
      claims: o.claims, cost: o.cost, drugs: o.drugs, nppes: n, home: pickHome(n, rows), phoneCheck: pc.check, medicarePhone: pc.medicare,
    });
  }

  // 2. practices: the Medicare group (org PAC ID) when there is one, otherwise the prescriber alone
  const groups = new Map<string, Prescriber[]>();
  for (const p of prescribers) {
    const key = p.home?.orgPac ? `org:${p.home.orgPac}` : `npi:${p.npi}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }

  // 2b. a prescriber with no Medicare group who lists a group's site and one of its phones there belongs to it
  // (a PA or NP who bills alone inside a group practice)
  const groupAt = new Map<string, { key: string; phones: Set<string>; claims: number }[]>();
  for (const [key, ps] of groups) {
    if (!key.startsWith("org:")) continue;
    const orgPac = key.slice(4);
    const bySite = new Map<string, Set<string>>();
    for (const p of ps) for (const r of dacBy.get(p.npi) ?? []) {
      if (r.orgPac !== orgPac) continue;
      const k = siteKey(r.addr, r.zip);
      if (!k) continue;
      const set = bySite.get(k) ?? new Set<string>();
      set.add(digits10(r.phone));
      set.add(digits10(p.nppes.loc.phone));
      bySite.set(k, set);
    }
    const claims = ps.reduce((s, p) => s + p.claims, 0);
    for (const [k, phones] of bySite) (groupAt.get(k) ?? groupAt.set(k, []).get(k)!).push({ key, phones, claims });
  }
  const attachedTo = new Map<string, number>();
  for (const [key, ps] of [...groups]) {
    if (!key.startsWith("npi:")) continue;
    const p = ps[0];
    const k = siteKey(p.nppes.loc.addr, p.nppes.loc.zip);
    const phone = digits10(p.nppes.loc.phone);
    const match = (groupAt.get(k) ?? []).filter((g) => phone && !phone.startsWith("!") && g.phones.has(phone)).sort((a, b) => b.claims - a.claims)[0];
    if (!match) continue;
    groups.get(match.key)!.push(p);
    groups.delete(key);
    attachedTo.set(match.key, (attachedTo.get(match.key) ?? 0) + 1);
  }

  // every system named or system sized Medicare group, the sites where a system named group lists clinicians,
  // and New York's federally funded health center sites
  const systems = new Map<string, string>();
  const atAddress = new Map<string, { sys: Map<string, Set<string>>; other: Set<string> }>();
  for (const r of inp.dac) {
    const isSys = !!r.orgPac && isSystemGroup(r.facility, r.orgMembers);
    if (isSys) systems.set(r.orgPac, r.facility);
    const k = buildingKey(r.addr, r.zip);
    if (!k || r.state !== "NY") continue;
    const o = atAddress.get(k) ?? { sys: new Map<string, Set<string>>(), other: new Set<string>() };
    atAddress.set(k, o);
    if (isSys && SYSTEM.test(r.facility.toUpperCase())) {
      const set = o.sys.get(r.facility) ?? new Set<string>();
      set.add(r.npi);
      o.sys.set(r.facility, set);
    } else o.other.add(r.npi);
  }
  // a medical office building shared with independents is not a campus, however many hospital clinicians it holds
  const campus = new Map<string, { system: string; sys: number; all: number }>();
  for (const [k, o] of atAddress) {
    const sysNpis = new Set([...o.sys.values()].flatMap((x) => [...x]));
    const other = [...o.other].filter((n) => !sysNpis.has(n)).length;
    if (sysNpis.size >= CAMPUS_MIN && other * 2 <= sysNpis.size) {
      const top = [...o.sys].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))[0][0];
      campus.set(k, { system: top, sys: sysNpis.size, all: sysNpis.size + other });
    }
  }
  // a health center in one suite of an office tower says nothing about the practice in another suite
  const suite = (addr: string) => {
    const m = addr.toUpperCase().match(/(?:\b(?:SUITE|STE|ROOM|RM|UNIT|FLOOR|FL)\b\.?|#)\s*([A-Z0-9]+)/);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  };
  const hrsaAt = new Map<string, { org: string; suite: string }[]>();
  for (const s of inp.hrsa ?? []) {
    const k = buildingKey(s.addr, s.zip);
    if (k) (hrsaAt.get(k) ?? hrsaAt.set(k, []).get(k)!).push({ org: s.org, suite: suite(s.addr) });
  }
  const hrsaMatch = (a: { addr: string; zip: string }) => {
    const k = buildingKey(a.addr, a.zip), own = suite(a.addr);
    return (hrsaAt.get(k) ?? []).find((h) => !own || h.suite === own);
  };
  // one main line listed by three or more Medicare groups, one of them a system: a hospital switchboard
  const groupsOnPhone = new Map<string, Set<string>>();
  for (const r of inp.dac) {
    const ph = digits10(r.phone);
    if (r.orgPac && r.state === "NY" && ph && !ph.startsWith("!")) (groupsOnPhone.get(ph) ?? groupsOnPhone.set(ph, new Set()).get(ph)!).add(r.orgPac);
  }
  const switchboard = (orgPac: string, phone: string): SiteFlag | undefined => {
    const ph = digits10(phone);
    const others = [...(groupsOnPhone.get(ph) ?? [])].filter((o) => o !== orgPac);
    const sys = others.find((o) => systems.has(o) && SYSTEM.test(systems.get(o)!.toUpperCase()));
    return others.length >= 2 && sys ? { why: `shares its main line with ${others.length} other Medicare groups, including ${titleCase(systems.get(sys)!)}: a system switchboard` } : undefined;
  };
  const affiliation = (orgPac: string, ps: Prescriber[]): Affiliation | undefined => {
    const count = new Map<string, number>();
    for (const p of ps) {
      const sys = new Set((dacBy.get(p.npi) ?? []).filter((r) => r.state === "NY" && r.orgPac !== orgPac && systems.has(r.orgPac)).map((r) => r.orgPac));
      for (const s of sys) count.set(s, (count.get(s) ?? 0) + 1);
    }
    const top = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return top && top[1] >= MIN_SHARED && top[1] / ps.length >= AFFILIATED_SHARE ? { system: systems.get(top[0])!, shared: top[1], of: ps.length } : undefined;
  };
  const siteFlag = (addrs: { addr: string; zip: string }[]): SiteFlag | undefined => {
    for (const a of addrs) {
      const word = a.addr.toUpperCase().match(CAMPUS_ADDRESS)?.[0];
      if (word) return { why: `practice address says "${word}"` };
    }
    for (const a of addrs) {
      const k = buildingKey(a.addr, a.zip);
      const h = hrsaMatch(a);
      if (h) return { why: `a federally funded health center site (${titleCase(h.org)}, per HRSA)` };
      const c = k ? campus.get(k) : undefined;
      if (c) return { why: `at an address where ${c.sys} of the ${c.all} clinicians in Medicare's file bill under a system group (${titleCase(c.system)})` };
    }
    return undefined;
  };

  const practices: Practice[] = [];
  for (const [key, ps] of groups) {
    ps.sort((a, b) => b.claims - a.claims || a.npi.localeCompare(b.npi));
    const lead = ps[0];
    const org = key.startsWith("org:") ? ps.find((p) => p.home?.orgPac === key.slice(4))!.home : undefined;
    // the practice site: the Medicare group address that carries the most claims among its prescribers
    const siteClaims = new Map<string, { row: DacRow; claims: number }>();
    for (const p of ps) if (p.home && (!org || p.home.orgPac === org.orgPac)) {
      const k = `${p.home.zip.slice(0, 5)}|${p.home.addr}`;
      const s = siteClaims.get(k) ?? { row: p.home, claims: 0 };
      s.claims += p.claims;
      siteClaims.set(k, s);
    }
    const siteRow = [...siteClaims.values()].sort((a, b) => b.claims - a.claims)[0]?.row;
    const site = siteRow ? { addr: siteRow.addr, city: siteRow.city, zip: siteRow.zip } : { addr: lead.nppes.loc.addr, city: lead.nppes.loc.city, zip: lead.nppes.loc.zip };
    const terr = territory(site.zip, inp.counties) ?? territory(lead.nppes.loc.zip, inp.counties);
    if (!terr) {
      for (const p of ps) skipped.push({ npi: p.npi, name: p.name, claims: p.claims, reason: `no New York territory for ZIP ${site.zip}` });
      continue;
    }
    const facility = org?.facility ?? "";
    const orgMembers = org?.orgMembers ?? 0;
    const np = facility ? notPractice(facility) : undefined;
    if (np) {
      for (const p of ps) skipped.push({ npi: p.npi, name: p.name, claims: p.claims, reason: `not a practice a BDR can sell to: Medicare group name says "${np}"` });
      continue;
    }
    const unlisted = key.startsWith("npi:") && !(dacBy.get(lead.npi) ?? []).length;
    const seg = segmentOf(facility || lead.nppes.name, orgMembers, inp.customers, org ? affiliation(org.orgPac, ps) : undefined,
      siteFlag([site]) ?? (org && siteRow ? switchboard(org.orgPac, siteRow.phone) : undefined), unlisted, ps.map((p) => p.npi));

    // phone: the clinician at the practice site with the most claims whose own check compares two numbers decides the
    // account's check (an attached PA with no Medicare row, or a missing phone, compares nothing), and the comparison
    // uses the account's own Medicare group rows at the site when there are any, so another group's line never decides it
    const atSite = siteRow ? ps.filter((p) => sameSite(p.nppes.loc, siteRow)) : ps;
    const ownCheck = (p: Prescriber) => {
      const own = org ? (dacBy.get(p.npi) ?? []).filter((r) => r.orgPac === org.orgPac && sameSite(r, p.nppes.loc)) : [];
      if (own.length) return prescriberPhoneCheck(p.nppes, own);
      // a member Medicare lists nowhere (an attached PA or MD) is compared against the group's own listing at the site
      const groupRows = org && !(dacBy.get(p.npi) ?? []).length ? (orgRows.get(org.orgPac) ?? []).filter((r) => sameSite(r, p.nppes.loc)) : [];
      return groupRows.length ? prescriberPhoneCheck(p.nppes, groupRows) : { check: p.phoneCheck, medicare: p.medicarePhone };
    };
    const judged = atSite.map((p) => ({ p, pc: ownCheck(p) }));
    const pick =
      judged.find((x) => !["no_medicare_row", "no_shared_site", "one_missing"].includes(x.pc.check)) ??
      judged.find((x) => x.pc.check !== "no_medicare_row") ??
      judged[0];
    const judge = pick?.p ?? lead;
    const judgePc = pick?.pc ?? { check: lead.phoneCheck, medicare: lead.medicarePhone };
    const medicarePhone = digits10(atSite.length && judgePc.medicare ? judgePc.medicare : siteRow?.phone);
    const check = siteRow ? (atSite.length ? judgePc.check : "no_shared_site") : lead.phoneCheck;
    const comparable = !["no_shared_site", "no_medicare_row", "one_missing"].includes(check);
    const { phone, alt: altPhone } = choosePhones(medicarePhone, judge.nppes.loc.phone, comparable);

    const drugs = new Map<string, number>();
    for (const p of ps) for (const [s, c] of p.drugs) drugs.set(s, (drugs.get(s) ?? 0) + c);
    const sortedDrugs = [...drugs].sort((a, b) => b[1] - a[1]);
    const areas = [...new Set(sortedDrugs.map(([s]) => keptStems.get(s)!.area))];
    const specialties = [...new Set(ps.map((p) => p.specialty).filter(Boolean))];
    const claimsTotal = ps.reduce((s, p) => s + p.claims, 0);
    // every number in the sentence is the account's own: the total over all its drugs, then each named drug's share
    const drugName = (s: string) => (s === "adalimumab" ? "Humira or a biosimilar" : keptStems.get(s)!.brand);
    const named = sortedDrugs.slice(0, 2).map(([s, c]) => `${drugName(s)} (${c.toLocaleString("en-US")})`);
    const k = sortedDrugs.length;
    const who = `${ps.length} prescriber${ps.length === 1 ? "" : "s"} here wrote ${claimsTotal.toLocaleString("en-US")} Medicare claims in 2024 for`;
    const talkingPoint = k === 1
      ? `${who} ${drugName(sortedDrugs[0][0])}, which needs prior auth on most New York plans that cover it.`
      : `${who} ${k} drugs that need prior auth on most New York plans that cover them, led by ${named.join(" and ")}.`;

    practices.push({
      key, name: facility ? titleCase(facility) : `${titleCase(lead.nppes.name)}${lead.credential ? ", " + lead.credential.replace(/\./g, "") : ""}`,
      orgPac: org?.orgPac ?? "", orgMembers, segment: seg.segment, segmentWhy: seg.why, customer: seg.customer,
      site, territory: terr, prescribers: ps, attached: attachedTo.get(key) ?? 0,
      claims: claimsTotal, cost: ps.reduce((s, p) => s + p.cost, 0),
      drugs: sortedDrugs, areas, specialties,
      phone, altPhone, fax: digits10(judge.nppes.loc.fax).replace(/^!.*/, ""), phoneCheck: check, talkingPoint, medicareListed: medicarePhone.replace("!", ""),
      judgeNpi: judge.npi, rank: 0, queueRank: 0, tier: "C",
    });
  }

  // 2c. audit corrections: a group practice the audit found was routed wrong is rerouted or dropped, citing the audit.
  // A sellable independent moves to the BDR queue from wherever the rules put it; a miss moves out of it. A known
  // customer is never moved, and an audit never moves an account from enterprise down to the AE queue.
  let audited = 0;
  if (inp.audit?.length) {
    const byId = new Map(inp.audit.map((a) => [a.id, a]));
    for (let i = practices.length - 1; i >= 0; i--) {
      const p = practices[i];
      const a = byId.get(p.key);
      const act = a ? auditAction(a.label) : null;
      if (!a || !act || p.segment === "forus_customer") continue;
      const cite = `audited: ${act.words} (docs/audit_${a.sample}.csv)`;
      if (act.skip) {
        for (const r of p.prescribers) skipped.push({ npi: r.npi, name: r.name, claims: r.claims, reason: cite });
        practices.splice(i, 1);
        audited++;
      } else if (act.queue && p.segment !== act.queue && !(p.segment === "enterprise" && act.queue === "large_group")) {
        p.segment = act.queue;
        p.segmentWhy = cite;
        audited++;
      }
    }
  }

  // 3. rank: all accounts by claims, then within each queue; tiers inside each queue by claim share
  practices.sort((a, b) => b.claims - a.claims || a.key.localeCompare(b.key));
  practices.forEach((p, i) => (p.rank = i + 1));
  for (const seg of Object.keys(QUEUE) as Segment[]) {
    const q = practices.filter((p) => p.segment === seg);
    q.forEach((p, i) => (p.queueRank = i + 1));
    const total = q.reduce((s, p) => s + p.claims, 0);
    let run = 0;
    for (const p of q) {
      p.tier = run < total * 0.5 ? "A" : run < total * 0.8 ? "B" : "C";
      run += p.claims;
    }
  }
  // every prescriber with a kept drug lands in exactly one place: an account, or the skipped list
  const inAccounts = practices.reduce((s, p) => s + p.prescribers.length, 0);
  return { gate, prescribers, practices, skipped, droppedClaims, withKeptDrugs: by.size, inAccounts, audited };
}

export type Run = ReturnType<typeof build>;
