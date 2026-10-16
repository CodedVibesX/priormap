// priormap tests: unit checks per module, an end to end fixture, then invariants on the committed snapshot.
// No framework: run with `npm test`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildingKey, comparePhones, digits10, sameSite, streetName, formatPhone, isNyNumber } from "../src/phone.ts";
import { territory } from "../src/territory.ts";
import { nyPlans, paRates, rxcuiStems } from "../src/formulary.ts";
import { build, choosePhones, gateDrugs, loadInputs, segmentOf, titleCase, QUEUE, LARGE_GROUP, TRAINEE, type DacRow, type Inputs, type PartDRow } from "../src/engine.ts";
import { cell, csv, companyRows, contactRows, COMPANY_HEADER, CONTACT_HEADER } from "../src/export.ts";
import { inject, rng, runEval, EXPECT, SURFACED, CONTROLS, type Injection } from "../src/eval.ts";
import { dashless, PRIVATE_URL } from "../scripts/audit_report.mts";
import { summarize } from "../src/summary.ts";
import { DRUGS } from "../src/drugs.ts";
import type { NppesRecord } from "../src/fetch.ts";
import type { DrugPA } from "../src/formulary.ts";

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`); }
}
function eq<T>(got: T, want: T, what = "") {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function ok(cond: unknown, what: string) { if (!cond) throw new Error(what); }
const root = (f: string) => fileURLToPath(new URL(`../${f}`, import.meta.url));

// ---------------------------------------------------------------- phone
test("phones normalize to ten digits; an 11 digit value without a leading 1 is malformed", () => {
  eq(digits10("(718) 283-7732"), "7182837732");
  eq(digits10("1-718-283-7732"), "7182837732");
  eq(digits10(""), "");
  eq(digits10("71889633763"), "!71889633763");
  eq(digits10("283-7732"), "!2837732");
});
test("phone checks: agree, typo, swap, area code, department line, different, malformed, missing", () => {
  eq(comparePhones("7182837732", "718-283-7732"), "agree");
  eq(comparePhones("7188867546", "7188867548"), "one_digit");
  eq(comparePhones("5032158619", "5032156819"), "swap", "two neighbors swapped");
  eq(comparePhones("2125551234", "6465551234"), "area_code");
  eq(comparePhones("2122418234", "2122419728"), "same_exchange");
  eq(comparePhones("8188257151", "9175254775"), "differ");
  eq(comparePhones("7188963376", "71889633763"), "extension", "an extension digit run into the number");
  eq(comparePhones("5164664700", "5164664700110"), "extension");
  eq(comparePhones("5164664700", "51646647"), "malformed");
  eq(comparePhones("5164664700", "9174664700110"), "malformed", "an extension on another number");
  eq(comparePhones("", "7182837732"), "one_missing");
});
test("swaps, single digits, and two scattered digits are told apart", () => {
  eq(comparePhones("2125551234", "2125551243"), "swap");
  eq(comparePhones("2125551234", "2125551334"), "one_digit");
  eq(comparePhones("2125551234", "2125559876"), "same_exchange");
  eq(comparePhones("2125551234", "2125561235"), "differ", "another exchange");
  eq(comparePhones("2125551234", "2135551235"), "differ");
});
test("same site means same ZIP5 and same street number, with Queens hyphens folded", () => {
  ok(sameSite({ addr: "4802 10TH AVE", zip: "112192916" }, { addr: "4802 10th Avenue Suite 2", zip: "11219" }), "same building");
  ok(sameSite({ addr: "142-04 BAYSIDE AVE", zip: "11354" }, { addr: "14204 BAYSIDE AVE STE 1", zip: "113543900" }), "Queens hyphen");
  ok(!sameSite({ addr: "4802 10TH AVE", zip: "11219" }, { addr: "4803 10TH AVE", zip: "11219" }), "next door");
  ok(!sameSite({ addr: "4802 10TH AVE", zip: "11219" }, { addr: "4802 10TH AVE", zip: "11220" }), "other ZIP");
  ok(!sameSite({ addr: "PO BOX 12", zip: "11219" }, { addr: "PO BOX 12", zip: "11219" }), "no street number");
});
test("phone format", () => eq(formatPhone("7182837732"), "(718) 283 7732"));

// ---------------------------------------------------------------- territory
test("territories: boroughs by ZIP prefix, then Long Island, Hudson Valley and upstate", () => {
  eq(territory("10016"), { region: "New York City", area: "Manhattan" });
  eq(territory("11219"), { region: "New York City", area: "Brooklyn" });
  eq(territory("11354"), { region: "New York City", area: "Queens" });
  eq(territory("10461"), { region: "New York City", area: "Bronx" });
  eq(territory("10314"), { region: "New York City", area: "Staten Island" });
  eq(territory("11530"), { region: "Long Island", area: "Nassau" });
  eq(territory("11747"), { region: "Long Island", area: "Suffolk" });
  eq(territory("10601"), { region: "Hudson Valley", area: "Westchester" });
  eq(territory("12208"), { region: "Upstate", area: "Capital Region" });
  eq(territory("14642"), { region: "Upstate", area: "Western New York" });
  eq(territory("07030"), null);
  eq(territory(""), null);
});

// ---------------------------------------------------------------- formulary
const PLAN_INFO = [
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|CONTRACT_NAME|PLAN_NAME|FORMULARY_ID|PREMIUM|DEDUCTIBLE|MA_REGION_CODE|PDP_REGION_CODE|STATE|COUNTY_CODE|SNP|PLAN_SUPPRESSED_YN",
  "H0001|001|000|A|NY HMO|F1|0|0| | |NY|33000|0|N",
  "H0001|001|000|A|NY HMO|F1|0|0| | |NY|33020|0|N",
  "H0002|001|000|B|NJ HMO|F2|0|0| | |NJ|31000|0|N",
  "S0001|001|000|C|NY PDP|F3|0|0| |03| | |0|N",
  "S0002|001|000|D|NJ PDP|F2|0|0| |04| | |0|N",
  "H0003|001|000|E|Suppressed|F4|0|0| | |NY|33000|0|Y",
].join("\n");
test("New York plans: Medicare Advantage by state, PDPs by region 03, suppressed plans out, one count per plan", () => {
  const p = nyPlans(PLAN_INFO);
  eq([...p.keys()].sort(), ["H0001-001-000", "S0001-001-000"]);
  eq(p.get("S0001-001-000"), "F3");
});
test("RxNorm names map to a stem on a word boundary, biosimilar suffixes included", () => {
  const m = rxcuiStems([
    { rxcui: "1", name: "dupilumab 300 MG/2ML Prefilled Syringe [Dupixent]" },
    { rxcui: "2", name: "adalimumab-adaz 40 MG/0.4ML Auto-Injector [Hyrimoz]" },
    { rxcui: "3", name: "metformin hydrochloride 500 MG Oral Tablet" },
    { rxcui: "4", name: "xdupilumab 1 MG Injection" },
  ]);
  eq([...m], [["1", "dupilumab"], ["2", "adalimumab"]]);
});
test("a plan needs PA only when every product of the drug on its formulary needs it", () => {
  const form = [
    "FORMULARY_ID|FORMULARY_VERSION|CONTRACT_YEAR|RXCUI|NDC|TIER_LEVEL_VALUE|QUANTITY_LIMIT_YN|QUANTITY_LIMIT_AMOUNT|QUANTITY_LIMIT_DAYS|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN|SELECTED_DRUG_YN",
    "F1|1|2026|1|N1|5|N|0|0|Y|N|N",
    "F1|1|2026|1|N2|5|N|0|0|Y|N|N",
    "F3|1|2026|1|N1|5|N|0|0|Y|N|N",
    "F3|1|2026|2|N3|5|N|0|0|N|N|N",
    "F2|1|2026|1|N1|5|N|0|0|N|N|N",
  ].join("\n");
  const stems = new Map([["1", "dupilumab"], ["2", "dupilumab"]]);
  const [d] = paRates(form, nyPlans(PLAN_INFO), stems, [DRUGS[0]]);
  eq([d.plansCovering, d.plansAllPA, d.plansAnyPA, d.rate], [2, 1, 2, 0.5]);
});
test("the drug gate drops drugs no New York plan lists, and drugs that rarely need PA", () => {
  const pa = (stem: string, covering: number, all: number): DrugPA => ({ stem, brand: stem, plansCovering: covering, plansAllPA: all, plansAnyPA: all, rate: covering ? all / covering : 0, rxcuis: [] });
  const g = gateDrugs([pa("dupilumab", 10, 10), pa("upadacitinib", 0, 0), pa("certolizumab", 10, 2)], DRUGS.slice(0, 3));
  eq(g.kept.map((d) => d.stem), ["dupilumab"]);
  eq(g.dropped.map((d) => d.stem), ["upadacitinib", "certolizumab"]);
  ok(g.dropped[1].reason.includes("20%"), "the reason quotes the measured rate");
  eq(g.dropped[0].reason, "no 2026 New York Medicare plan lists it");
});

// ---------------------------------------------------------------- segments and names
const CUST = [{ name: "Modern Migraine MD", pattern: "MODERN MIGRAINE", where: "New York, NY", source: "https://www.forus.com/stories/x" }];
test("segments: Forus customer first, then health system by name, then large group by size, else independent", () => {
  eq(segmentOf("MODERN MIGRAINE MD PLLC", 2, CUST).segment, "forus_customer");
  eq(segmentOf("MAIMONIDES MEDICAL CENTER RHEUMATOLOGY FPP", 5, CUST).segment, "enterprise");
  eq(segmentOf("NEW YORK UNIVERSITY", 4000, CUST).segment, "enterprise");
  eq(segmentOf("SCHWEIGER DERMATOLOGY PLLC", LARGE_GROUP, CUST).segment, "large_group");
  eq(segmentOf("MANHATTAN ALLERGY PC", LARGE_GROUP - 1, CUST).segment, "independent");
  eq(segmentOf("", 0, CUST).segment, "independent");
});
test("a hospital word inside another word does not make a health system", () => {
  eq(segmentOf("HOSPITALITY DERMATOLOGY PC", 3, CUST).segment, "independent");
  eq(segmentOf("PANYU DERMATOLOGY PC", 3, CUST).segment, "independent", "NYU inside another word");
});
test("names: title case keeps legal suffixes and lowercases small words", () => {
  eq(titleCase("PARK AVENUE ALLERGY AND ASTHMA PLLC"), "Park Avenue Allergy and Asthma PLLC");
  eq(titleCase("O'CONNOR RHEUMATOLOGY PC"), "O'connor Rheumatology PC");
});

// ---------------------------------------------------------------- end to end fixture
const DUPI = { stem: "dupilumab", brand: "Dupixent", plansCovering: 202, plansAllPA: 202, plansAnyPA: 202, rate: 1, rxcuis: [] };
const UPA = { stem: "upadacitinib", brand: "Rinvoq", plansCovering: 0, plansAllPA: 0, plansAnyPA: 0, rate: 0, rxcuis: [] };
function nppes(npi: string, over: Partial<NppesRecord["loc"]> = {}, rec: Partial<NppesRecord> = {}): NppesRecord {
  return { npi, type: "NPI-1", name: `Doc ${npi}`, credential: "M.D.", taxonomy: "Dermatology", taxonomyCode: "207N00000X",
    loc: { addr: "100 MAIN ST", city: "BROOKLYN", state: "NY", zip: "112010000", phone: "7182220000", fax: "", ...over }, others: [], updated: "2025-01-01", ...rec };
}
function partd(npi: string, claims: number, generic = "Dupilumab"): PartDRow {
  return { npi, last: "Doe", first: "Jane", city: "Brooklyn", type: "Dermatology", brand: "Dupixent", generic, claims, fills30: claims, cost: claims * 3000 };
}
function dac(npi: string, over: Partial<DacRow> = {}): DacRow {
  return { npi, facility: "", orgPac: "", orgMembers: 0, addr: "100 MAIN ST", city: "BROOKLYN", state: "NY", zip: "112010000", phone: "7182220000", spec: "DERMATOLOGY", ...over };
}
function fixture(): Inputs {
  return {
    formulary: { drugs: [DUPI, UPA], nyPlans: 202, nyFormularies: 51, fetched: "2026-10-14", source: { name: "test" } },
    partd: [
      partd("1000000001", 300), partd("1000000002", 100), // a two doctor group
      partd("1000000003", 50), // solo, phone one digit off between directories
      partd("1000000004", 40), // practice in Oregon per the registry
      partd("1000000005", 30), // not in the registry
      partd("1000000006", 500), // health system
      partd("1000000001", 999, "Upadacitinib"), // a drug no New York plan lists: never counted
    ],
    nppes: {
      "1000000001": nppes("1000000001", { phone: "7183332222" }),
      "1000000002": nppes("1000000002", { phone: "7183332222" }),
      "1000000003": nppes("1000000003", { addr: "5 OAK ST", zip: "100160000", phone: "2125551234" }),
      "1000000004": nppes("1000000004", { state: "OR", zip: "972130000" }),
      "1000000006": nppes("1000000006", { addr: "1 HOSPITAL PLAZA", zip: "104610000", phone: "7189990000" }),
    },
    dac: [
      dac("1000000001", { facility: "BROOKLYN SKIN PC", orgPac: "111", orgMembers: 4, phone: "7183332222" }),
      dac("1000000002", { facility: "BROOKLYN SKIN PC", orgPac: "111", orgMembers: 4, phone: "7183332222" }),
      dac("1000000003", { addr: "5 OAK ST", zip: "10016", phone: "2125551243" }),
      dac("1000000006", { facility: "BRONX MEDICAL CENTER FACULTY PRACTICE", orgPac: "222", orgMembers: 900, addr: "1 HOSPITAL PLAZA", zip: "10461", phone: "7189990001" }),
    ],
    dacModified: "2026-08-18",
    customers: CUST,
  };
}
const fx = build(fixture());
const byKey = new Map(fx.practices.map((p) => [p.key, p]));
test("fixture: prescribers roll up to their Medicare group, solos stand alone", () => {
  eq(fx.practices.map((p) => p.key).sort(), ["npi:1000000003", "org:111", "org:222"]);
  eq(byKey.get("org:111")!.prescribers.length, 2);
  eq(byKey.get("org:111")!.claims, 400);
  eq(byKey.get("org:111")!.name, "Brooklyn Skin PC");
});
test("fixture: claims for a drug no New York plan lists never count", () => {
  ok(!fx.practices.some((p) => p.drugs.some(([s]) => s === "upadacitinib")), "upadacitinib counted");
  eq(fx.droppedClaims, 999);
});
test("fixture: out of state locations and unknown NPIs are skipped with a reason", () => {
  eq(fx.skipped.map((s) => s.npi).sort(), ["1000000004", "1000000005"]);
  ok(fx.skipped.find((s) => s.npi === "1000000004")!.reason.includes("OR"), "names the state");
});
test("fixture: segments and queues", () => {
  eq(byKey.get("org:111")!.segment, "independent");
  eq(byKey.get("org:222")!.segment, "enterprise");
  eq(QUEUE[byKey.get("org:222")!.segment], "Enterprise: health system");
});
test("fixture: phone check per account, with Medicare's number first and the registry's second when they differ", () => {
  const solo = byKey.get("npi:1000000003")!;
  eq(solo.phoneCheck, "swap");
  eq([solo.phone, solo.altPhone], ["2125551243", "2125551234"]);
  eq(byKey.get("org:111")!.phoneCheck, "agree");
  eq(byKey.get("org:111")!.altPhone, "");
  eq(byKey.get("org:222")!.phoneCheck, "one_digit");
});
test("the exported phone is the number the check compared, even when Medicare lists two rows at the site", () => {
  const inp = fixture();
  // the solo prescriber's first Medicare row (another group, another number) becomes the home row; the second agrees
  inp.dac = inp.dac.filter((r) => r.npi !== "1000000003");
  inp.dac.push(dac("1000000003", { facility: "OAK STREET GROUP PC", orgPac: "333", orgMembers: 3, addr: "5 OAK ST", zip: "10016", phone: "2125550000" }));
  inp.dac.push(dac("1000000003", { facility: "OAK STREET GROUP PC", orgPac: "333", orgMembers: 3, addr: "5 OAK ST", zip: "10016", phone: "2125551234" }));
  const p = build(inp).practices.find((x) => x.key === "org:333")!;
  eq(p.phoneCheck, "agree");
  eq(p.phone, "2125551234");
});
test("fixture: ranks by claims, queue ranks restart per queue", () => {
  eq(fx.practices.map((p) => [p.key, p.rank, p.queueRank]), [["org:222", 1, 1], ["org:111", 2, 1], ["npi:1000000003", 3, 2]]);
});
test("fixture: tiers split each queue by its share of claims", () => {
  eq(byKey.get("org:111")!.tier, "A");
  eq(byKey.get("npi:1000000003")!.tier, "C", "the first account already holds over 80% of the queue");
});
test("fixture: a Forus customer is routed to expansion, not to a BDR", () => {
  const inp = fixture();
  inp.dac[0] = { ...inp.dac[0], facility: "MODERN MIGRAINE MD PLLC" };
  inp.dac[1] = { ...inp.dac[1], facility: "MODERN MIGRAINE MD PLLC" };
  const p = build(inp).practices.find((x) => x.key === "org:111")!;
  eq(p.segment, "forus_customer");
  eq(p.customer?.name, "Modern Migraine MD");
});

// ---------------------------------------------------------------- the review fixes: who is a BDR account
const COUNTIES = {
  zips: { "11758": "36059", "11004": "36081", "14642": "36055", "12524": "36027", "11201": "36047" },
  names: { "36059": "Nassau County", "36081": "Queens County", "36055": "Monroe County", "36027": "Dutchess County", "36047": "Kings County" },
};
test("territories by county: Massapequa is Nassau, Glen Oaks is Queens, upstate by council region; unknown ZIPs fall back to the prefix", () => {
  eq(territory("11758", COUNTIES), { region: "Long Island", area: "Nassau" });
  eq(territory("11004", COUNTIES), { region: "New York City", area: "Queens" });
  eq(territory("14642", COUNTIES), { region: "Upstate", area: "Finger Lakes" });
  eq(territory("12524", COUNTIES), { region: "Hudson Valley", area: "Dutchess" });
  eq(territory("11797", COUNTIES), { region: "Long Island", area: "Suffolk" }, "not in the county map: prefix fallback");
});
test("phones follow the North American plan: an area code or exchange starting with 0 or 1 is malformed", () => {
  eq(digits10("1461789509"), "!1461789509");
  eq(digits10("7181789509"), "!7181789509");
  eq(digits10("17182789509"), "7182789509");
  ok(isNyNumber("(718) 278 9509") && !isNyNumber("5015551234"), "New York area codes");
});
test("HubSpot's Phone Number is Medicare's, unless only the registry's rings in New York", () => {
  eq(choosePhones("5015552000", "7185552000", true), { phone: "7185552000", alt: "5015552000" });
  eq(choosePhones("7185552000", "2125552000", true), { phone: "7185552000", alt: "2125552000" });
  eq(choosePhones("7185552000", "2125552000", false), { phone: "7185552000", alt: "" }, "different sites: no second phone");
  eq(choosePhones("", "2125552000", true), { phone: "2125552000", alt: "" });
});
function reviewFixture(): Inputs {
  const inp = fixture();
  inp.counties = COUNTIES;
  const add = (npi: string, claims: number, loc: Partial<NppesRecord["loc"]>, rows: Partial<DacRow>[] = [], type?: string) => {
    inp.partd.push({ ...partd(npi, claims), ...(type ? { type } : {}) });
    inp.nppes[npi] = nppes(npi, loc);
    for (const r of rows) inp.dac.push(dac(npi, r));
  };
  // a resident, and a vendor group
  add("2000000001", 80, {}, [], TRAINEE);
  add("2000000002", 90, { addr: "9 ELM ST", zip: "112010000", phone: "7184442000" }, [{ facility: "ON DEMAND NEUROLOGY PLLC", orgPac: "444", orgMembers: 6, addr: "9 ELM ST", phone: "7184442000" }]);
  // a PA billing alone inside Brooklyn Skin PC: same site, same phone; and a stranger in the same building with their own phone
  add("2000000003", 20, { phone: "7183332222" });
  add("2000000004", 15, { phone: "7189993000" });
  // a hospital campus: three system clinicians at 200 Pelham Pkwy, plus a doctor billing alone there
  for (const n of ["2000000011", "2000000012", "2000000013"]) inp.dac.push(dac(n, { facility: "BRONX MEDICAL CENTER FACULTY PRACTICE", orgPac: "222", orgMembers: 900, addr: "200 PELHAM PKWY", zip: "10461", phone: "7185550100" }));
  add("2000000005", 30, { addr: "200 PELHAM PKWY", zip: "104610000", phone: "7185550199" });
  // an office building: the same three system clinicians, but four independents beside them
  for (const n of ["2000000021", "2000000022", "2000000023"]) inp.dac.push(dac(n, { facility: "BRONX MEDICAL CENTER FACULTY PRACTICE", orgPac: "222", orgMembers: 900, addr: "300 MORRIS PARK AVE", zip: "10461", phone: "7185550300" }));
  for (const n of ["2000000031", "2000000032", "2000000033", "2000000034"]) inp.dac.push(dac(n, { facility: `GROUP ${n}`, orgPac: n, orgMembers: 2, addr: "300 MORRIS PARK AVE", zip: "10461", phone: "7185550400" }));
  add("2000000006", 25, { addr: "300 MORRIS PARK AVE", zip: "104610000", phone: "7185550499" }, [{ addr: "300 MORRIS PARK AVE", zip: "10461", phone: "7185550499" }]);
  // a federally funded health center site, and two street names that only sound like hospitals
  inp.hrsa = [{ name: "Fordham Site", addr: "1 Fordham Plz", city: "Bronx", zip: "10458", org: "BRONX COMMUNITY HEALTH NETWORK, INC." }];
  add("2000000007", 40, { addr: "1 FORDHAM PLZ", zip: "104580000", phone: "7185550500" });
  add("2000000008", 35, { addr: "2250 UNIVERSITY AVE", zip: "104680000", phone: "7185550600" }, [{ addr: "2250 UNIVERSITY AVE", zip: "10468", phone: "7185550600" }]);
  add("2000000009", 33, { addr: "5 MAIN ST DEPT OF MEDICINE", zip: "112010000", phone: "7185550700" });
  // one prescriber who also bills under a system group: not enough to call the practice part of it
  add("2000000010", 50, { addr: "7 PINE ST", zip: "112010000", phone: "7185550800" }, [
    { facility: "PINE STREET DERMATOLOGY PC", orgPac: "555", orgMembers: 1, addr: "7 PINE ST", phone: "7185550800" },
    { facility: "BRONX MEDICAL CENTER FACULTY PRACTICE", orgPac: "222", orgMembers: 900, addr: "1 HOSPITAL PLAZA", zip: "10461", phone: "7189990001" },
  ]);
  // moved: Medicare's clinician file lists them only in New Jersey; and a prescriber Medicare's file does not list at all
  add("2000000014", 45, { addr: "8 ASH ST", zip: "112010000", phone: "7185550900" }, [{ addr: "1 RIVER RD", city: "HACKENSACK", state: "NJ", zip: "07601", phone: "2015550900" }]);
  add("2000000015", 44, { addr: "9 ASH ST", zip: "112010000", phone: "7185551000" });
  // a solo allergist in suite 802 of a tower where a health center runs a site without a suite: not a health center
  inp.hrsa.push({ name: "Midtown Site", addr: "30 E 40th St", city: "New York", zip: "10016", org: "CARE FOR THE HOMELESS" });
  add("2000000016", 43, { addr: "30 E 40TH ST RM 802", zip: "100160000", phone: "2125551100" }, [{ addr: "30 E 40TH ST RM 802", zip: "10016", phone: "2125551100" }]);
  // a hospital switchboard: one main line on four Medicare groups, one of them the hospital
  inp.dac.push(dac("2000000041", { facility: "EASTSIDE HOSPITAL CENTER", orgPac: "661", orgMembers: 200, addr: "1 YORK PL", zip: "10065", phone: "2125552000" }));
  inp.dac.push(dac("2000000042", { facility: "EASTSIDE DERMATOLOGY GROUP", orgPac: "662", orgMembers: 40, addr: "2 YORK PL", zip: "10065", phone: "2125552000" }));
  inp.dac.push(dac("2000000043", { facility: "EASTSIDE PULMONARY GROUP", orgPac: "663", orgMembers: 30, addr: "3 YORK PL", zip: "10065", phone: "2125552000" }));
  add("2000000017", 42, { addr: "4 YORK PL", zip: "100650000", phone: "2125552000" }, [{ facility: "EASTSIDE NEUROLOGY GROUP", orgPac: "664", orgMembers: 45, addr: "4 YORK PL", zip: "10065", phone: "2125552000" }]);
  return inp;
}
const rv = build(reviewFixture());
const rvAcct = (npi: string) => rv.practices.find((p) => p.prescribers.some((r) => r.npi === npi));
test("residents and fellows are never accounts", () => {
  ok(rv.skipped.find((s) => s.npi === "2000000001")?.reason.includes("resident"), "trainee skipped");
});
test("a monitoring vendor, a nursing home or an agency is skipped with the word that matched", () => {
  ok(rv.skipped.find((s) => s.npi === "2000000002")?.reason.includes('"ON DEMAND"'), "vendor skipped");
});
test("a prescriber billing alone at a group's site, on the group's phone, joins the group; a neighbor with their own phone does not", () => {
  eq(rvAcct("2000000003")?.key, "org:111");
  eq(rvAcct("2000000003")?.attached, 1);
  eq(rvAcct("2000000004")?.key, "npi:2000000004");
});
test("a hospital campus routes to enterprise; an office building shared with independents does not", () => {
  eq(rvAcct("2000000005")?.segment, "enterprise");
  ok(rvAcct("2000000005")!.segmentWhy.includes("3 of the 3 clinicians"), rvAcct("2000000005")!.segmentWhy);
  eq(rvAcct("2000000006")?.segment, "independent");
});
test("a federally funded health center site routes to enterprise, citing HRSA", () => {
  eq(rvAcct("2000000007")?.segment, "enterprise");
  ok(rvAcct("2000000007")!.segmentWhy.includes("HRSA"), "cites HRSA");
});
test("a street name is not a hospital; a department in the address is", () => {
  eq(rvAcct("2000000008")?.segment, "independent", "2250 University Ave");
  eq(rvAcct("2000000009")?.segment, "enterprise", "Dept of Medicine");
});
test("one prescriber who also bills under a system does not make the practice part of it", () => {
  eq(rvAcct("2000000010")?.segment, "independent");
});
test("a prescriber Medicare's clinician file lists only outside New York has moved: skipped, naming the state", () => {
  ok(rv.skipped.find((s) => s.npi === "2000000014")?.reason.includes("only outside New York (NJ)"), "moved");
});
test("a prescriber in no Medicare group and missing from Medicare's file goes to verify first, not to a BDR", () => {
  eq(rvAcct("2000000015")?.segment, "unverified");
  eq(QUEUE.unverified, "Research: verify first");
});
test("a health center elsewhere in an office tower does not make a suite in it a health center", () => {
  eq(rvAcct("2000000016")?.segment, "independent");
});
test("a main line shared with a hospital and two more groups is a switchboard: enterprise", () => {
  eq(rvAcct("2000000017")?.segment, "enterprise");
  ok(rvAcct("2000000017")!.segmentWhy.includes("switchboard"), rvAcct("2000000017")!.segmentWhy);
});

// ---------------------------------------------------------------- the final review fixes
test("the talking point's numbers are the account's own: the total over all its drugs, then each named drug's share", () => {
  const inp = fixture();
  inp.formulary.drugs.push({ stem: "certolizumab", brand: "Cimzia", plansCovering: 11, plansAllPA: 11, plansAnyPA: 11, rate: 1, rxcuis: [] });
  inp.partd.push(partd("1000000001", 50, "Certolizumab Pegol"));
  const p = build(inp).practices.find((x) => x.key === "org:111")!;
  eq(p.claims, 450);
  eq(p.talkingPoint, "2 prescribers here wrote 450 Medicare claims in 2024 for 2 drugs that need prior auth on most New York plans that cover them, led by Dupixent (400) and Cimzia (50).");
});
test("routing does not depend on the order Medicare's file lists its rows", () => {
  const sig = (inp: Inputs) => build(inp).practices.map((p) => `${p.key}|${p.segment}|${p.prescribers.map((r) => r.npi).sort().join(",")}`).sort();
  const inp = reviewFixture();
  eq(sig({ ...inp, dac: [...inp.dac].reverse() }), sig(inp));
});
test("a prescriber in two groups away from their registry address joins the group that lists them at more sites, then the smaller", () => {
  const inp = fixture();
  inp.partd.push(partd("3000000001", 70));
  inp.nppes["3000000001"] = nppes("3000000001", { addr: "1 ELSEWHERE RD", zip: "112010000", phone: "7185553000" });
  inp.dac.push(dac("3000000001", { facility: "BIG HOSPITAL MEDICAL CENTER", orgPac: "901", orgMembers: 3000, addr: "1 HOSPITAL PLAZA", zip: "10461", phone: "7185553001" }));
  inp.dac.push(dac("3000000001", { facility: "SMALL SKIN PC", orgPac: "902", orgMembers: 3, addr: "5 MAIN ST", zip: "11201", phone: "7185553002" }));
  const fwd = build(inp).practices.find((p) => p.prescribers.some((r) => r.npi === "3000000001"))!;
  const rev = build({ ...inp, dac: [...inp.dac].reverse() }).practices.find((p) => p.prescribers.some((r) => r.npi === "3000000001"))!;
  eq(fwd.key, "org:902");
  eq(rev.key, "org:902");
});
test("a Forus customer is matched by a prescriber's NPI when it bills without a Medicare group", () => {
  const inp = fixture();
  inp.customers = [{ ...CUST[0], npis: ["1000000003"] }];
  const p = build(inp).practices.find((x) => x.key === "npi:1000000003")!;
  eq(p.segment, "forus_customer");
});
test("audit labels correct the routing both ways and cite the audit; without them the rules alone route", () => {
  const inp = fixture();
  inp.audit = [
    { sample: "dev", id: "org:111", label: "hospital_academic_or_system", how: "agreed" },
    { sample: "heldout", id: "npi:1000000003", label: "not_a_practice", how: "tiebreak" },
    { sample: "dev", id: "org:222", label: "independent_specialty", how: "agreed" },
  ];
  const run = build(inp);
  const g = run.practices.find((p) => p.key === "org:111")!;
  eq(g.segment, "enterprise");
  ok(g.segmentWhy.includes("docs/audit_dev.csv"), g.segmentWhy);
  ok(!run.practices.some((p) => p.key === "npi:1000000003"), "audited non practice still listed");
  ok(run.skipped.some((s) => s.npi === "1000000003" && s.reason.includes("audited")), "skip cites the audit");
  eq(run.practices.find((p) => p.key === "org:222")!.segment, "independent", "a sellable independent moves to BDR");
  eq(run.audited, 3);
  eq(build({ ...inp, audit: undefined }).practices.find((p) => p.key === "org:111")!.segment, "independent");
});
test("the published audit labels hold group practices only: no prescriber billing alone is labeled in public", () => {
  const labels = JSON.parse(readFileSync(root("audit/labels.json"), "utf8")).labels as { id: string }[];
  ok(labels.length > 0 && labels.every((l) => l.id.startsWith("org:")), "a non group label is published");
  for (const f of ["audit/dev_sample.json", "audit/heldout_sample.json"]) {
    const t = readFileSync(root(f), "utf8");
    ok(!/npi:\d|"h:/.test(t), `${f} identifies a prescriber billing alone`);
  }
});
test("a health center or campus must share the street, not just the ZIP and house number", () => {
  eq(streetName("5 E 98TH ST"), "98");
  eq(streetName("5 East 98 Street"), "98");
  eq(streetName("1 Fordham Plz"), "FORDHAM");
  eq(streetName("142 - 04 BAYSIDE AVE"), "BAYSIDE");
  eq(streetName("10 SAINT MARKS PL"), "ST");
  eq(buildingKey("1 FORDHAM PLZ", "10458"), buildingKey("1 Fordham Plz", "10458"));
  ok(buildingKey("1 OTHER ST", "10458") !== buildingKey("1 Fordham Plz", "10458"), "another street");
  const inp = reviewFixture();
  inp.partd.push(partd("3000000005", 30), partd("3000000006", 30));
  inp.nppes["3000000005"] = nppes("3000000005", { addr: "1 OTHER ST", zip: "104580000", phone: "7185557000" });
  inp.nppes["3000000006"] = nppes("3000000006", { addr: "200 MORRIS AVE", zip: "104610000", phone: "7185557100" });
  inp.dac.push(dac("3000000005", { addr: "1 OTHER ST", zip: "10458", phone: "7185557000" }));
  inp.dac.push(dac("3000000006", { addr: "200 MORRIS AVE", zip: "10461", phone: "7185557100" }));
  const run = build(inp);
  eq(run.practices.find((p) => p.key === "npi:3000000005")!.segment, "independent", "not the health center on Fordham Plaza");
  eq(run.practices.find((p) => p.key === "npi:3000000006")!.segment, "independent", "not the campus on Pelham Parkway");
});
test("the Queens hyphen folds with or without spaces", () => {
  ok(sameSite({ addr: "114 - 81 177 PLACE", zip: "11434" }, { addr: "11481 177TH PL", zip: "114341234" }), "spaced hyphen");
});
/**
 * The group's busiest site is 9 Second St, but the member Medicare lists there gives the registry another address,
 * so the only prescriber the registry places at the site is an attached MD with no Medicare rows of their own.
 * Another member who writes nothing is also listed at the site, on the same main line.
 */
function attachedFixture(): Inputs {
  const inp = fixture();
  const at = { facility: "BROOKLYN SKIN PC", orgPac: "111", orgMembers: 4, addr: "9 SECOND ST", zip: "11201", phone: "7186667777" };
  inp.partd.push(partd("3000000007", 5000), partd("3000000008", 1000));
  inp.nppes["3000000007"] = nppes("3000000007", { addr: "9 SECOND ST", zip: "112010000", phone: "7186667777" });
  inp.nppes["3000000008"] = nppes("3000000008", { addr: "77 ELSEWHERE AVE", zip: "112010000", phone: "7186667777" });
  inp.dac.push(dac("3000000008", at), dac("3000000009", at));
  return inp;
}
test("a member Medicare lists nowhere is compared against the group's own listing at the site", () => {
  const p = build(attachedFixture()).practices.find((x) => x.prescribers.some((r) => r.npi === "3000000007"))!;
  eq(p.key, "org:111");
  eq(p.site.addr, "9 SECOND ST");
  eq(p.phoneCheck, "agree");
  eq(p.phone, "7186667777");
});
test("the eval corrupts a group's number everywhere Medicare prints it, members who write nothing included", () => {
  const ev = runEval(attachedFixture());
  ok(ev.cleanPractices >= 1, "no clean account");
  for (const [k, v] of Object.entries(ev.perKind)) if (!CONTROLS.has(k as Injection)) eq(v.caught, v.n, `${k} missed`);
  eq(ev.falseFlags, 0);
});
test("the talking point reads naturally for one drug and names a total over more than two", () => {
  const inp = fixture();
  inp.formulary.drugs.push({ stem: "certolizumab", brand: "Cimzia", plansCovering: 11, plansAllPA: 11, plansAnyPA: 11, rate: 1, rxcuis: [] });
  inp.formulary.drugs.push({ stem: "risankizumab", brand: "Skyrizi", plansCovering: 202, plansAllPA: 196, plansAnyPA: 196, rate: 0.97, rxcuis: [] });
  inp.partd.push(partd("1000000001", 50, "Certolizumab Pegol"), partd("1000000002", 25, "Risankizumab Rzaa"));
  const run = build(inp);
  eq(run.practices.find((x) => x.key === "org:111")!.talkingPoint, "2 prescribers here wrote 475 Medicare claims in 2024 for 3 drugs that need prior auth on most New York plans that cover them, led by Dupixent (400) and Cimzia (50).");
  eq(run.practices.find((x) => x.key === "npi:1000000003")!.talkingPoint, "1 prescriber here wrote 50 Medicare claims in 2024 for Dupixent, which needs prior auth on most New York plans that cover it.");
});
test("the published audit files hold labels, queues and cited pages for group practices only: no notes, no dashes", () => {
  eq(dashless("Saratoga Hospital Medical Group - Pulmonology"), "Saratoga Hospital Medical Group Pulmonology");
  eq(dashless("114-81 177TH PL"), "114 81 177TH PL");
  for (const f of ["docs/audit_dev.csv", "docs/audit_heldout.csv"]) {
    const [head, ...rows] = readFileSync(root(f), "utf8").trim().split(/\r?\n/);
    eq(head, "sample,practice,site,queue_when_sampled,queue_by_rules_today,queue_after_audit_corrections,label,how_decided,confidence,source_1,source_2,source_3");
    ok(rows.length > 0, `${f} is empty`);
    const t = rows.join("\n");
    ok(!/billing alone|npi:\d/i.test(t), `${f} has a row for a prescriber billing alone`);
    const urls = [...(t.match(/"https?:\/\/[^"]*"/g) ?? []), ...(t.replace(/"https?:\/\/[^"]*"/g, "").match(/https?:\/\/[^,\s]+/g) ?? [])];
    ok(!urls.some((u) => PRIVATE_URL.test(u)), `${f} cites a property, registry or obituary page`);
    const prose = [...urls].sort((x, y) => y.length - x.length).reduce((s, u) => s.split(u).join(""), t);
    ok(!/[‐-―−-]/.test(prose), `${f} prints a dash outside a URL`);
  }
});
test("an attached PA with no Medicare rows never decides the account's phone check", () => {
  const inp = fixture();
  inp.partd.push(partd("3000000002", 999));
  inp.nppes["3000000002"] = nppes("3000000002", { phone: "7183332222" });
  const p = build(inp).practices.find((x) => x.key === "org:111")!;
  ok(p.prescribers.some((r) => r.npi === "3000000002"), "the PA joined the group");
  eq(p.prescribers[0].npi, "3000000002", "the PA has the most claims");
  eq(p.phoneCheck, "agree");
  eq(p.medicareListed, "7183332222", "compared against the group's own Medicare listing at the site");
});
test("the phone check compares against the account's own group listing first, not another group's line at the site", () => {
  const inp = fixture();
  inp.dac = inp.dac.map((r) => (r.npi === "1000000001" ? { ...r, phone: "7184445555" } : r));
  inp.dac.push(dac("1000000001", { facility: "OTHER GROUP PC", orgPac: "999", orgMembers: 200, phone: "7183332222" }));
  const p = build(inp).practices.find((x) => x.key === "org:111")!;
  eq(p.judgeNpi, "1000000001");
  eq(p.phoneCheck, "differ", "own group lists 718 444 5555 while the registry says 718 333 2222");
});
test("a corruption shadowed by the same number with an extension is a miss, not a catch", () => {
  const inp = fixture();
  // the group lists its line twice at the site, once with an extension run into the digits
  inp.dac.push(dac("1000000001", { facility: "BROOKLYN SKIN PC", orgPac: "111", orgMembers: 4, phone: "718333222201" }));
  const ev = runEval(inp);
  eq(ev.cleanPractices, 1);
  eq(ev.recall, 0, "every corruption of the clean row reads as the extension row: nothing a rep would see");
  eq(ev.falseFlags, 0);
});
test("reformatted numbers are a control: they must still read as agreeing", () => {
  const r = rng(3);
  for (let i = 0; i < 50; i++) eq(comparePhones("7182837732", inject("7182837732", "reformat", r)), "agree");
  ok(CONTROLS.has("reformat") && CONTROLS.has("none"), "both controls");
});
test("suites are told apart: #802 is a suite, and FLOOR 7 is not FLOOR 2", () => {
  const inp = reviewFixture();
  inp.hrsa!.push({ name: "Tower", addr: "50 W 40th St Floor 2", city: "New York", zip: "10018", org: "SOME HEALTH CENTER" });
  inp.partd.push(partd("3000000003", 30), partd("3000000004", 30));
  inp.nppes["3000000003"] = nppes("3000000003", { addr: "50 W 40TH ST FLOOR 7", zip: "100180000", phone: "2125553300" });
  inp.nppes["3000000004"] = nppes("3000000004", { addr: "50 W 40TH ST #802", zip: "100180000", phone: "2125553400" });
  inp.dac.push(dac("3000000003", { addr: "50 W 40TH ST FLOOR 7", zip: "10018", phone: "2125553300" }));
  inp.dac.push(dac("3000000004", { addr: "50 W 40TH ST #802", zip: "10018", phone: "2125553400" }));
  const run = build(inp);
  eq(run.practices.find((p) => p.key === "npi:3000000003")!.segment, "independent", "floor 7");
  eq(run.practices.find((p) => p.key === "npi:3000000004")!.segment, "independent", "#802");
});
test("the eval counts a catch only when a rep would see a disagreement", () => {
  ok(!SURFACED.has("agree") && !SURFACED.has("extension"), "agree and extension are misses");
  ok(SURFACED.has("swap") && SURFACED.has("malformed"), "disagreements are catches");
});

// ---------------------------------------------------------------- export
test("CSV cells are quoted when needed and formula starts are defused", () => {
  eq(cell("a,b"), '"a,b"');
  eq(cell('say "hi"'), '"say ""hi"""');
  eq(cell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  eq(cell("+1 718"), "'+1 718");
  eq(cell(null), "");
});
test("HubSpot rows line up with their headers; contacts carry the practice id that associates them", () => {
  const c = companyRows(fx.practices), k = contactRows(fx.practices);
  ok(c.every((r) => r.length === COMPANY_HEADER.length), "company row width");
  ok(k.every((r) => r.length === CONTACT_HEADER.length), "contact row width");
  const pid = CONTACT_HEADER.indexOf("priormap practice id");
  ok(k.every((r) => fx.practices.some((p) => p.key === r[pid])), "every contact points at a company");
  eq(k.length, fx.practices.reduce((s, p) => s + p.prescribers.length, 0));
  ok(csv(["a"], [["x"]]).endsWith("\r\n"), "CRLF line ends");
});

// ---------------------------------------------------------------- eval
test("injections produce the corruption they name", () => {
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    for (const k of Object.keys(EXPECT) as Injection[]) eq(comparePhones("7182837732", inject("7182837732", k, r)), EXPECT[k], k);
  }
});
test("the generator is deterministic", () => {
  const a = rng(1), b = rng(1);
  eq([a(), a(), a()], [b(), b(), b()]);
});
test("end to end eval on the fixture: every injected corruption is caught, nothing clean is flagged", () => {
  const ev = runEval(fixture());
  eq(ev.cleanPractices, 1);
  eq(ev.falseFlags, 0);
  eq(ev.recall, 1);
});

// ---------------------------------------------------------------- the committed snapshot
if (existsSync(root("data/partd_ny.json")) && existsSync(root("data/nppes.json")) && existsSync(root("data/dac.json"))) {
  const inp = loadInputs(root("data"));
  const run = build(inp);
  test("real data: every account has a territory, a queue and claims that add up", () => {
    ok(run.practices.every((p) => p.territory && QUEUE[p.segment] && p.claims > 0), "account missing a field");
    const fromPrescribers = run.practices.reduce((s, p) => s + p.prescribers.reduce((a, r) => a + r.claims, 0), 0);
    eq(run.practices.reduce((s, p) => s + p.claims, 0), fromPrescribers);
  });
  test("real data: each prescriber is in exactly one account or skipped, never both", () => {
    const seen = new Map<string, number>();
    for (const p of run.practices) for (const r of p.prescribers) seen.set(r.npi, (seen.get(r.npi) ?? 0) + 1);
    ok([...seen.values()].every((n) => n === 1), "a prescriber sits in two accounts");
    ok(!run.skipped.some((s) => seen.has(s.npi)), "a skipped prescriber is also in an account");
  });
  test("real data: every prescriber with a kept drug is counted once, in an account or skipped", () => {
    eq(run.withKeptDrugs, run.inAccounts + run.skipped.length);
    eq(new Set(run.skipped.map((s) => s.npi)).size, run.skipped.length, "a prescriber skipped twice");
  });
  test("real data: every kept drug needs PA on at least half the New York plans that list it", () => {
    ok(run.gate.kept.every((d) => d.pa.rate >= 0.5 && d.pa.plansCovering > 0), "a weak drug passed the gate");
  });
  test("real data: a second phone only appears when the two directories list the same site and disagree", () => {
    ok(run.practices.every((p) => !p.altPhone || !["agree", "no_shared_site", "no_medicare_row"].includes(p.phoneCheck)), "second phone without a disagreement");
  });
  test("real data: summary and card agree with the run", () => {
    const s = summarize(inp, run, { cleanPractices: 0, perKind: {} as never, falseFlags: 0, recall: 0 });
    eq(s.funnel.accounts, run.practices.length);
    eq(s.card.accounts, run.practices.length);
    eq(Object.values(s.segments).reduce((a, x) => a + x.accounts, 0), run.practices.length);
  });
  test("real data: the phone eval catches at least 99% of injected corruptions and flags no clean account", () => {
    const ev = runEval(inp);
    ok(ev.recall >= 0.99, `recall ${ev.recall}`);
    eq(ev.falseFlags, 0, "clean accounts flagged");
  });
  test("every number the README quotes matches a fresh run", () => {
    const readme = readFileSync(root("README.md"), "utf8");
    const s = summarize(inp, run, runEval(inp));
    const n = (x: number) => x.toLocaleString("en-US");
    const seg = s.segments;
    const ev = s.eval;
    const injected = Object.entries(ev.perKind).filter(([k]) => !CONTROLS.has(k as Injection));
    const P = s.phone.counts;
    const R = s.funnel.skipReasons;
    for (const claim of [
      `${n(s.funnel.prescribersInPartD)} New York prescribers in Part D for the ${DRUGS.length} drugs`,
      `${n(s.funnel.prescribersWithKeptDrugs)} for the ${s.drugs.kept.length} that count`,
      `${n(s.funnel.prescribers)} in accounts; ${n(s.funnel.skipped)} skipped: ${R["moved: Medicare lists them only outside New York"]} moved (Medicare lists them only outside New York), ${R["practice location outside New York"]} practice outside`,
      `New York per the registry, ${R["a resident or fellow in training (Part D specialty)"]} residents or fellows, ${R["not a practice a BDR can sell to"]} not a practice, ${R["audited: not a practice, or moved"]} audited out, ${R["not found in the NPI registry"]} not in the registry`,
      `in [audit/labels.json](audit/labels.json): ${run.audited} accounts`,
      `${n(s.funnel.accounts)} accounts, holding ${n(s.funnel.claims)} Medicare claims in 2024`,
      `need prior auth on ${s.drugs.minPaRate}% to 100% of the New York Medicare plans that cover them (${s.drugs.nyPlans} plans`,
      `| BDR | ${n(seg.independent.accounts)} | ${n(seg.independent.prescribers)} | ${n(seg.independent.claims)} |`,
      `| Research: verify first | ${n(seg.unverified.accounts)} | ${n(seg.unverified.prescribers)} | ${n(seg.unverified.claims)} |`,
      `| AE: multi site group | ${n(seg.large_group.accounts)} | ${n(seg.large_group.prescribers)} | ${n(seg.large_group.claims)} |`,
      `| Enterprise: health system | ${n(seg.enterprise.accounts)} | ${n(seg.enterprise.prescribers)} | ${n(seg.enterprise.claims)} |`,
      `| Account manager: expansion | ${n(seg.forus_customer.accounts)} |`,
      `The ${n(seg.independent.accounts)} BDR accounts split ${n(s.independents.regions["New York City"].accounts)} New York City, ${n(s.independents.regions["Upstate"].accounts)} upstate, ${n(s.independents.regions["Long Island"].accounts)} Long Island, ${n(s.independents.regions["Hudson Valley"].accounts)} Hudson Valley`,
      `(${n(s.independents.tierA)} BDR accounts)`,
      `${n(s.independents.dialReady)} of the tier A accounts have a phone both directories agree on`,
      `Queens hyphens folded): ${n(s.phone.comparable)} accounts.`,
      `They disagree at ${n(s.phone.disagree)} (${s.phone.disagreePct}%), ${n(s.phone.bdrDisagree)} of them in the BDR queue: ${P.differ} different numbers, ${P.same_exchange} another line on the same exchange, ${P.swap ?? 0} with two digits swapped, ${P.one_digit} one digit apart, ${P.malformed ?? 0} malformed`,
      `Another ${s.phone.extension} Medicare listings run an extension into the phone digits`,
      `takes the ${n(ev.cleanPractices)} accounts where the two directories agree`,
      `${n(injected.reduce((a, [, v]) => a + v.n, 0))} corruptions, of which ${n(injected.reduce((a, [, v]) => a + v.caught, 0))} surface as a disagreement a rep would see`,
      `Alongside them run ${n([...CONTROLS].reduce((a, k) => a + ev.perKind[k].n, 0))} controls`,
      `${ev.falseFlags} were flagged`,
      `"${s.card.firstLine!.line}"`,
    ]) ok(readme.includes(claim), `README is missing or out of date: "${claim}"`);
  });
  if (existsSync(root("docs/audit_heldout.json")) && existsSync(root("docs/audit_dev.json"))) test("the README's accuracy numbers match the committed audit files", () => {
    const readme = readFileSync(root("README.md"), "utf8");
    const h = JSON.parse(readFileSync(root("docs/audit_heldout.json"), "utf8"));
    const d = JSON.parse(readFileSync(root("docs/audit_dev.json"), "utf8"));
    const p = (x: number) => `${(x * 100).toFixed(1)}%`;
    const H = h.bdrAtAudit, D = d.bdrAtAudit, A = d.bdrNow, L = d.leftBdr, G = h.bdrAtAuditGroups, S = h.bdrAtAuditSolos;
    for (const claim of [
      `**${H.ok} of ${H.n} held out BDR accounts are independent practices a BDR can sell to: ${p(H.ok / H.n)} (95% interval ${p(H.low)} to ${p(H.high)}).**`,
      `As first routed, ${D.ok} of ${D.n} BDR accounts in it were sellable (${p(D.ok / D.n)})`,
      `took ${L.n} of them out of the BDR queue, ${L.n - L.ok} of them misses, and the ${A.n} left scored ${A.ok} of ${A.n} (${p(A.ok / A.n)})`,
      `including the 30 largest BDR accounts (${d.bdr_top.ok} of those ${d.bdr_top.n} were sellable)`,
      `The ${G.n} group practices in the held out sample scored ${G.ok} of ${G.n} (${p(G.ok / G.n)})`,
      `The ${S.n} prescribers who bill alone scored ${S.ok} of ${S.n}; they are published only as counts by label`,
      `Of the ${H.ok}, ${H.sellable.independent_specialty} are specialty practices and ${H.sellable.independent_primary_or_multispecialty} are primary care or multispecialty practices`,
      `weighted by claims, ${p(H.claims.ok / H.claims.n)} of the sampled claims are at sellable accounts`,
    ]) ok(readme.includes(claim), `README is missing or out of date: "${claim}"`);
    // the audit file and the CSV agree: every held out row is in the CSV
    const csvRows = readFileSync(root("docs/audit_heldout.csv"), "utf8").trim().split(/\r?\n/).length - 1;
    eq(csvRows, h.groupsWithSources.groups, "one row per group practice");
  });
  if (existsSync(root("app/card.json"))) test("the committed card matches a fresh run", () => {
    const card = JSON.parse(readFileSync(root("app/card.json"), "utf8"));
    eq(card.accounts, run.practices.length);
    eq(card.claims, run.practices.reduce((s, p) => s + p.claims, 0));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
