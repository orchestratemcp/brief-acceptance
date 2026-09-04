/**
 * Drive BriefAcceptance on Studionet, end to end, and write a transcript.
 *
 *   node scripts/studionet-run.mjs [--bounty 100] [--out transcript.json]
 *
 * What this proves, in one run, against real validators and real models:
 *
 *   1. A client opens a commission with machine-readable terms and locks a bounty.
 *   2. A supervised agent submits a deliverable — a real DASH brief, its evidence
 *      list, and the sha256 the contract re-derives from the submitted bytes.
 *   3. `evaluate()` judges it under the equivalence principle and, on ACCEPTED,
 *      releases the bounty to the deliverer.
 *   4. The same run repeats 1-3 with a deliberately mutated deliverable, which
 *      must not be accepted.
 *
 * Both accounts are throwaways created here and funded from Studionet's faucet.
 * Nothing is read from a keystore and nothing is written to one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newClient,
  fund,
  nativeBalance,
  track,
  succeeded,
  contractAddressOf,
  executionResultOf,
  withRetry,
  RPC_URL,
} from "./lib/studio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// One copy of the terms, shared with the direct tests.
const TERMS = JSON.parse(readFileSync(join(ROOT, "fixtures", "commission-terms.json"), "utf8"));
const ASKED = TERMS.asked;
const CRITERIA = TERMS.acceptance_criteria;
const EVIDENCE_RULES = TERMS.evidence_requirements;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BOUNTY = BigInt(arg("bounty", "100"));
const OUT = arg("out", join(ROOT, "transcript-studionet.json"));

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

async function main() {
  const started = Date.now();
  const transcript = {
    network: "studionet",
    chain_id: 61999,
    rpc: RPC_URL,
    started_at: new Date().toISOString(),
    bounty: BOUNTY.toString(),
    steps: [],
    cases: {},
  };

  // ---------------------------------------------------------------- accounts
  const { account: client, client: clientRpc } = newClient();
  const { account: agent, client: agentRpc } = newClient();
  transcript.accounts = { client: client.address, deliverer: agent.address };
  log("client   ", client.address);
  log("deliverer", agent.address);

  await fund(client.address, 1000);
  await fund(agent.address, 1);
  await new Promise((r) => setTimeout(r, 3000));
  transcript.balances_before = {
    client: (await nativeBalance(client.address)).toString(),
    deliverer: (await nativeBalance(agent.address)).toString(),
  };
  log("funded:", JSON.stringify(transcript.balances_before));

  // ------------------------------------------------------------------ deploy
  const code = readFileSync(join(ROOT, "contracts", "brief_acceptance.py"), "utf8");
  log("deploying BriefAcceptance …");
  const deployHash = await withRetry("deploy", () => clientRpc.deployContract({ code, args: [] }));
  const deploy = await track(clientRpc, deployHash, "deploy");
  transcript.steps.push(deploy.record);
  if (!succeeded(deploy.receipt)) {
    throw new Error(`deploy did not execute successfully: ${executionResultOf(deploy.receipt)}`);
  }
  const address = contractAddressOf(deploy.receipt);
  transcript.contract_address = address;
  log("deployed at", address, `(${deploy.record.ms_to_finalized} ms to finalized)`);

  // --------------------------------------------------------------- the cases
  // Three cases, in the order a dispute actually unfolds:
  //   as-written  the brief exactly as the agent's model wrote it
  //   revised     the same brief after the deliverer repairs the finding
  //   mutated     a deliberately falsified deliverable
  for (const [name, file, bounty] of [
    ["as-written", "payload-accepted.json", BOUNTY],
    ["revised", "payload-corrected.json", BOUNTY],
    ["mutated", "payload-mutated.json", BOUNTY],
  ]) {
    const payload = JSON.parse(readFileSync(join(ROOT, "fixtures", file), "utf8"));
    const cid = payload.commission_id;
    log(`--- case "${name}" (${cid}) ---`);

    const open = await withRetry("open_commission", () =>
      clientRpc.writeContract({
        address,
        functionName: "open_commission",
        args: [cid, ASKED, CRITERIA, EVIDENCE_RULES],
        value: bounty,
      }),
    );
    const opened = await track(clientRpc, open, `open_commission:${name}`);
    transcript.steps.push(opened.record);
    log("  opened   ", opened.record.status, opened.record.execution_result);

    const submit = await withRetry("submit_deliverable", () =>
      agentRpc.writeContract({
        address,
        functionName: "submit_deliverable",
        args: [cid, payload.brief_digest, payload.deliverable_json],
        value: 0n,
      }),
    );
    const submitted = await track(agentRpc, submit, `submit_deliverable:${name}`);
    transcript.steps.push(submitted.record);
    log("  submitted", submitted.record.status, submitted.record.execution_result);

    log("  evaluating (real validators, real models) …");
    const evaluate = await withRetry("evaluate", () =>
      agentRpc.writeContract({
        address,
        functionName: "evaluate",
        args: [cid],
        value: 0n,
      }),
    );
    const judged = await track(agentRpc, evaluate, `evaluate:${name}`);
    transcript.steps.push(judged.record);
    log(
      "  judged   ",
      judged.record.status,
      judged.record.execution_result,
      `accepted in ${judged.record.ms_to_accepted} ms, finalized in ${judged.record.ms_to_finalized} ms`,
    );

    const verdict = await withRetry("get_verdict", () =>
      clientRpc.readContract({ address, functionName: "get_verdict", args: [cid] }),
    );
    const state = await withRetry("get_commission", () =>
      clientRpc.readContract({ address, functionName: "get_commission", args: [cid] }),
    );

    transcript.cases[name] = {
      commission_id: cid,
      brief_digest: payload.brief_digest,
      deliverable_bytes: Buffer.byteLength(payload.deliverable_json),
      paragraphs: payload.deliverable.paragraphs.length,
      evidence: payload.deliverable.evidence.length,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      judge_output: verdict.judge_output,
      status: state.status,
      leader_model: judged.record.leader_model,
      validator_votes: judged.record.validator_votes,
      ms_to_accepted: judged.record.ms_to_accepted,
      ms_to_finalized: judged.record.ms_to_finalized,
      evaluate_tx: evaluate,
    };
    log(`  VERDICT: ${verdict.verdict}`);
    for (const reason of verdict.reasons ?? []) log(`    - ${reason}`);
  }

  // ---------------------------------------------------------------- balances
  await new Promise((r) => setTimeout(r, 3000));
  transcript.balances_after = {
    client: (await nativeBalance(client.address)).toString(),
    deliverer: (await nativeBalance(agent.address)).toString(),
    contract: (await nativeBalance(address)).toString(),
  };
  log("balances after:", JSON.stringify(transcript.balances_after));

  transcript.total_ms = Date.now() - started;
  transcript.finished_at = new Date().toISOString();
  writeFileSync(OUT, `${JSON.stringify(transcript, null, 2)}\n`);
  log("transcript written to", OUT);

  const summary = Object.entries(transcript.cases)
    .map(([name, c]) => `${name}=${c.verdict}`)
    .join(" ");
  log(`RESULT ${summary}`);
  if (transcript.cases.revised?.verdict !== "ACCEPTED") {
    log("NOTE: the revised deliverable was not accepted — read the reasons above.");
  }
  if (transcript.cases.mutated?.verdict === "ACCEPTED") {
    log("NOTE: the mutated deliverable WAS accepted — read the reasons above.");
  }
}

main().catch((error) => {
  console.error("FAILED:", error?.message ?? error);
  if (error?.stack) console.error(error.stack.split("\n").slice(1, 5).join("\n"));
  process.exit(1);
});
