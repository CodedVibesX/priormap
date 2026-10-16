// Compares the phone two federal directories list for the same practice site: NPPES (the NPI registry) and Medicare's
// Doctors and Clinicians file. priormap never says which number is right, only whether the two agree, and how they differ.

export type PhoneCheck =
  | "agree" // same number at the same site
  | "extension" // the same number with an extension run into the digits ("5164664700110"): a dialer cannot use it
  | "swap" // two neighboring digits swapped: the classic typing slip
  | "one_digit" // one digit different: a typo, or two real lines one digit apart
  | "area_code" // same seven digits under a different area code
  | "same_exchange" // same area code and exchange, different line: often a department line versus the main line
  | "differ" // a different number
  | "malformed" // one directory's value is not a 10 digit US number
  | "one_missing" // one directory has no phone for the site
  | "no_shared_site"; // the directories list different addresses, so the phones are not comparable

export const PHONE_LABEL: Record<PhoneCheck, string> = {
  agree: "both directories agree",
  extension: "same number, extension run into the digits",
  swap: "two digits swapped",
  one_digit: "one digit apart",
  area_code: "same number, different area code",
  same_exchange: "same exchange, different line",
  differ: "the directories list different numbers",
  malformed: "one directory's number is malformed",
  one_missing: "one directory has no phone",
  no_shared_site: "directories list different sites",
};

/**
 * Ten digit US number, or "" when blank, or the raw digits prefixed "!" when malformed. A valid number follows the
 * North American plan: neither the area code nor the exchange starts with 0 or 1, so "(146) 178 9509" is malformed.
 */
export function digits10(p: string | undefined): string {
  const d = String(p ?? "").replace(/\D/g, "");
  if (!d) return "";
  const ten = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (ten.length === 10 && /^[2-9]\d\d[2-9]\d{6}$/.test(ten)) return ten;
  return "!" + d;
}

/** Area codes that ring in New York State (NANPA), overlays included. */
export const NY_AREA_CODES = new Set(["212", "315", "329", "332", "347", "363", "516", "518", "585", "607", "624", "631", "646", "680", "716", "718", "838", "845", "914", "917", "929", "934"]);
export const isNyNumber = (p: string) => NY_AREA_CODES.has(digits10(p).slice(0, 3));

export function comparePhones(a: string, b: string): Exclude<PhoneCheck, "no_shared_site"> {
  const x = digits10(a), y = digits10(b);
  if (!x || !y) return "one_missing";
  if (x.startsWith("!") || y.startsWith("!")) {
    const [bad, good] = x.startsWith("!") ? [x.slice(1), y] : [y.slice(1), x];
    if (!good.startsWith("!") && bad.length > 10 && (bad.startsWith(good) || bad.startsWith("1" + good))) return "extension";
    return "malformed";
  }
  if (x === y) return "agree";
  const diffs: number[] = [];
  for (let i = 0; i < 10; i++) if (x[i] !== y[i]) diffs.push(i);
  if (diffs.length === 1) return "one_digit";
  if (diffs.length === 2 && diffs[1] === diffs[0] + 1 && x[diffs[0]] === y[diffs[1]] && x[diffs[1]] === y[diffs[0]]) return "swap";
  if (x.slice(3) === y.slice(3)) return "area_code";
  if (x.slice(0, 6) === y.slice(0, 6)) return "same_exchange";
  return "differ";
}

// The street number. Queens numbers come many ways ("142-04 Bayside Ave", "142 - 04 Bayside Ave", "14204 Bayside Ave"),
// so the hyphen and any spaces around it are dropped.
const num = (s: string) => {
  const m = s.match(/^\s*(\d+)(?:\s*-\s*(\d+))?([A-Z]?)\b/i);
  return m ? (m[1] + (m[2] ?? "") + m[3]).toUpperCase() : "";
};

const ORDINAL_WORDS: Record<string, string> = { FIRST: "1", SECOND: "2", THIRD: "3", FOURTH: "4", FIFTH: "5", SIXTH: "6", SEVENTH: "7", EIGHTH: "8", NINTH: "9", TENTH: "10" };
const DIRECTIONS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"]);
/** The street's name, folded so two directories that write it differently agree: "E 98TH ST" and "East 98 Street" are 98. */
export function streetName(addr: string): string {
  const rest = addr.toUpperCase().replace(/^\s*\d+(?:\s*-\s*\d+)?[A-Z]?\b/, "").replace(/[.,]/g, " ");
  for (const raw of rest.split(/\s+/).filter(Boolean)) {
    if (DIRECTIONS.has(raw)) continue;
    const t = raw === "SAINT" ? "ST" : raw === "MOUNT" ? "MT" : raw;
    if (ORDINAL_WORDS[t]) return ORDINAL_WORDS[t];
    const ord = t.match(/^(\d+)(ST|ND|RD|TH)?$/);
    return ord ? ord[1] : t;
  }
  return "";
}

/** True when two directories place a clinician at the same site: same ZIP5 and the same street number. */
export function sameSite(a: { addr: string; zip: string }, b: { addr: string; zip: string }): boolean {
  const za = a.zip.slice(0, 5), zb = b.zip.slice(0, 5);
  const na = num(a.addr), nb = num(b.addr);
  return za.length === 5 && za === zb && na !== "" && na === nb;
}

/** A site as a key, "ZIP5|street number", or "" when either is missing: the same test as sameSite. */
export function siteKey(addr: string, zip: string): string {
  const z = zip.slice(0, 5), n = num(addr);
  return z.length === 5 && n ? `${z}|${n}` : "";
}

/** A stricter site key, "ZIP5|street number|street name", for claims about a building (a health center, a campus). */
export function buildingKey(addr: string, zip: string): string {
  const k = siteKey(addr, zip), s = streetName(addr);
  return k && s ? `${k}|${s}` : "";
}


export function formatPhone(p: string): string {
  const d = digits10(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)} ${d.slice(6)}` : p;
}
