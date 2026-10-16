// Writes what a growth team uses: a HubSpot import (companies plus contacts, associated by practice id), BigQuery
// ready CSVs, the phone check audit, and every skipped prescriber with its reason.
import fs from "node:fs";
import path from "node:path";
import { QUEUE, type Practice, type Run } from "./engine.ts";
import { DRUGS } from "./drugs.ts";
import { PHONE_LABEL, digits10, formatPhone, type PhoneCheck } from "./phone.ts";

const brand = (stem: string) => DRUGS.find((d) => d.stem === stem)?.brand ?? stem;

/** Quotes a CSV cell, and defuses values a spreadsheet would run as a formula. */
export function cell(v: unknown): string {
  let s = v === undefined || v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export const phoneLabel = (c: PhoneCheck | "no_medicare_row") => (c === "no_medicare_row" ? "not in Medicare's clinician file" : PHONE_LABEL[c]);
const topDrugs = (p: Practice, n = 3) => p.drugs.slice(0, n).map(([s, c]) => `${brand(s)} ${c}`).join("; ");
const place = (p: Practice) => `${p.territory.region}: ${p.territory.area}`;

export const COMPANY_HEADER = [
  "Company name", "Phone Number", "Street Address", "City", "State/Region", "Postal Code", "Country/Region", "Industry", "Lifecycle Stage",
  "priormap practice id", "priormap queue", "priormap segment reason", "priormap territory", "priormap rank", "priormap tier",
  "priormap pa claims 2024", "priormap prescribers", "priormap medicare group size", "priormap top drugs", "priormap specialties",
  "priormap phone check", "priormap second phone", "priormap fax", "priormap forus story", "priormap talking point",
];

export function companyRows(ps: Practice[]) {
  return ps.map((p) => [
    p.name, formatPhone(p.phone), p.site.addr, p.site.city, "NY", p.site.zip.slice(0, 5), "United States", "Medical Practice", "lead",
    p.key, QUEUE[p.segment], p.segmentWhy, place(p), p.rank, p.tier,
    p.claims, p.prescribers.length, p.orgMembers || "", topDrugs(p), p.specialties.join("; "),
    phoneLabel(p.phoneCheck), p.altPhone ? formatPhone(p.altPhone) : "", p.fax ? formatPhone(p.fax) : "", p.customer?.source ?? "", p.talkingPoint,
  ]);
}

export const CONTACT_HEADER = [
  "First Name", "Last Name", "Job Title", "Phone Number", "City", "State/Region", "Postal Code", "Lifecycle Stage", "Lead Status",
  "priormap npi", "priormap practice id", "priormap pa claims 2024", "priormap drugs",
];

export function contactRows(ps: Practice[]) {
  return ps.flatMap((p) =>
    p.prescribers.map((r) => [
      titleWord(r.first), titleWord(r.last), [r.specialty, r.credential.replace(/\./g, "")].filter(Boolean).join(", "),
      formatPhone(p.phone), p.site.city, "NY", p.site.zip.slice(0, 5), "lead", "NEW",
      r.npi, p.key, r.claims, [...r.drugs].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${brand(s)} ${c}`).join("; "),
    ]),
  );
}

const titleWord = (s: string) => s.toLowerCase().replace(/(^|[\s'])([a-z])/g, (_, a, b) => a + b.toUpperCase());

export function writeAll(run: Run, out = path.resolve("leads")) {
  fs.mkdirSync(out, { recursive: true });
  const w = (f: string, s: string) => fs.writeFileSync(path.join(out, f), s);
  const { practices } = run;
  w("hubspot_companies.csv", csv(COMPANY_HEADER, companyRows(practices)));
  w("hubspot_contacts.csv", csv(CONTACT_HEADER, contactRows(practices)));
  // a committed sample for readers who do not run the code: the top of the BDR queue, as HubSpot would import it
  fs.mkdirSync(path.resolve("docs"), { recursive: true });
  fs.writeFileSync(path.resolve("docs/sample_hubspot_companies.csv"), csv(COMPANY_HEADER, companyRows(practices.filter((p) => p.segment === "independent").slice(0, 25))));
  // BigQuery: snake_case headers, plain numbers, one row per practice and per prescriber
  w("practices.csv", csv(
    ["practice_id", "name", "queue", "segment", "rank", "queue_rank", "tier", "region", "area", "street", "city", "zip", "phone", "second_phone", "phone_check", "pa_claims_2024", "drug_cost_2024", "prescribers", "medicare_group_size", "top_drug", "areas"],
    practices.map((p) => [p.key, p.name, QUEUE[p.segment], p.segment, p.rank, p.queueRank, p.tier, p.territory.region, p.territory.area, p.site.addr, p.site.city, p.site.zip.slice(0, 5), p.phone, p.altPhone, p.phoneCheck, p.claims, Math.round(p.cost), p.prescribers.length, p.orgMembers, p.drugs[0]?.[0] ?? "", p.areas.join(";")]),
  ));
  w("prescribers.csv", csv(
    ["npi", "practice_id", "first_name", "last_name", "credential", "specialty", "pa_claims_2024", "drug_cost_2024", "drugs", "registry_phone", "registry_address", "registry_zip", "registry_updated", "phone_check"],
    practices.flatMap((p) => p.prescribers.map((r) => [r.npi, p.key, r.first, r.last, r.credential, r.specialty, r.claims, Math.round(r.cost), [...r.drugs.keys()].join(";"), r.nppes.loc.phone, r.nppes.loc.addr, r.nppes.loc.zip.slice(0, 5), r.nppes.updated, r.phoneCheck])),
  ));
  w("phone_check.csv", csv(
    ["practice_id", "practice", "rank", "check", "medicare_phone", "registry_phone", "site", "zip", "registry_updated"],
    practices.filter((p) => p.altPhone || p.phoneCheck === "malformed").map((p) => {
      const judge = p.prescribers.find((r) => r.npi === p.judgeNpi) ?? p.prescribers[0];
      return [p.key, p.name, p.rank, phoneLabel(p.phoneCheck), p.medicareListed, digits10(judge.nppes.loc.phone), p.site.addr, p.site.zip.slice(0, 5), judge.nppes.updated];
    }),
  ));
  w("skipped.csv", csv(["npi", "name", "pa_claims_2024", "reason"], run.skipped.map((s) => [s.npi, s.name, s.claims, s.reason])));
}
