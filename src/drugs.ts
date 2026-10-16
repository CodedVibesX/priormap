// The drugs priormap counts. Each one is a drug Forus names on forus.com, or a drug of the same class in a specialty
// forus.com lists (rheumatology, dermatology, allergy, gastroenterology, neurology, pulmonology). A drug only counts
// if the 2026 Medicare Part D formularies show it needs prior authorization on most plans that cover it
// (src/formulary.ts); the cut is recomputed on every run, never assumed.

export interface Drug {
  /** Matched against the Part D Gnrc_Name field (case insensitive substring), so biosimilars come along. */
  stem: string;
  brand: string;
  area: "immunology" | "respiratory" | "migraine";
  /** Where Forus names it, or "class" when it is a same class drug in a specialty Forus lists. */
  source: string;
}

const STORY = "https://www.forus.com/stories/";
export const SPECIALTIES_SOURCE = "https://www.forus.com/sitemap.xml (story topics) and https://www.forus.com/webinar";

export const DRUGS: Drug[] = [
  { stem: "dupilumab", brand: "Dupixent", area: "immunology", source: STORY + "how-forus-helps-practices-stay-independent" },
  { stem: "upadacitinib", brand: "Rinvoq", area: "immunology", source: STORY + "how-one-practice-rebounded-after-ma-turnover" },
  { stem: "certolizumab", brand: "Cimzia", area: "immunology", source: STORY + "how-one-practice-rebounded-after-ma-turnover" },
  { stem: "risankizumab", brand: "Skyrizi", area: "immunology", source: STORY + "how-one-practice-rebounded-after-ma-turnover" },
  { stem: "adalimumab", brand: "Humira and biosimilars", area: "immunology", source: "https://build.forus.com (engineering blog: pharmacy selection, LLM judge)" },
  { stem: "rimegepant", brand: "Nurtec ODT", area: "migraine", source: STORY + "how-modern-migraine-md-enables-providers-to-prescribe-on-clinical-judgement-with-forus" },
  { stem: "ubrogepant", brand: "Ubrelvy", area: "migraine", source: STORY + "how-modern-migraine-md-enables-providers-to-prescribe-on-clinical-judgement-with-forus" },
  { stem: "ustekinumab", brand: "Stelara", area: "immunology", source: "class" },
  { stem: "guselkumab", brand: "Tremfya", area: "immunology", source: "class" },
  { stem: "secukinumab", brand: "Cosentyx", area: "immunology", source: "class" },
  { stem: "ixekizumab", brand: "Taltz", area: "immunology", source: "class" },
  { stem: "bimekizumab", brand: "Bimzelx", area: "immunology", source: "class" },
  { stem: "etanercept", brand: "Enbrel", area: "immunology", source: "class" },
  { stem: "golimumab", brand: "Simponi", area: "immunology", source: "class" },
  { stem: "abatacept", brand: "Orencia", area: "immunology", source: "class" },
  { stem: "tocilizumab", brand: "Actemra", area: "immunology", source: "class" },
  { stem: "sarilumab", brand: "Kevzara", area: "immunology", source: "class" },
  { stem: "tofacitinib", brand: "Xeljanz", area: "immunology", source: "class" },
  { stem: "baricitinib", brand: "Olumiant", area: "immunology", source: "class" },
  { stem: "apremilast", brand: "Otezla", area: "immunology", source: "class" },
  { stem: "deucravacitinib", brand: "Sotyktu", area: "immunology", source: "class" },
  { stem: "tralokinumab", brand: "Adbry", area: "immunology", source: "class" },
  { stem: "abrocitinib", brand: "Cibinqo", area: "immunology", source: "class" },
  { stem: "vedolizumab", brand: "Entyvio", area: "immunology", source: "class" },
  { stem: "mirikizumab", brand: "Omvoh", area: "immunology", source: "class" },
  { stem: "ozanimod", brand: "Zeposia", area: "immunology", source: "class" },
  { stem: "etrasimod", brand: "Velsipity", area: "immunology", source: "class" },
  { stem: "omalizumab", brand: "Xolair", area: "respiratory", source: "class" },
  { stem: "mepolizumab", brand: "Nucala", area: "respiratory", source: "class" },
  { stem: "benralizumab", brand: "Fasenra", area: "respiratory", source: "class" },
  { stem: "tezepelumab", brand: "Tezspire", area: "respiratory", source: "class" },
  { stem: "atogepant", brand: "Qulipta", area: "migraine", source: "class" },
  { stem: "erenumab", brand: "Aimovig", area: "migraine", source: "class" },
  { stem: "fremanezumab", brand: "Ajovy", area: "migraine", source: "class" },
  { stem: "galcanezumab", brand: "Emgality", area: "migraine", source: "class" },
];

/** Drugs Forus names that priormap leaves out on purpose, with the reason. */
export const LEFT_OUT = [
  {
    drug: "tirzepatide and semaglutide (Zepbound, Wegovy)",
    source: STORY + "medicare-glp-1-bridge-program",
    reason:
      "Medicare did not cover weight loss in 2024, the newest Part D year, so 2024 claims for these drugs are mostly diabetes prescriptions (Mounjaro, Ozempic). Counting them would point reps at primary care, not at the July 2026 GLP1 bridge.",
  },
];

export function drugFor(gnrcName: string): Drug | undefined {
  const g = gnrcName.toLowerCase();
  return DRUGS.find((d) => g.includes(d.stem));
}
