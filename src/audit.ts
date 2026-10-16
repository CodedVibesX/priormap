// Audit labels flow back into routing: a group practice the audit found was routed wrong is corrected, citing the
// audit. The published accuracy is measured on the rules alone, before any of this. Labels for prescribers who bill
// alone are kept out of the public files (audit/labels.json holds group practices only): a label like "not a
// practice" next to an individual is not something to publish, and no id scheme can hide a public NPI.

export interface AuditLabel { sample: "dev" | "heldout"; id: string; label: string; how: string }

export const SELLABLE_LABELS = new Set(["independent_specialty", "independent_primary_or_multispecialty"]);

/** What an audit label does to an account's routing: a different queue, or out of the list. */
export function auditAction(label: string): { queue?: "independent" | "enterprise" | "large_group"; skip?: boolean; words: string } | null {
  switch (label) {
    case "independent_specialty":
    case "independent_primary_or_multispecialty": return { queue: "independent", words: "an independent practice a BDR can sell to" };
    case "hospital_academic_or_system": return { queue: "enterprise", words: "hospital or academic owned" };
    case "safety_net_clinic": return { queue: "enterprise", words: "a safety net clinic" };
    case "payer_or_corporate_owned": return { queue: "enterprise", words: "corporate owned" };
    case "large_physician_group": return { queue: "large_group", words: "a physician group of about 50 or more" };
    case "not_a_practice": return { skip: true, words: "not a practice a BDR can sell to" };
    case "closed_or_moved": return { skip: true, words: "closed, or no longer at this address" };
    default: return null;
  }
}
