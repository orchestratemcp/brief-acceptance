/**
 * Turn one DASH brief (+ the digest it was written from) into a BriefAcceptance
 * submission payload.
 *
 * Usage:
 *   node scripts/dash-brief-to-payload.mjs <exported.json> [--mutate] > payload.json
 *
 * The input is `{ brief, digest }` — two run artifacts exactly as DASH stores
 * them (contracts/run-artifact.schema.json, artifact version 2).
 *
 * ## What crosses, and what deliberately does not
 *
 * What crosses is the prose, the index bindings, and DASH's own receipts. What
 * does NOT cross is any address. DASH's rule is that model-authored prose can
 * never carry a link — the model is never sent one — and the evidence list keeps
 * that property on-chain by carrying a RECEIPT ID (`<digest artifact>#<n>`)
 * instead of a URL. The receipt id resolves back to a row in the run DASH holds;
 * the judge can check a claim against the row, and the model can never mint one.
 *
 * No credential, token, key, file path or store location is read or emitted.
 *
 * ## The join is re-checked here
 *
 * `derived_from.items_digest` is a sha256 over the digest's own item identities,
 * computed by DASH before the brief was written. This script recomputes it. If
 * the brief was written from a different list, the payload is refused rather
 * than shipped with citations that point at the wrong rows — which is the same
 * ruling DASH's own renderer makes (`lib/brief/fingerprint.ts`).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Mirror of DASH's `canonicaliseItems` — identity fields only, fixed order. */
function canonicaliseItems(items) {
  return JSON.stringify(
    items.map((item) => [item.headline, item.source_url ?? null, item.item_url ?? null]),
  );
}

function fingerprintItems(items) {
  return createHash("sha256").update(canonicaliseItems(items), "utf8").digest("hex");
}

export function briefToPayload({ brief, digest }, { mutate = false, correct = false } = {}) {
  if (brief?.kind !== "brief") throw new Error("input.brief is not a brief artifact");
  if (digest?.kind !== "digest") throw new Error("input.digest is not a digest artifact");

  const from = brief.derived_from;
  if (digest.artifact_id !== from.artifact_id || digest.run_id !== from.run_id) {
    throw new Error("the digest is not the one this brief names");
  }
  if (digest.items.length !== from.item_count) {
    throw new Error(`item count drifted: brief says ${from.item_count}, digest has ${digest.items.length}`);
  }
  const recomputed = fingerprintItems(digest.items);
  if (recomputed !== from.items_digest) {
    throw new Error("items_digest mismatch — the brief was written from a different list");
  }

  // Flatten the document. A section heading is context for its paragraphs; the
  // citation binds to the PARAGRAPH, so the paragraph is the unit that ships.
  const paragraphs = [];
  for (const section of brief.document.sections) {
    for (const paragraph of section.paragraphs) {
      paragraphs.push({
        section: section.heading,
        body: paragraph.body,
        items: [...(paragraph.items ?? [])],
      });
    }
  }

  // Ship only the evidence this brief actually cites, renumbered — a 53-row list
  // is mostly rows no paragraph points at, and every byte is stored on-chain.
  // The receipt id keeps the original position, so a row still resolves back.
  const cited = [...new Set(paragraphs.flatMap((p) => p.items))].sort((a, b) => a - b);
  const position = new Map(cited.map((original, index) => [original, index]));

  // Carry every field of the row that the prose could have been written FROM.
  //
  // Run 1 on Studionet rejected an honest brief because a paragraph cited
  // reaction and comment counts that the digest row carries and this projection
  // was dropping. The judge was right: as shipped, the claim had no support. An
  // evidence projection that keeps only the headline turns a grounded brief into
  // an ungrounded one at the last step.
  //
  // Still absent, deliberately: every address. `source_url` and `item_url` stay
  // out, and the receipt id carries the provenance instead.
  const evidence = cited.map((original) => {
    const item = digest.items[original];
    const row = {
      id: `${digest.artifact_id}#${original}`,
      headline: item.headline,
      source_name: item.source_name ?? null,
      summary: typeof item.summary === "string" ? item.summary.slice(0, 600) : null,
      published_at: item.published_at ?? null,
    };
    for (const field of ["competitor", "kind", "signal", "reactions", "comments", "author", "state"]) {
      if (item[field] !== undefined && item[field] !== null) row[field] = item[field];
    }
    return row;
  });

  for (const paragraph of paragraphs) {
    paragraph.items = paragraph.items.map((original) => position.get(original)).filter((i) => i !== undefined);
  }

  const deliverable = {
    title: brief.title,
    agent: brief.agent,
    generated_at: brief.generated_at,
    model: brief.document.model ?? null,
    provenance: {
      run_id: brief.run_id,
      brief_artifact_id: brief.artifact_id,
      digest_artifact_id: digest.artifact_id,
      digest_item_count: from.item_count,
      items_digest: from.items_digest,
    },
    paragraphs,
    evidence,
    sources_fetched: (digest.sources_fetched ?? []).map((source) => ({
      source_name: source.source_name,
      status: source.status,
      item_count: source.item_count ?? null,
    })),
  };

  if (correct) applyCorrection(deliverable);
  if (mutate) applyMutation(deliverable);

  const suffix = mutate ? "-mutated" : correct ? "-v2" : "";
  const deliverable_json = JSON.stringify(deliverable);
  return {
    commission_id: `dash-${brief.run_id.slice(0, 8)}${suffix}`,
    brief_digest: createHash("sha256").update(deliverable_json, "utf8").digest("hex"),
    deliverable_json,
    deliverable,
  };
}

