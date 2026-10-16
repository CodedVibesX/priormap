// New York sales territories by county, grouped the way the state groups them: the ten Regional Economic Development
// Council regions (https://regionalcouncils.ny.gov). A ZIP's county comes from the Census ZCTA to county file (the county
// holding most of the ZIP's land); a ZIP the Census file does not know (a PO box or a single building) falls back to its
// three digit prefix.

export interface Territory { region: string; area: string }

const BOROUGH: Record<string, string> = { "36061": "Manhattan", "36005": "Bronx", "36047": "Brooklyn", "36081": "Queens", "36085": "Staten Island" };

// county FIPS to council region
const COUNCIL: Record<string, string[]> = {
  "Long Island": ["36059", "36103"],
  "Mid Hudson": ["36119", "36087", "36071", "36079", "36027", "36111", "36105"],
  "Capital Region": ["36001", "36021", "36039", "36083", "36091", "36093", "36113", "36115"],
  "Mohawk Valley": ["36035", "36043", "36057", "36065", "36077", "36095"],
  "North Country": ["36019", "36031", "36033", "36041", "36045", "36049", "36089"],
  "Central New York": ["36011", "36023", "36053", "36067", "36075"],
  "Southern Tier": ["36007", "36015", "36017", "36025", "36097", "36101", "36107", "36109"],
  "Finger Lakes": ["36037", "36051", "36055", "36069", "36073", "36099", "36117", "36121", "36123"],
  "Western New York": ["36003", "36009", "36013", "36029", "36063"],
};
const COUNCIL_OF = new Map(Object.entries(COUNCIL).flatMap(([r, fs]) => fs.map((f) => [f, r] as const)));

/** The sales region: New York City, Long Island and the Hudson Valley stand alone; the other seven councils are upstate. */
export function territoryOfCounty(fips: string, countyName = ""): Territory | null {
  if (BOROUGH[fips]) return { region: "New York City", area: BOROUGH[fips] };
  const council = COUNCIL_OF.get(fips);
  if (!council) return null;
  const county = countyName.replace(/ County$/, "");
  if (council === "Long Island") return { region: "Long Island", area: county || council };
  if (council === "Mid Hudson") return { region: "Hudson Valley", area: county || council };
  return { region: "Upstate", area: council };
}

const NYC_ZIP3: Record<string, string> = {
  "100": "Manhattan", "101": "Manhattan", "102": "Manhattan",
  "103": "Staten Island", "104": "Bronx", "112": "Brooklyn",
  "111": "Queens", "113": "Queens", "114": "Queens", "116": "Queens",
};

/** The prefix fallback: borough lines follow USPS prefixes closely but not exactly at the Queens and Nassau edge. */
export function territoryOfZip3(zip: string): Territory | null {
  const z3 = zip.slice(0, 3);
  if (!/^\d{3}$/.test(z3)) return null;
  if (NYC_ZIP3[z3]) return { region: "New York City", area: NYC_ZIP3[z3] };
  const n = Number(z3);
  if (n === 110 || n === 115 || n === 118) return { region: "Long Island", area: "Nassau" };
  if (n === 117 || n === 119) return { region: "Long Island", area: "Suffolk" };
  if (n >= 105 && n <= 109) return { region: "Hudson Valley", area: n <= 108 ? "Westchester" : "Mid Hudson" };
  if (n >= 124 && n <= 127) return { region: "Hudson Valley", area: "Mid Hudson" };
  if ((n >= 120 && n <= 123) || n === 128 || n === 129) return { region: "Upstate", area: "Capital Region" };
  if (n >= 130 && n <= 139) return { region: "Upstate", area: "Central New York" };
  if (n >= 140 && n <= 149) return { region: "Upstate", area: "Western New York" };
  return null;
}

export interface CountyMap { zips: Record<string, string>; names: Record<string, string> }

export function territory(zip: string, counties?: CountyMap): Territory | null {
  const fips = counties?.zips[zip.slice(0, 5)];
  if (fips) return territoryOfCounty(fips, counties!.names[fips]);
  return territoryOfZip3(zip);
}
