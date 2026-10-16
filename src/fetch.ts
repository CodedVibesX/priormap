// `npm run fetch`: refreshes every input from public federal sources. Read only GETs, no keys.
// Raw bulk files land in data/raw (git ignored); the trimmed snapshots the engine reads are committed in data/.
import fs from "node:fs";
import path from "node:path";
import { getJSON, pool, remoteZipMember, unzip } from "./http.ts";
import { DRUGS } from "./drugs.ts";
import { nyPlans, paRates, rxcuiStems } from "./formulary.ts";
import { csvObjects } from "./csv.ts";

export const SOURCES = {
  partd: {
    name: "Medicare Part D Prescribers by Provider and Drug, data year 2024",
    // The 2024 version of the series 9552739e-3d05-4c1b-8eff-ecabf391e2e5, pinned so a rerun reads the same year.
    api: "https://data.cms.gov/data-api/v1/dataset/d5aa71a8-dcc0-4570-8bcf-bd39deac69fe/data",
    page: "https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/medicare-part-d-prescribers-by-provider-and-drug",
  },
  formulary: {
    name: "Medicare Prescription Drug Plan Formulary, Pharmacy Network and Pricing Information, September 2026 monthly release",
    zip: "https://data.cms.gov/sites/default/files/2026-09/903ba816-d276-4c17-9b5a-0224bbd4e949/2026_20260916.zip",
    page: "https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information",
  },
  rxnorm: { name: "RxNorm (NLM RxNav API)", api: "https://rxnav.nlm.nih.gov/REST/allconcepts.json?tty=SCD+SBD+GPCK+BPCK" },
  nppes: { name: "NPPES NPI Registry API v2.1", api: "https://npiregistry.cms.hhs.gov/api/?version=2.1&number=" },
  zcta: {
    name: "Census 2024 Gazetteer, ZIP Code Tabulation Areas (internal points)",
    zip: "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip",
  },
  county: {
    name: "Census 2020 ZCTA to County Relationship File",
    file: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
  },
  hrsa: {
    name: "HRSA Health Center Service Delivery and Look Alike Sites",
    file: "https://data.hrsa.gov/DataDownload/DD_Files/Health_Center_Service_Delivery_and_LookAlike_Sites.csv",
  },
  dac: {
    name: "Medicare Doctors and Clinicians National Downloadable File (mj5m-pzi6)",
    api: "https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0",
    meta: "https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/mj5m-pzi6",
    page: "https://data.cms.gov/provider-data/dataset/mj5m-pzi6",
  },
};

export const DATA = path.resolve("data");
const RAW = path.join(DATA, "raw");
const today = () => new Date().toISOString().slice(0, 10);
const write = (f: string, v: unknown) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 0) + "\n");

export const PARTD_COLS = ["npi", "last", "first", "city", "type", "brand", "generic", "claims", "fills30", "cost"] as const;

async function fetchFormulary(state: string) {
  fs.mkdirSync(RAW, { recursive: true });
  const member = async (prefix: string) => {
    const { bytes } = await remoteZipMember(SOURCES.formulary.zip, (n) => n.toLowerCase().startsWith(prefix));
    const [[name, txt]] = [...unzip(bytes)];
    fs.writeFileSync(path.join(RAW, name.replace(/\s+/g, "_")), txt);
    return { name, text: txt.toString("latin1") };
  };
  const geo = await member("geographic locator");
  const stateName = state === "NY" ? "New York" : state;
  const geoLines = geo.text.split(/\r?\n/);
  const gh = geoLines[0].split("|");
  const iState = gh.indexOf("STATENAME"), iPdp = gh.indexOf("PDP_REGION_CODE");
  if (iState < 0 || iPdp < 0) throw new Error(`geographic locator columns changed: ${geoLines[0]}`);
  const geoRow = geoLines.find((l) => l.split("|")[iState] === stateName);
  if (!geoRow) throw new Error(`no PDP region for ${state}`);
  const pdpRegion = geoRow.split("|")[iPdp];
  if (!/^\d{2}$/.test(pdpRegion)) throw new Error(`unexpected PDP region "${pdpRegion}" for ${state}`);
  const plan = await member("plan information");
  const form = await member("basic drugs formulary file");
  const concepts = (await getJSON(SOURCES.rxnorm.api)).minConceptGroup.minConcept as { rxcui: string; name: string }[];
  const plans = nyPlans(plan.text, pdpRegion);
  const drugs = paRates(form.text, plans, rxcuiStems(concepts));
  write("formulary_ny.json", {
    source: SOURCES.formulary,
    files: [plan.name, form.name, geo.name],
    rxnorm: SOURCES.rxnorm.api,
    fetched: today(),
    state,
    pdpRegion,
    nyPlans: plans.size,
    nyFormularies: new Set(plans.values()).size,
    drugs,
  });
  console.log(`formulary: ${plans.size} ${state} plans on ${new Set(plans.values()).size} formularies`);
}

