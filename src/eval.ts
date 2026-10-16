// Tests the phone check with the perturbation idea Forus's engineering blog describes for its LLM judge: take cases
// known to be clean, inject known corruptions, and count what the check surfaces. Two controls run alongside: the same
// numbers untouched, and the same numbers reformatted (+1, parentheses, dots), which must still read as agreeing; any
// flag on a control is a false flag. Seeded, so every run gives the same numbers. Clean cases are real accounts where
// both directories already agree on the phone.
import { digits10, type PhoneCheck } from "./phone.ts";
import { build, type Inputs } from "./engine.ts";

export type Injection = "none" | "reformat" | "one_digit" | "swap" | "area_code" | "line" | "drop_digit";
/** What the checker should report for each injection. */
export const EXPECT: Record<Injection, PhoneCheck> = {
  none: "agree",
  reformat: "agree",
  one_digit: "one_digit",
  swap: "swap",
  area_code: "area_code",
  line: "same_exchange",
  drop_digit: "malformed",
};
/** Injections that change nothing a rep would care about: the check must still say agree. */
export const CONTROLS = new Set<Injection>(["none", "reformat"]);

/** mulberry32: a tiny deterministic generator. */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREA = ["212", "646", "718", "347", "917", "516", "631", "914", "845", "518", "315", "585", "716", "607"];

export function inject(phone: string, kind: Injection, rand: () => number): string {
  const d = digits10(phone).split("");
  const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
  const other = (c: string) => String((Number(c) + 1 + pick(0, 9)) % 10);
  switch (kind) {
    case "none":
      return d.join("");
    case "reformat": {
      // the same number written the ways real directories write it
      const a = d.slice(0, 3).join(""), b = d.slice(3, 6).join(""), c = d.slice(6).join("");
      const ways = [`+1 (${a}) ${b}-${c}`, `${a}.${b}.${c}`, `1${a}${b}${c}`, `(${a}) ${b} ${c}`, `${a}-${b}-${c}`];
      return ways[pick(0, ways.length)];
    }
    case "one_digit": {
      // the exchange must still start with 2 to 9, or the corruption would read as malformed instead
      const i = pick(3, 10);
      let c = other(d[i]);
      while (i === 3 && Number(c) < 2) c = other(d[i]);
      d[i] = c;
      return d.join("");
    }
    case "swap": {
      // two neighbors that differ, so the swap is visible, and the exchange still starts with 2 to 9
      const spots = [...Array(9).keys()].filter((i) => i >= 3 && d[i] !== d[i + 1] && !(i === 3 && Number(d[4]) < 2));
      if (!spots.length) return inject(phone, "one_digit", rand);
      const i = spots[pick(0, spots.length)];
      [d[i], d[i + 1]] = [d[i + 1], d[i]];
      return d.join("");
    }
    case "area_code": {
      // an area code at least two digits away, so the change cannot also read as a one digit typo
      const own = d.slice(0, 3);
      const choices = AREA.filter((a) => [...a].filter((c, i) => c !== own[i]).length >= 2);
      return choices[pick(0, choices.length)] + d.slice(3).join("");
    }
    case "line": {
      // a new last four that differs in at least two places, like a department line
      let line: string;
      do line = String(pick(0, 10000)).padStart(4, "0");
      while ([...line].filter((c, i) => c !== d[6 + i]).length < 2);
      return d.slice(0, 6).join("") + line;
    }
    case "drop_digit": {
      d.splice(pick(0, 10), 1);
      return d.join("");
    }
  }
}

/** Checks that put a disagreement in front of a rep. */
export const SURFACED = new Set<string>(["swap", "one_digit", "area_code", "same_exchange", "differ", "malformed"]);

export interface EvalResult {
  cleanPractices: number;
  perKind: Record<Injection, { n: number; caught: number; exact: number }>;
  /** Control cases the check flagged: any answer but agree. */
  falseFlags: number;
  recall: number;
}

/**
 * End to end: for every practice whose two directories already agree, change the Medicare phone on its site rows,
 * rerun the whole engine, and read the account's phone check. One kind of change per run.
 */
export function runEval(inp: Inputs, seed = 2026): EvalResult {
  const base = build(inp);
  const clean = base.practices.filter((p) => p.phoneCheck === "agree" && p.phone);
  const kinds = Object.keys(EXPECT) as Injection[];
  const perKind = Object.fromEntries(kinds.map((k) => [k, { n: 0, caught: 0, exact: 0 }])) as EvalResult["perKind"];
  for (const k of kinds) {
    const rand = rng(seed + kinds.indexOf(k));
    // a wrong listing is wrong wherever Medicare prints it: for a group, on every member's row with that number; for a
    // prescriber billing alone, on their own rows
    const swap = new Map<string, string>(); // org:pac|phone or npi|phone -> changed phone
    for (const p of clean) {
      const bad = inject(p.phone, k, rand);
      if (p.orgPac) swap.set(`org:${p.orgPac}|${p.phone}`, bad);
      for (const pr of p.prescribers) swap.set(`${pr.npi}|${p.phone}`, bad);
    }
    const dac = inp.dac.map((r) => {
      const ph = digits10(r.phone);
      const bad = (r.orgPac && swap.get(`org:${r.orgPac}|${ph}`)) || swap.get(`${r.npi}|${ph}`);
      return bad ? { ...r, phone: bad } : r;
    });
    const after = new Map(build({ ...inp, dac }).practices.map((p) => [p.key, p]));
    for (const p of clean) {
      const got = after.get(p.key)?.phoneCheck;
      const r = perKind[k];
      r.n++;
      // a control is flagged by any answer but agree; a corruption is caught only when a rep would see a disagreement
      if (CONTROLS.has(k) ? got !== "agree" : got && SURFACED.has(got)) r.caught++;
      if (got === EXPECT[k]) r.exact++;
    }
  }
  const injected = kinds.filter((k) => !CONTROLS.has(k));
  const n = injected.reduce((s, k) => s + perKind[k].n, 0);
  return {
    cleanPractices: clean.length,
    perKind,
    falseFlags: [...CONTROLS].reduce((s, k) => s + perKind[k].caught, 0),
    recall: n ? injected.reduce((s, k) => s + perKind[k].caught, 0) / n : 0,
  };
}
