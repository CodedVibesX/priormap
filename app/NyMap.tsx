// The hero: every New York ZIP as a faint dot, then every account lighting up in rank order, sized by its prior auth
// claims and colored by the queue it is routed to. New York City is too dense to read at state scale, so it gets an
// inset in the empty corner south of the Pennsylvania line. Pure SVG and CSS: no script runs.
import { card } from "./card";

const LAT_MAX = 45.05, LAT_MIN = 40.45, LON_MIN = -79.85, LON_MAX = -71.8;
const K = 139;
const COS = Math.cos((42.7 * Math.PI) / 180);
const W = Math.round((LON_MAX - LON_MIN) * COS * K);
const H = Math.round((LAT_MAX - LAT_MIN) * K);
const x = (lon: number) => (lon - LON_MIN) * COS * K;
const y = (lat: number) => (LAT_MAX - lat) * K;

// New York City inset, drawn into the box below
const NYC = { latMin: 40.49, latMax: 40.92, lonMin: -74.27, lonMax: -73.69 };
const BOX = { x: 14, y: 432, size: 206 };
const nycCos = Math.cos((40.7 * Math.PI) / 180);
const nycK = BOX.size / Math.max((NYC.lonMax - NYC.lonMin) * nycCos, NYC.latMax - NYC.latMin);
const ix = (lon: number) => BOX.x + (lon - NYC.lonMin) * nycCos * nycK;
const iy = (lat: number) => BOX.y + (NYC.latMax - lat) * nycK;
const inNyc = (la: number, lo: number) => la >= NYC.latMin && la <= NYC.latMax && lo >= NYC.lonMin && lo <= NYC.lonMax;

// keyed by segment name, never by position: the engine's segment order can change without recoloring the map
const CLASS_OF: Record<string, string> = { independent: "a-bdr", unverified: "a-research", large_group: "a-ae", enterprise: "a-ent", forus_customer: "a-cust" };
const CLS = card.map.segments.map((s) => CLASS_OF[s] ?? "a-ent");
const radius = (claims: number) => 1.1 + Math.sqrt(claims) / 20;
// Accounts in one ZIP would sit on top of each other; a small golden angle spiral spreads them.
const spread = (i: number, step: number) => {
  const a = i * 2.39996, r = step * Math.sqrt(i);
  return [Math.cos(a) * r, Math.sin(a) * r];
};

export function NyMap() {
  const { zips, accounts } = card.map;
  // rank order: accounts come sorted by claims, so the biggest light first
  const order = accounts.map((a, i) => ({ a, i }));
  const perZip = new Map<string, number>();
  const placed = order.map(({ a, i }) => {
    const key = `${a[0]},${a[1]}`;
    const n = perZip.get(key) ?? 0;
    perZip.set(key, n + 1);
    return { a, i, n };
  });
  const delay = (i: number) => `${(0.4 + (i / accounts.length) * 3.2).toFixed(2)}s`;
  const nycBox = { x0: x(NYC.lonMin), y0: y(NYC.latMax), x1: x(NYC.lonMax), y1: y(NYC.latMin) };
  return (
    <svg className="nymap" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Map of New York State with ${accounts.length.toLocaleString("en-US")} practices that prescribe prior auth drugs, colored by the queue each is routed to`}>
      <g className="zips">
        {zips.map(([la, lo], i) => <circle key={i} cx={x(lo).toFixed(1)} cy={y(la).toFixed(1)} r={1.3} />)}
      </g>
      <rect className="nyc-mark" x={nycBox.x0} y={nycBox.y0} width={nycBox.x1 - nycBox.x0} height={nycBox.y1 - nycBox.y0} rx={2} />
      <g>
        {[...placed].reverse().map(({ a: [la, lo, claims, s], i, n }) => {
          const [dx, dy] = spread(n, 1.2);
          return <circle key={i} className={`acct ${CLS[s]}`} style={{ animationDelay: delay(i) }}
            cx={(x(lo) + dx).toFixed(1)} cy={(y(la) + dy).toFixed(1)} r={radius(claims).toFixed(2)} />;
        })}
      </g>
      <g className="inset">
        <rect x={BOX.x - 6} y={BOX.y - 6} width={BOX.size + 12} height={BOX.size + 12} rx={4} className="inset-box" />
        {zips.filter(([la, lo]) => inNyc(la, lo)).map(([la, lo], i) => <circle key={i} className="izip" cx={ix(lo).toFixed(1)} cy={iy(la).toFixed(1)} r={1.6} />)}
        {[...placed].reverse().filter(({ a }) => inNyc(a[0], a[1])).map(({ a: [la, lo, claims, s], i, n }) => {
          const [dx, dy] = spread(n, 2.4);
          return <circle key={i} className={`acct ${CLS[s]}`} style={{ animationDelay: delay(i) }}
            cx={(ix(lo) + dx).toFixed(1)} cy={(iy(la) + dy).toFixed(1)} r={(radius(claims) * 1.25).toFixed(2)} />;
        })}
        <text x={BOX.x + 4} y={BOX.y + 14} className="inset-label">New York City</text>
      </g>
      <text x={x(-75.9)} y={y(44.2)} className="region">Upstate</text>
      <text x={x(-73.2)} y={y(40.62)} className="region">Long Island</text>
      <text x={x(-74.35)} y={y(41.65)} className="region">Hudson Valley</text>
    </svg>
  );
}
