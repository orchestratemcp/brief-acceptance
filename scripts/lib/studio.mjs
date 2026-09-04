/**
 * Thin helpers over genlayer-js for the Studionet run.
 *
 * Every account here is a throwaway made by `createAccount()` at run time and
 * funded from Studionet's own faucet. No key is read from disk, no key is
 * written to disk, and none of this touches anything outside this repository.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

export const RPC_URL = studionet.rpcUrls.default.http[0];

export function newClient(account = createAccount()) {
  return { account, client: createClient({ chain: studionet, account }) };
}

/** Studionet's built-in faucet, over JSON-RPC. */
export async function fund(address, amount = 1000) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sim_fundAccount",
      params: [address, amount],
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`faucet refused: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function nativeBalance(address) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return BigInt(body.result);
}

const now = () => Date.now();

/**
 * Retry a Studionet call through a transient failure.
 *
 * The hosted Studio sometimes answers an RPC with an HTML error page, which
 * surfaces as `Unexpected token '<'` from the JSON parser rather than as
 * anything the SDK recognises. It is transient. Rate limiting (60/min, HTTP 429,
 * -32429) looks similar and also clears. Neither is a reason to abandon a run
 * that already has a transaction in flight.
 */
export async function withRetry(label, fn, { attempts = 5, base = 4000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const text = String(error?.message ?? error);
      const transient =
        text.includes("Unexpected token '<'") ||
        text.includes("429") ||
        text.includes("-32429") ||
        text.includes("fetch failed") ||
        text.includes("ETIMEDOUT") ||
        text.includes("ECONNRESET");
      if (!transient || attempt === attempts) throw error;
      const wait = base * attempt;
      console.warn(`  [retry ${attempt}/${attempts - 1}] ${label}: ${text.slice(0, 90)} — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/**
 * Wait for a transaction, recording how long each lifecycle point took.
 *
 * Accepted and Finalized are different questions and the transcript keeps them
 * apart: Accepted means the committee agreed on the receipt, Finalized means the
 * appeal window has closed. Neither of them means the contract call succeeded —
 * that is the execution result, checked separately.
 */
export async function track(client, hash, label, { finalize = true } = {}) {
  const submitted = now();
  const accepted = await withRetry(`${label}:accepted`, () =>
    client.waitForTransactionReceipt({
      hash,
      status: TransactionStatus.ACCEPTED,
      interval: 2000,
      retries: 150,
    }),
  );
  const acceptedAt = now();

  let finalized = null;
  let finalizedAt = null;
  if (finalize) {
    finalized = await withRetry(`${label}:finalized`, () =>
      client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.FINALIZED,
        interval: 3000,
        retries: 200,
      }),
    );
    finalizedAt = now();
  }

  const receipt = finalized ?? accepted;
  const record = {
    label,
    hash,
    status: receipt.status_name ?? receipt.statusName ?? receipt.status ?? null,
    execution_result: executionResultOf(receipt),
    consensus_result: receipt?.result_name ?? receipt?.result ?? null,
    ms_to_accepted: acceptedAt - submitted,
    ms_to_finalized: finalizedAt === null ? null : finalizedAt - submitted,
    leader_model: leaderModelOf(receipt),
    validator_votes: votesOf(receipt),
  };
  return { receipt, record };
}

export function executionResultOf(receipt) {
  // The leader receipt's own execution_result first. The transaction-level
  // `result_name` is the CONSENSUS outcome (MAJORITY_AGREE and friends) and is
  // not an answer to "did the contract call succeed" — reading it as one is how
  // a failed call gets reported as a success.
  return (
    receipt?.consensus_data?.leader_receipt?.[0]?.execution_result ??
    receipt?.consensus_data?.leader_receipt?.execution_result ??
    receipt?.txExecutionResultName ??
    null
  );
}

function leaderReceipts(receipt) {
  const raw = receipt?.consensus_data?.leader_receipt;
  if (Array.isArray(raw)) return raw;
  if (raw) return [raw];
  return [];
}

/**
 * Which model actually wrote the verdict.
 *
 * Studio has moved this around between versions, so rather than pin one path
 * this walks the receipt for the first object carrying a `model`. What it finds
 * is reported as the network's claim, not as this repository's measurement.
 */
export function leaderModelOf(receipt) {
  const node = leaderReceipts(receipt)[0]?.node_config;
  if (node?.model) return [node.provider, node.model].filter(Boolean).join("/");
  return findModel(receipt);
}

function findModel(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (typeof value.model === "string" && value.model.length > 0) {
    return [value.provider, value.model].filter((p) => typeof p === "string" && p).join("/");
  }
  for (const child of Object.values(value)) {
    const found = findModel(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function votesOf(receipt) {
  const votes = receipt?.consensus_data?.votes;
  if (!votes || typeof votes !== "object") return null;
  const tally = {};
  for (const vote of Object.values(votes)) {
    const name = typeof vote === "string" ? vote : JSON.stringify(vote);
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

/** The success rule: a decided status is not the same as a successful call. */
export function succeeded(receipt) {
  const result = executionResultOf(receipt);
  return result === "FINISHED_WITH_RETURN" || result === "SUCCESS" || result === 1;
}

/**
 * Whether the transaction actually CHANGED anything.
 *
 * There are three different questions and they are easy to collapse into one:
 *
 *   status              did the transaction reach a decision?      FINALIZED
 *   execution_result    did the leader's own call succeed?         SUCCESS
 *   consensus result    did the committee accept the leader?       MAJORITY_AGREE
 *
 * A transaction can be FINALIZED, with the leader's execution SUCCESS, and apply
 * NO STATE, because the committee returned MAJORITY_DISAGREE. Studionet run 4
 * did exactly that on the revised deliverable: the leader proposed a verdict,
 * three validators judged that verdict against the same case file and refused
 * it, and the commission stayed `submitted` with no verdict at all. Reading only
 * the first two fields reports that as a success with a mysteriously empty
 * result.
 *
 * This is the equivalence principle doing its job. It is also the single
 * easiest thing to get wrong when driving GenLayer from a script.
 */
export function applied(receipt) {
  const consensus = receipt?.result_name ?? receipt?.result ?? null;
  return succeeded(receipt) && (consensus === "MAJORITY_AGREE" || consensus === 6);
}

export function contractAddressOf(receipt) {
  return (
    receipt?.data?.contract_address ??
    receipt?.contract_address ??
    receipt?.to_address ??
    null
  );
}
