/**
 * How stable is the verdict?
 *
 *   node scripts/stability-run.mjs [--n 10] [--payload payload-accepted.json]
 *
 * One deployment, N commissions carrying the IDENTICAL terms and the IDENTICAL
 * deliverable, judged N times. Nothing varies except which validators and which
 * models the network happens to assign.
 *
 * This exists because run 4 accepted a deliverable that runs 1-3 rejected. Most
 * of that was explained — the earlier runs were shown an incomplete case file —
 * but the claim at issue is genuinely marginal, and a single accepted run is not
 * a measurement. This is the measurement.
 *
 * Four outcomes are counted, not three. A transaction can finalize with the
 * leader's execution successful and apply NO STATE, because the committee voted
 * the leader's verdict down (MAJORITY_DISAGREE). That is a real outcome of the
 * equivalence principle and collapsing it into "no verdict" would hide it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newClient,
  fund,
  track,
  applied,
  succeeded,
  contractAddressOf,
  withRetry,
  RPC_URL,
} from "./lib/studio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TERMS = JSON.parse(readFileSync(join(ROOT, "fixtures", "commission-terms.json"), "utf8"));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const N = Number(arg("n", "10"));
const PAYLOAD_FILE = arg("payload", "payload-accepted.json");
const OUT = arg("out", join(ROOT, "transcripts", "stability.json"));

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

async function main() {
  const payload = JSON.parse(readFileSync(join(ROOT, "fixtures", PAYLOAD_FILE), "utf8"));
  const started = Date.now();

  const result = {
    network: "studionet",
    chain_id: 61999,
    rpc: RPC_URL,
    payload: PAYLOAD_FILE,
    brief_digest: payload.brief_digest,
    started_at: new Date().toISOString(),
    iterations: [],
    tally: {},
  };

  const { account: client, client: rpc } = newClient();
  await fund(client.address, 2000);
  await new Promise((r) => setTimeout(r, 3000));
  log("account", client.address);

  const code = readFileSync(join(ROOT, "contracts", "brief_acceptance.py"), "utf8");
  log("deploying …");
  const deployHash = await withRetry("deploy", () => rpc.deployContract({ code, args: [] }));
  const deploy = await track(rpc, deployHash, "deploy");
  if (!succeeded(deploy.receipt)) throw new Error("deploy failed");
  const address = contractAddressOf(deploy.receipt);
  result.contract_address = address;
  log("deployed at", address);

  for (let i = 1; i <= N; i += 1) {
    const cid = `stability-${String(i).padStart(2, "0")}`;
    const iteration = { n: i, commission_id: cid };
    try {
      // Only the judgement needs finalizing. The setup writes are waited to
      // ACCEPTED, which is enough for the next call to see the state and keeps
      // the polling load off Studio's rate limit.
      const open = await withRetry("open", () =>
        rpc.writeContract({
          address,
          functionName: "open_commission",
          args: [cid, TERMS.asked, TERMS.acceptance_criteria, TERMS.evidence_requirements],
          value: 0n,
        }),
      );
      await track(rpc, open, `open:${i}`, { finalize: false });

      const submit = await withRetry("submit", () =>
        rpc.writeContract({
          address,
          functionName: "submit_deliverable",
          args: [cid, payload.brief_digest, payload.deliverable_json],
          value: 0n,
        }),
      );
      await track(rpc, submit, `submit:${i}`, { finalize: false });

      const evaluate = await withRetry("evaluate", () =>
        rpc.writeContract({ address, functionName: "evaluate", args: [cid], value: 0n }),
      );
      const judged = await track(rpc, evaluate, `evaluate:${i}`);

      const stateApplied = applied(judged.receipt);
      const state = await withRetry("read", () =>
        rpc.readContract({ address, functionName: "get_commission", args: [cid] }),
      );

      const outcome = stateApplied ? state.verdict || "EMPTY" : "NO_CONSENSUS";
      Object.assign(iteration, {
        outcome,
        verdict: state.verdict || null,
        status: state.status,
        state_applied: stateApplied,
        consensus_result: judged.record.consensus_result,
        validator_votes: judged.record.validator_votes,
        leader_model: judged.record.leader_model,
        ms_to_accepted: judged.record.ms_to_accepted,
        ms_to_finalized: judged.record.ms_to_finalized,
        reasons: state.reasons ?? [],
        tx: evaluate,
      });
      result.tally[outcome] = (result.tally[outcome] ?? 0) + 1;
      log(
        `${i}/${N} ${outcome}`,
        `| ${judged.record.consensus_result}`,
        `| ${JSON.stringify(judged.record.validator_votes)}`,
        `| ${judged.record.leader_model}`,
      );
      for (const reason of (state.reasons ?? []).slice(0, 3)) log(`      - ${reason.slice(0, 150)}`);
    } catch (error) {
      iteration.outcome = "ERROR";
      iteration.error = String(error?.message ?? error).slice(0, 300);
      result.tally.ERROR = (result.tally.ERROR ?? 0) + 1;
      log(`${i}/${N} ERROR: ${iteration.error.slice(0, 120)}`);
    }
    result.iterations.push(iteration);
    writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  }

  result.total_ms = Date.now() - started;
  result.finished_at = new Date().toISOString();
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);

  log("=== TALLY ===");
  for (const [outcome, count] of Object.entries(result.tally).sort((a, b) => b[1] - a[1])) {
    log(`  ${outcome}: ${count}/${N}`);
  }
  log("transcript:", OUT);
}

main().catch((error) => {
  console.error("FAILED:", error?.message ?? error);
  process.exit(1);
});