async function fetchPartD(state: string) {
  const rows: (string | number)[][] = [];
  const seen = new Set<string>();
  for (const d of DRUGS) {
    const stem = d.stem[0].toUpperCase() + d.stem.slice(1);
    for (let off = 0; ; off += 5000) {
      const url =
        `${SOURCES.partd.api}?filter[s][condition][path]=Prscrbr_State_Abrvtn&filter[s][condition][operator]=%3D&filter[s][condition][value]=${state}` +
        `&filter[g][condition][path]=Gnrc_Name&filter[g][condition][operator]=CONTAINS&filter[g][condition][value]=${stem}&size=5000&offset=${off}`;
      const page = await getJSON<any[]>(url);
      for (const r of page) {
        const key = `${r.Prscrbr_NPI}|${r.Brnd_Name}|${r.Gnrc_Name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push([r.Prscrbr_NPI, r.Prscrbr_Last_Org_Name, r.Prscrbr_First_Name, r.Prscrbr_City, r.Prscrbr_Type, r.Brnd_Name, r.Gnrc_Name,
          Number(r.Tot_Clms || 0), Number(r.Tot_30day_Fills || 0), Number(r.Tot_Drug_Cst || 0)]);
      }
      if (page.length < 5000) break;
    }
    console.log(`  part d ${d.stem}: ${rows.length} rows so far`);
  }
  write("partd_ny.json", { source: SOURCES.partd, year: 2024, state, fetched: today(), cols: PARTD_COLS, rows });
  console.log(`part d: ${rows.length} prescriber and drug rows, ${new Set(rows.map((r) => r[0])).size} prescribers`);
  return [...new Set(rows.map((r) => String(r[0])))];
}

export interface NppesRecord {
  npi: string;
  type: "NPI-1" | "NPI-2";
  name: string;
  credential: string;
  taxonomy: string;
  taxonomyCode: string;
  loc: { addr: string; city: string; state: string; zip: string; phone: string; fax: string };
  others: { addr: string; city: string; state: string; zip: string; phone: string }[];
  updated: string;
}

function trimNppes(npi: string, res: any): NppesRecord | null {
  if (!res) return null;
  const b = res.basic ?? {};
  const loc = (res.addresses ?? []).find((a: any) => a.address_purpose === "LOCATION") ?? {};
  const tax = (res.taxonomies ?? []).find((t: any) => t.primary) ?? res.taxonomies?.[0] ?? {};
  const addr = (a: any) => [a.address_1, a.address_2].filter(Boolean).join(" ");
  return {
    npi,
    type: res.enumeration_type,
    name: res.enumeration_type === "NPI-2" ? b.organization_name ?? "" : [b.first_name, b.last_name].filter(Boolean).join(" "),
    credential: b.credential ?? "",
    taxonomy: tax.desc ?? "",
    taxonomyCode: tax.code ?? "",
    loc: { addr: addr(loc), city: loc.city ?? "", state: loc.state ?? "", zip: loc.postal_code ?? "", phone: loc.telephone_number ?? "", fax: loc.fax_number ?? "" },
    others: (res.practiceLocations ?? []).map((p: any) => ({ addr: addr(p), city: p.city ?? "", state: p.state ?? "", zip: p.postal_code ?? "", phone: p.telephone_number ?? "" })),
    updated: b.last_updated ?? "",
  };
}

async function fetchNppes(npis: string[]) {
  let done = 0;
  const recs = await pool(npis, 4, async (npi) => {
    const j = await getJSON(SOURCES.nppes.api + npi);
    if (++done % 500 === 0) console.log(`  nppes ${done}/${npis.length}`);
    return trimNppes(npi, j.results?.[0]);
  }, 60);
  const records: Record<string, NppesRecord> = {};
  recs.forEach((r, i) => { if (r) records[npis[i]] = r; });
  write("nppes.json", { source: SOURCES.nppes, fetched: today(), records });
  console.log(`nppes: ${Object.keys(records).length} of ${npis.length} NPIs found`);
}

export const DAC_COLS = ["npi", "facility", "orgPac", "orgMembers", "addr", "city", "state", "zip", "phone", "spec"] as const;

async function fetchDac(npis: string[]) {
  const meta = await getJSON(SOURCES.dac.meta);
  const rows: (string | number)[][] = [];
  for (let i = 0; i < npis.length; i += 100) {
    const batch = npis.slice(i, i + 100);
    const qs = batch.map((n, k) => `conditions[0][value][${k}]=${n}`).join("&");
    for (let off = 0; ; off += 1500) {
      const j = await getJSON(`${SOURCES.dac.api}?conditions[0][property]=npi&conditions[0][operator]=in&${qs}&limit=1500&offset=${off}&schema=false&keys=true`);
      for (const r of j.results ?? [])
        rows.push([r.npi, r.facility_name, r.org_pac_id, Number(r.num_org_mem || 0), [r.adr_ln_1, r.adr_ln_2].filter(Boolean).join(" "), r.citytown, r.state, r.zip_code, r.telephone_number, r.pri_spec]);
      if ((j.results ?? []).length < 1500) break;
    }
  }
  write("dac.json", { source: SOURCES.dac, modified: meta.modified, released: meta.released, fetched: today(), cols: DAC_COLS, rows });
  console.log(`doctors and clinicians: ${rows.length} rows for ${new Set(rows.map((r) => r[0])).size} NPIs (modified ${meta.modified})`);
}

/** ZIP centroids for New York (ZIP prefixes 100 to 149), to place practices on the card's map. */
async function fetchZcta() {
  const r = await fetch(SOURCES.zcta.zip, { signal: AbortSignal.timeout(120_000) });
  const [[, txt]] = [...unzip(Buffer.from(await r.arrayBuffer()))];
  const points: Record<string, [number, number]> = {};
  for (const line of txt.toString("utf8").split(/\r?\n/).slice(1)) {
    const c = line.trim().split(/\t/);
    if (/^1[0-4]\d{3}$/.test(c[0])) points[c[0]] = [Number(c[5]), Number(c[6])];
  }
  write("zcta_ny.json", { source: SOURCES.zcta, fetched: today(), points });
  console.log(`zcta: ${Object.keys(points).length} New York ZIP centroids`);
}

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.text();
}

/** Each New York ZIP's county: the county holding the largest share of the ZIP's land, from the Census relationship file. */
async function fetchCounty(stateFips = "36") {
  const lines = (await getText(SOURCES.county.file)).replace(/^﻿/, "").split(/\r?\n/);
  const h = lines[0].split("|");
  const iZ = h.indexOf("GEOID_ZCTA5_20"), iC = h.indexOf("GEOID_COUNTY_20"), iN = h.indexOf("NAMELSAD_COUNTY_20"), iA = h.indexOf("AREALAND_PART");
  if ([iZ, iC, iN, iA].some((i) => i < 0)) throw new Error(`Census relationship file columns changed: ${lines[0]}`);
  const best: Record<string, [string, number]> = {};
  const names: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const c = line.split("|");
    if (!c[iZ] || !c[iC]?.startsWith(stateFips)) continue;
    names[c[iC]] = c[iN];
    const land = Number(c[iA]);
    if (!best[c[iZ]] || land > best[c[iZ]][1]) best[c[iZ]] = [c[iC], land];
  }
  const zips = Object.fromEntries(Object.entries(best).map(([z, [f]]) => [z, f]));
  // New York has 62 counties and about 1,800 ZIP areas: anything far off means the file changed, so keep the old snapshot
  if (Object.keys(names).length < 60 || Object.keys(zips).length < 1500) throw new Error(`county pull looks wrong (${Object.keys(names).length} counties, ${Object.keys(zips).length} ZIPs): snapshot not overwritten`);
  write("zip_county_ny.json", { source: SOURCES.county, fetched: today(), zips, names });
  console.log(`county: ${Object.keys(zips).length} New York ZIPs in ${Object.keys(names).length} counties`);
}

/** Active federally funded health center sites in New York: safety net clinics, a different sale from a private practice. */
async function fetchHrsa(state = "NY") {
  const rows = csvObjects(await getText(SOURCES.hrsa.file));
  const need = ["Site State Abbreviation", "Site Status Description", "Site Name", "Site Address", "Site City", "Site Postal Code", "Health Center Name"];
  const missing = need.filter((c) => !(c in (rows[0] ?? {})));
  if (missing.length) throw new Error(`HRSA file columns changed, missing: ${missing.join(", ")}: snapshot not overwritten`);
  const sites = rows
    .filter((r) => r["Site State Abbreviation"] === state && /active/i.test(r["Site Status Description"] ?? ""))
    .map((r) => ({ name: r["Site Name"], addr: r["Site Address"], city: r["Site City"], zip: (r["Site Postal Code"] ?? "").slice(0, 5), org: r["Health Center Name"] }));
  write("hrsa_ny.json", { source: SOURCES.hrsa, fetched: today(), sites });
  console.log(`hrsa: ${sites.length} active ${state} health center sites`);
}

export async function fetchAll(state = "NY", only?: string) {
  if (!only || only === "county") await fetchCounty();
  if (!only || only === "hrsa") await fetchHrsa(state);
  if (only === "county" || only === "hrsa") return;
  if (!only || only === "formulary") await fetchFormulary(state);
  if (!only || only === "zcta") await fetchZcta();
  if (only === "zcta") return;
  let npis: string[] | undefined;
  if (!only || only === "partd") npis = await fetchPartD(state);
  if (only === "formulary" || only === "partd") return;
  npis ??= [...new Set((JSON.parse(fs.readFileSync(path.join(DATA, "partd_ny.json"), "utf8")).rows as any[][]).map((r) => String(r[0])))];
  if (!only || only === "nppes") await fetchNppes(npis);
  if (!only || only === "dac") await fetchDac(npis);
}