/**
 * The corrected deliverable — the resubmission after a rejection.
 *
 * Studionet run 2 rejected the brief as written, for one reason that is simply
 * true: P1 says the cited posts drew "well over a thousand reactions and
 * hundreds of comments each", and two of the four rows it cites carry 802 and
 * 511 reactions. The claim overstates the receipts it is bound to.
 *
 * That is the finding this whole exercise is for, and it is not patched away:
 * `fixtures/payload-accepted.json` still carries the sentence as the model
 * wrote it, and the transcript of its rejection is kept. What this produces is
 * the SECOND submission — the same brief with that one sentence brought back in
 * line with the numbers, which is what a deliverer does after losing a dispute.
 *
 * The replacement is checked against the rows it cites:
 *   E1 1349/720, E2 1099/827, E3 802/705, E7 511/293.
 */
function applyCorrection(deliverable) {
  const overstated =
    "These posts drew very heavy engagement, with well over a thousand reactions and hundreds of comments each.";
  const supported =
    "These posts drew heavy engagement, with reaction counts ranging from roughly five hundred to " +
    "thirteen hundred and hundreds of comments each.";

  let replaced = 0;
  for (const paragraph of deliverable.paragraphs) {
    if (paragraph.body.includes(overstated)) {
      paragraph.body = paragraph.body.replace(overstated, supported);
      replaced += 1;
    }
  }
  if (replaced === 0) {
    throw new Error("the sentence this correction repairs is not in the brief — check the fixture");
  }
  deliverable.title = `${deliverable.title} (revised after adjudication)`;
  deliverable.revision = {
    of: "dash-e57149d0",
    changed: ["P1: engagement claim brought in line with the reaction counts on E1, E2, E3, E7"],
  };
}

/**
 * The deliberately-bad deliverable.
 *
 * Two independent defects, because the two non-accepting verdicts are different
 * findings and a demo that only shows one is showing half the contract:
 *
 *  1. A fabricated claim on a paragraph that keeps its real citations — a number
 *     and an acquisition that appear in no cited evidence. That is REJECTED.
 *  2. A paragraph stripped of its citations entirely, and one citation pointed
 *     past the end of the evidence list. That is INSUFFICIENT_EVIDENCE.
 *
 * Nothing else about the deliverable changes, so the judge is being asked the
 * narrow question rather than handed an obviously different document.
 */
function applyMutation(deliverable) {
  const [first, second] = deliverable.paragraphs;
  if (first) {
    first.body =
      first.body.trimEnd() +
      " Anthropic acquired OpenClaw outright for $2.4 billion in July 2026, and 78% of its users " +
      "migrated to Hermes Agent within a fortnight of the announcement.";
  }
  if (second) {
    second.items = [];
  }
  const third = deliverable.paragraphs[2];
  if (third) {
    third.items = [deliverable.evidence.length + 5];
  }
  deliverable.title = `${deliverable.title} (mutated)`;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/dash-brief-to-payload.mjs <exported.json> [--correct|--mutate]");
    process.exit(2);
  }
  const mutate = process.argv.includes("--mutate");
  const correct = process.argv.includes("--correct");
  const input = JSON.parse(readFileSync(file, "utf8"));
  const payload = briefToPayload(input, { mutate, correct });
  const { deliverable, ...rest } = payload;
  process.stdout.write(`${JSON.stringify({ ...rest, deliverable }, null, 2)}\n`);
}
