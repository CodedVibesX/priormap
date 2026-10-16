import { card, fmt, show, seg } from "./card";
import { NyMap } from "./NyMap";

const REPO = "https://github.com/CodedVibesX/priormap";
const asOf = new Date(card.asOf + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const bdr = seg("independent"), research = seg("unverified"), ae = seg("large_group"), ent = seg("enterprise"), cust = seg("forus_customer");
const P = card.phone;
const maxDrug = Math.max(...card.drugs.map((d) => d.claims));
const pl = (n: number, w: string) => `${fmt(n)} ${w}${n === 1 ? "" : "s"}`;

const PHONE_PILL: Record<string, [string, string]> = {
  agree: ["agree", "ok"],
  extension: ["extension in digits", "warn"],
  swap: ["digits swapped", "bad"],
  one_digit: ["one digit apart", "bad"],
  area_code: ["area code differs", "bad"],
  same_exchange: ["other line", "warn"],
  differ: ["disagree", "warn"],
  malformed: ["malformed", "bad"],
  one_missing: ["one missing", "muted"],
  no_shared_site: ["different sites", "muted"],
  no_medicare_row: ["registry only", "muted"],
};

/** Two phone numbers with the differing digits marked, so the slip is visible at a glance. */
function Digits({ a, b }: { a: string; b: string }) {
  return (
    <span className="digits">
      {[...a].map((c, i) => <span key={i} className={/\d/.test(c) && c !== b[i] ? "diff" : undefined}>{c}</span>)}
    </span>
  );
}

const QUEUES_ALL = [
  { s: bdr, cls: "q-bdr", rule: "Independent practices: under 50 clinicians, no hospital, campus, health center or hospital switchboard behind them, and listed by Medicare in New York." },
  { s: research, cls: "q-research", rule: card.accuracy?.dev ? `Prescribers in no Medicare group and missing from Medicare's clinician file. In the tuning sample, ${card.accuracy.dev.removed.ok} of ${card.accuracy.dev.removed.n} like these were sellable independents: verify before a BDR calls.` : "Prescribers in no Medicare group and missing from Medicare's clinician file: verify before a BDR calls." },
  { s: ae, cls: "q-ae", rule: card.accuracy?.dev?.ae ? `Groups of 50 to 299 clinicians. Check ownership first: in the tuning sample, ${card.accuracy.dev.ae.misses.hospital_academic_or_system ?? 0} of ${card.accuracy.dev.ae.n} were hospital employed practices under their own names.` : "Groups of 50 to 299 clinicians: check ownership first." },
  { s: ent, cls: "q-ent", rule: "A hospital, academic, payer owned or safety net group: by name, by size (300 or more), by its prescribers also billing under one, by a campus or health center address, or by a hospital switchboard." },
  { s: cust, cls: "q-cust", rule: "Practices Forus names as customers, matched by group name or by a prescriber's NPI: expand, never cold call." },
];
// An empty expansion queue says nothing useful on a public card; the rule still runs and is tested.
const QUEUES = QUEUES_ALL.filter((q) => q.s.segment !== "forus_customer" || q.s.accounts > 0);

export default function Page() {
  return (
    <main>
      <header className="top">
        <div className="wrap top-in">
          <span className="mark">priormap</span>
          <span className="tag">A GTM Engineer work sample for Forus, built from public CMS data</span>
        </div>
      </header>

      <section className="hero">
        <div className="wrap hero-in">
          <div className="hero-copy">
            <div className="eyebrow">New York · Medicare claims 2024 · plans 2026</div>
            <h1>{fmt(bdr.accounts)} New York practices that look independent write the drugs that almost always need prior auth.</h1>
            <p className="lede">
              In 2024 they wrote {fmt(bdr.claims)} Medicare claims for {card.drugCount} drugs that need prior auth on at
              least {card.minPaRate}% of the New York Medicare drug plans that cover them. priormap builds the list from public
              CMS data, rolls prescribers up to practices, routes each to a queue and a territory, checks its phone, writes the
              HubSpot import, and measures how much of the list is real.
            </p>
            <div className="stats">
              <div><b>{fmt(card.prescribers)}</b><span>prescribers</span></div>
              <div><b>{fmt(card.accounts)}</b><span>accounts</span></div>
              {card.accuracy ? (
                <div><b>{Math.round((card.accuracy.heldout.ok / card.accuracy.heldout.n) * 100)}%</b><span>of BDR accounts sellable in a held out AI audit</span></div>
              ) : (
                <div><b>{bdr.accounts ? Math.round((bdr.claims / card.claims) * 100) : 0}%</b><span>of claims in the BDR queue</span></div>
              )}
              <div><b>{fmt(card.independents.dialReady)}</b><span>tier A accounts dial ready</span></div>
            </div>
            <div className="legend">
              <span><i className="a-bdr" />BDR</span><span><i className="a-research" />Verify first</span><span><i className="a-ae" />AE group</span><span><i className="a-ent" />Enterprise</span>{cust.accounts > 0 && <span><i className="a-cust" />Forus customer</span>}
              <span className="legend-note">dot size: prior auth claims</span>
            </div>
          </div>
          <div className="hero-map"><NyMap /></div>
        </div>
      </section>

      <section className="wrap block">
        <div className="eyebrow">Which drugs count</div>
        <h2>The drugs Forus names, kept only if CMS says they need prior auth</h2>
        <p>
          The list starts with the drugs Forus names on forus.com and its engineering blog in the specialties it serves
          (Dupixent, Rinvoq, Cimzia, Skyrizi, Humira, Nurtec, Ubrelvy) and adds the same class drugs in the specialties
          forus.com lists. A drug counts only when the CMS 2026 formulary files show
          prior auth on most of the New York plans that list it. All {card.drugCount} that count need it on {card.minPaRate}% or more.
          Five are on none of the {card.nyPlans} New York plans and are left out. So are Zepbound and Wegovy, which Forus also names: Medicare did not
          cover weight loss in 2024, so those claims are mostly diabetes prescriptions and would point at primary care.
        </p>
        <div className="drugs">
          {card.drugs.map((d) => (
            <div className="drug" key={d.brand}>
              <span className="drug-name">{d.brand}</span>
              <span className="drug-bar"><i style={{ width: `${(d.claims / maxDrug) * 100}%` }} /></span>
              <span className="drug-n">{fmt(d.claims)}</span>
              <span className="drug-pa">PA on {d.paRate}%</span>
            </div>
          ))}
        </div>
        <p className="note">Medicare claims in 2024 by the prescribers in these accounts, and the share of New York plans listing the drug that require prior auth for every version of it.</p>
      </section>

      <section className="wrap block">
        <div className="eyebrow">Routed</div>
        <h2>Every account routed, with its reason written on the record</h2>
        <div className="queues">
          {QUEUES.map(({ s, cls, rule }) => (
            <div className={`queue ${cls}`} key={s.segment}>
              <div className="queue-name">{s.queue}</div>
              <div className="queue-n">{fmt(s.accounts)}<span> {s.accounts === 1 ? "account" : "accounts"}</span></div>
              <div className="queue-c">{pl(s.claims, "claim")} · {pl(s.prescribers, "prescriber")}</div>
              <p>{rule}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap block">
        <div className="eyebrow">Top of the BDR queue</div>
        <h2>Where a BDR starts on day one</h2>
        <p className="note">The largest group practices in the queue. Prescribers who bill alone are in the HubSpot file, not named here.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>Practice</th><th>Area</th><th className="num">PA claims</th><th className="num">Prescribers</th><th>Top drugs</th><th>Phone</th></tr>
            </thead>
            <tbody>
              {card.top.map((t, i) => {
                const [label, tone] = PHONE_PILL[t.phone] ?? [t.phone, "muted"];
                return (
                  <tr key={t.name}>
                    <td className="rank">{i + 1}</td>
                    <td className="name">{show(t.name)}</td>
                    <td>{t.area}</td>
                    <td className="num">{fmt(t.claims)}</td>
                    <td className="num">{t.prescribers}</td>
                    <td className="drugs-cell">{t.drugs.join(", ")}</td>
                    <td><span className={`pill ${tone}`}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {card.firstLine && (
          <div className="first-line">
            <span>Talking point on the #1 record, built only from its own numbers</span>
            <p>&ldquo;{card.firstLine.line}&rdquo;</p>
          </div>
        )}
        <p className="note">
          {fmt(card.independents.tierA)} tier A accounts hold half the BDR queue&apos;s claims, and{" "}
          {fmt(card.independents.dialReady)} of them have a phone both directories agree on: dial ready on day one. {fmt(card.independents.solo)} of
          the {fmt(bdr.accounts)} are a prescriber billing alone. Every account in the HubSpot file carries its rank, tier,
          territory, top drugs and the reason for its queue.
        </p>
      </section>

      {card.accuracy && (() => {
        const A = card.accuracy, h = A.heldout, G = A.groups, S = A.solos, pc = (x: number) => `${Math.round(x * 100)}%`;
        const MISS: Record<string, string> = {
          hospital_academic_or_system: "hospital or academic", closed_or_moved: "moved or closed", not_a_practice: "not a practice",
          payer_or_corporate_owned: "corporate owned", safety_net_clinic: "safety net clinic", large_physician_group: "a 50 plus group",
        };
        const misses = Object.entries(h.misses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${MISS[k] ?? k}`).join(", ");
        return (
          <section className="wrap block">
            <div className="eyebrow">Measured, not claimed</div>
            <h2>How many BDR accounts are real, sellable practices</h2>
            <div className="acc">
              <div className="acc-n">{h.ok} of {h.n}<span>{pc(h.ok / h.n)}, 95% interval {pc(h.low)} to {pc(h.high)}</span></div>
              <div>
                <p>
                  {A.heldoutTotal} BDR accounts drawn at random from outside the tuning sample (which held the 30 largest
                  accounts), so none of them shaped the rules. Each was researched from public sources by one AI agent,
                  challenged by a second whose job was to refute it, and settled by a third where the two disagreed ({pl(A.tiebreaks, "time")}).
                  The researchers saw each account&apos;s queue and routing reason, and all three are the same model family:
                  an automated audit, not a blind or human one.
                  {h.unclear ? ` ${h.unclear} could not be settled and ${h.unclear === 1 ? "is" : "are"} left out of the count.` : ""} The misses: {misses || "none"}.
                </p>
                {G && S && (
                  <p>
                    Group practices scored {G.ok} of {G.n}; the repo publishes each one&apos;s label and the pages the researchers
                    cited. Prescribers who bill alone scored {S.ok} of {S.n} and are published only as counts.
                    {h.sellable && h.claims ? ` Of the ${h.ok} sellable, ${h.sellable.independent_specialty ?? 0} are specialty practices and ${h.sellable.independent_primary_or_multispecialty ?? 0} primary care or multispecialty. Weighted by claims, ${pc(h.claims.ok / h.claims.n)} of the sampled claims are at sellable accounts.` : ""}
                  </p>
                )}
                {A.dev && (
                  <p className="note">
                    Tuning sample first: {A.dev.before.ok} of {A.dev.before.n} BDR accounts sellable as first routed. The verify first
                    rule it drove moved {A.dev.removed.n} of them out of the BDR queue, {A.dev.removed.n - A.dev.removed.ok} of them
                    misses, and the rest scored {A.dev.after.ok} of {A.dev.after.n}. Every group practice either audit found routed
                    wrong is now corrected, citing the audit ({pl(A.corrected, "account")}); the {pc(h.ok / h.n)} measures
                    the rules before that.
                  </p>
                )}
              </div>
            </div>
          </section>
        );
      })()}

      <section className="phone-sec">
        <div className="wrap block">
          <div className="eyebrow">The phone check</div>
          <h2>Two federal directories, one address, two phone numbers</h2>
          <div className="phone-grid">
            <div>
              <p>
                A rep&apos;s first dial goes to the number in HubSpot. priormap compares the phone the NPI registry lists
                for each prescriber with the one Medicare&apos;s Doctors and Clinicians file lists at the same address.
                Where both list the same site and a phone ({fmt(P.comparable)} accounts), they disagree at {fmt(P.disagree)}{" "}
                ({P.disagreePct}%), {fmt(P.bdrDisagree)} of them in the BDR queue. {P.counts.swap} have two digits swapped and{" "}
                {P.counts.one_digit} are one digit apart. Another {P.extension} Medicare listings run an extension into the
                digits, which no dialer can use.
              </p>
              <p>
                priormap never says which number is right. HubSpot gets Medicare&apos;s number (the registry&apos;s when only it
                is a New York number), the other goes in a second field, and the record says how they differ, so the first call settles it.
              </p>
            </div>
            {P.hero && (
              <div className="phone-card">
                <div className="pc-name">{show(P.hero.practice)}</div>
                <div className="pc-site">{P.hero.site.split(",")[0].toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}, {P.hero.area}</div>
                <div className="pc-row"><span>Medicare</span><Digits a={P.hero.medicare} b={P.hero.registry} /></div>
                <div className="pc-row"><span>NPI registry</span><Digits a={P.hero.registry} b={P.hero.medicare} /></div>
                <div className="pc-foot">{P.hero.label}: one call settles which line rings</div>
              </div>
            )}
          </div>
          <p className="eval-note">
            <b>Tested, and the test found a bug.</b>{" "}Its first run showed that on 4 accounts the phone exported to HubSpot
            was not the number the check had compared; that is fixed. Forus&apos;s engineering blog evaluates its LLM judge by
            corrupting clean cases on purpose, and says naive perturbations only test shallow changes. Phone digits are exactly
            that, so this tests the plumbing, not the world: {fmt(card.eval.injected)} corruptions of five kinds, made everywhere
            Medicare prints the number for the {fmt(card.eval.clean)} accounts where the directories agree, run through the whole
            engine. {fmt(card.eval.caught)} surface as a disagreement a rep would see.
            {card.eval.injected > card.eval.caught ? ` The ${fmt(card.eval.injected - card.eval.caught)} that do not come from accounts where the corrupted number was also what tied a prescriber to the group.` : ""}{" "}
            Alongside them run {fmt(card.eval.controls)} controls, the same numbers untouched or rewritten with a +1, parentheses or
            dots, which must still read as matching: {card.eval.falseFlags} were flagged. Whether a flagged number is dead takes
            dials, so the check is a HubSpot field RevOps can report on.
          </p>
        </div>
      </section>

      <section className="wrap block">
        <div className="eyebrow">What a growth team gets</div>
        <h2>Files, not a dashboard</h2>
        <ul className="files">
          <li><code>hubspot_companies.csv</code> and <code>hubspot_contacts.csv</code>: stock HubSpot properties first, then priormap&apos;s, associated by practice id.</li>
          <li><code>practices.csv</code> and <code>prescribers.csv</code>: snake case, one row per account and per prescriber, ready for BigQuery.</li>
          <li><code>phone_check.csv</code>: every account where the directories disagree, with both numbers.</li>
          <li><code>skipped.csv</code>: every prescriber left out, with the reason.</li>
        </ul>
        <p><code>npm run fetch</code> refreshes every source from its federal API; <code>npm start</code> rebuilds everything in seconds; the tests and the phone eval run before every deploy.</p>
      </section>

      <section className="wrap block limits">
        <div className="eyebrow">Read before quoting</div>
        <ul>
          <li>Medicare is a floor. Part D sees only Medicare patients, and hides any drug a prescriber wrote fewer than 11 times.</li>
          <li>Claims are not prior auth requests. An approval usually covers months of refills, so requests run well below claims.</li>
          <li>The claims are from 2024, the newest year CMS publishes; the prior auth rules are from the plans sold in 2026.</li>
          <li>A hospital owned practice filed under its own legal name, with no hospital word, can still land in the AE or BDR queue.</li>
          <li>Ranking by Medicare claims favors specialties with older patients (rheumatology, neurology) over dermatology and allergy, where Forus has most of its published stories.</li>
        </ul>
      </section>

      <footer className="foot">
        <div className="wrap">
          <p>
            Sources: CMS Medicare Part D Prescribers by Provider and Drug (2024); CMS Prescription Drug Plan Formulary files
            (September 2026); NPPES NPI Registry; Medicare Doctors and Clinicians file; HRSA health center sites; Census ZIP to county file; RxNorm; Census ZIP centroids. Data as
            of {asOf}. Built by Larry Wolters. Not affiliated with Forus. <a href={REPO}>Code and method on GitHub</a>.
          </p>
        </div>
      </footer>
    </main>
  );
}
