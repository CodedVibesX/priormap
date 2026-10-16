// Shape of app/card.json (written by `npm start`) and the small helpers the page needs.
import raw from "./card.json";

export type Segment = "independent" | "unverified" | "large_group" | "enterprise" | "forus_customer";
export interface PhoneExample {
  practice: string; rank: number; queue: string; area: string; check: string; label: string;
  medicare: string; registry: string; site: string; registryUpdated: string;
}
export interface AuditScore { ok: number; n: number; unclear: number; low: number; high: number; misses: Record<string, number>; sellable?: Record<string, number>; claims?: { ok: number; n: number } }
export interface Card {
  asOf: string;
  nyPlans: number;
  drugCount: number;
  minPaRate: number;
  drugs: { brand: string; paRate: number; claims: number }[];
  prescribers: number;
  accounts: number;
  claims: number;
  segments: { segment: Segment; queue: string; accounts: number; prescribers: number; claims: number }[];
  independents: { accounts: number; claimsShare: number; solo: number; tierA: number; dialReady: number; regions: Record<string, { accounts: number; claims: number }> };
  firstLine: { practice: string; line: string } | null;
  top: { name: string; area: string; region: string; claims: number; prescribers: number; tier: string; drugs: string[]; phone: string }[];
  customers: { customer: string; source: string; area: string }[];
  phone: {
    comparable: number; disagree: number; disagreePct: number; typoLike: number; extension: number; bdrDisagree: number;
    counts: Record<string, number>; hero: PhoneExample | null; examples: PhoneExample[]; extensionExample: PhoneExample | null;
  };
  eval: { recall: number; falseFlags: number; clean: number; injected: number; exact: number; caught: number; controls: number };
  map: { segments: Segment[]; zips: [number, number][]; accounts: [number, number, number, number][]; unmapped: number };
  accuracy: {
    heldout: AuditScore;
    groups: AuditScore | null;
    solos: AuditScore | null;
    heldoutTotal: number;
    tiebreaks: number;
    corrected: number;
    dev: { before: AuditScore; after: AuditScore; removed: AuditScore; top: AuditScore | null; ae: AuditScore | null } | null;
  } | null;
}

export const card = raw as unknown as Card;
export const fmt = (n: number) => n.toLocaleString("en-US");
/** Names come from federal files and some carry hyphens; the page shows them with spaces. */
export const show = (s: string) => s.replace(/\s*[-‐-―]\s*/g, " ").replace(/\s+/g, " ").trim();
export const seg = (s: Segment) => card.segments.find((x) => x.segment === s)!;
