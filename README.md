# BriefAcceptance — escrow released when a deliverable meets machine-readable terms

**Agent Tank hackathon · track: Onchain Justice · status: spike, with a go/no-go verdict at the bottom.**

A client opens a commission on GenLayer with machine-readable terms — what was
asked, the acceptance criteria, the evidence requirements — and locks a bounty.
A supervised agent submits a deliverable: a written brief in which every
paragraph carries the indices of the evidence it was written from, plus the
evidence list itself, plus the fetch receipts for every source the runtime tried.
`evaluate()` judges the deliverable against the terms under the equivalence
principle, and on ACCEPTED releases the bounty to the deliverer.

The differentiator, stated plainly:

> **The deliverer is a supervised agent whose deliverable ships with
> runtime-generated provenance the judge can check, not prose it has to trust.**

Internet Court (this track) and Apolo (Future of Work) both adjudicate work that
arrives as text. Here the work arrives as text *bound by index to the receipts
the supervising runtime wrote while producing it* — which fetch answered, which
did not, which row each sentence came from, and a digest the contract re-derives
from the submitted bytes. The judge is not asked to believe the agent. It is
handed the agent's own audit trail and asked whether the prose stays inside it.

Everything below happened. The transcripts in `transcripts/` are the receipts.

---

## The two results that matter

### 1. The escrow released, on chain, against a real agent's work

Studionet run 4, contract `0xc5808632a9571Fb9E01680305c6afAc58EddC195`. The
deliverable is a **real brief written by a real agent** — the OrchestrateDASH
competitor scout, run `e57149d0` of 2026-08-20, composed by
`anthropic/claude-sonnet-5` over a 53-item digest with 8 fetch receipts. A
committee led by `openrouter/anthropic/claude-sonnet-4.6` accepted it, paragraph
by paragraph, naming the evidence each one rests on:

> *"P1 cites E1, E2, E3, E7 and all facts (Anthropic restriction starting April
> 4, pay-as-you-go requirement, reversal later that month, Google restriction,
> engagement numbers) are present in those evidence items."*
> …
> *"Deliverable ships 8 fetch receipts including the 2 unreachable sources."*

The ledger moved with it: **the deliverer went from 1 GEN to 101.** Bounty
locked at `open_commission`, released at ACCEPTED, in the same run.

The mutated deliverable, submitted to the same contract minutes later, came back
**INSUFFICIENT_EVIDENCE** with all three of its planted defects found — the
uncited paragraph, the dangling `E31`, and the invented $2.4bn acquisition —
and its bounty stayed in escrow.

### 2. The validators overruled the judge

The third case in that run is the one to read twice. `evaluate` on the revised
deliverable came back:

| | |
|---|---|
| status | `FINALIZED` |
| leader execution | `SUCCESS` |
| consensus | **`MAJORITY_DISAGREE`** — 3 disagree, 2 idle |
| state applied | **none** |

The leader model proposed a verdict. Three validators read the same case file,
judged that verdict against the same criteria, and refused it. Consensus went
against the leader, **so the transaction wrote nothing at all** — the commission
is still sitting at `submitted` with no verdict on it.

That is `prompt_non_comparative` working exactly as specified: the validators did
not write a competing verdict, they judged the leader's and voted it down. It is
the property the whole design rests on, and it fired unprompted on the third try.

It is also the sharpest trap in the API. A transaction can be **finalized**, with
the leader's own execution **successful**, and change nothing, because the
committee disagreed. Our driver reported that case as a success with a
mysteriously empty verdict until we read the consensus field. `applied()` in
`scripts/lib/studio.mjs` is the three-part check; the docstring there is the
warning we wish we had read first.

### Why the earlier runs rejected the same brief

Runs 1–3 rejected this brief, and it took four runs to understand why. Every
rejection was a defect on our side of the wire — a field the payload carried and
the rendered case file dropped. The reaction counts, then the section headings,
then the rest of the evidence row. Once the case file showed the whole row, the
same brief was accepted.

### 3. How stable is that verdict? Measured: 8 / 1 / 1

The obvious objection to a single accepted run is that an LLM committee might
say anything. So the identical case file, with identical terms, was judged **ten
times** on one contract (`0xD08455a5Cfc53E43731834d6C92a6FE4aA0b3B75`,
`transcripts/stability.json`). Nothing varied but the validators and models the
network assigned.

| Outcome | Count |
|---|---|
| ACCEPTED | **8** |
| REJECTED | 1 |
| No verdict (MAJORITY_DISAGREE, no state applied) | 1 |

Ten different leader assignments across kimi, gemma, mistral, gemini-3-flash,
sonnet, gpt-oss, gemini and claude-sonnet-4.6. Read it as three separate facts:

**The verdict is directional, not deterministic.** Eight in ten is a strong
signal and it is not a guarantee. The same model, kimi, rejected on run 3 and
accepted on run 9, so this is not even stable per model.

**The one rejection was defensible and it found a *different* sentence.** Not the
engagement numbers this time. It objected that P1's "Anthropic reversed course"
is an interpretation of E7's headline rather than something E7 states: *"there is
no explicit statement of 'reversed course' … in the cited evidence."* That is
strict, and it is not wrong. The brief has more than one sentence sitting on the
line, which is the honest finding.

**One judgement in ten produced no verdict at all.** The committee voted the
leader down and the commission stayed at `submitted`. This is not an error state
to be engineered away; it is the protocol refusing to settle, and any product
built on this needs a resubmit-or-appeal path rather than a spinner.

Validator dissent was routine: five of the ten committees carried at least one
disagree vote even while reaching MAJORITY_AGREE.

**What this means for the demo.** Showcase `fixtures/payload-corrected.json`, not
the brief as written. The corrected deliverable removes the marginal engagement
claim, and the same discipline should be applied to the "reversed course"
sentence before filming. An 80% verdict is a great finding to *talk about* and a
poor thing to *depend on* live.

---

## What worked

### Direct-mode tests — 42 passing, no server, ~5 seconds

```bash
pytest tests/direct/ -q
```

They pin the escrow lifecycle, the structural refusals, the digest binding, the
citation audit, judge misbehaviour, the reclaim path, and that the validator is
shown the leader's verdict against the same case file. The model is mocked;
everything around the judgement is real.

### Studionet — deployed, escrowed, judged, finalized

Three runs, all against `https://studio.genlayer.com/api`, chain `61999`, with
throwaway accounts created by `createAccount()` and funded from the built-in
faucet over `sim_fundAccount`.

#### Run 4 — the current contract, `transcripts/run-4-full-case-file.json`

Contract `0xc5808632a9571Fb9E01680305c6afAc58EddC195`.

| Case | Verdict | State applied | Consensus | Leader model |
|---|---|---|---|---|
| as-written | **ACCEPTED**, bounty released | yes | MAJORITY_AGREE (3 agree, 2 idle) | `openrouter/anthropic/claude-sonnet-4.6` |
| revised | none | **no** | **MAJORITY_DISAGREE** (3 disagree, 2 idle) | `llm-router/policy:prd-gpt-5-4` |
| mutated | **INSUFFICIENT_EVIDENCE** | yes | MAJORITY_AGREE (3 agree, 2 disagree) | `llm-router/policy:prd-gemini` |

Ledger: client 1000 → 700, deliverer 1 → **101**, contract holding 200 against
the two unreleased commissions.

Ten transactions, ten different leader assignments across `gemini-3-flash`,
`claude-sonnet-4.6`, `gpt-5.4`, `glm`, `minimax`, `gemma`, `qwen` and the router
policies. Nothing in the contract chooses a model.

#### Run 3 — the three cases, `transcripts/run-3-three-cases.json`

Contract `0x948aE88576ca72390dd02Fd0D76F374fB7ABB1a5`. Total wall clock 7m 55s.

| Case | Verdict | `evaluate` tx | Leader model | Validator votes |
|---|---|---|---|---|
| as-written | REJECTED | `0xa376ea39…9ea03c97` | `llm-router/policy:prd-gpt-oss` | 3 agree, 2 idle |
| revised | REJECTED | `0x6b50409a…5f77a56d39` | `llm-router/policy:prd-sonnet` | 3 agree, 2 idle |
| mutated | **INSUFFICIENT_EVIDENCE** | `0x63604bbb…4a685c73452` | `llm-router/policy:prd-qwen` | 3 agree, **2 disagree** |

Three things in that table are worth more than the verdicts.

**All three verdicts are reachable, and the contract discriminates between
them.** The mutated deliverable came back INSUFFICIENT_EVIDENCE rather than
REJECTED, with exactly the right reasons — *"P2 cites no evidence"* and *"P3
cites E31, which is not in the evidence list"* — which is the distinction the
verdict enum exists to make. Missing evidence is not the same finding as a false
claim, and the judge kept them apart without being told which case it was
looking at.

**A different model judged each transaction.** gpt-oss, sonnet and qwen, inside
one run, routed by the network. That is the equivalence principle's whole
premise made visible, and it is also why verdict *wording* is not reproducible.

**The validators genuinely disagreed on the mutated case** — 3 agree, 2 disagree,
recorded on chain. Consensus was reached, and the dissent is in the receipt.

The escrow ledger for the run: the client went 1000 → 700, the contract held
300, the deliverer stayed at 1. Three bounties locked, nothing accepted, nothing
paid out.

#### Runs 1 and 2 — the ones that found the bugs

Kept deliberately. `transcripts/run-1-terms-mismatch.json` is the first live
deployment (`0x27E0E610…`), and its rejections are the reason three of the
"what was rough" entries below exist. Every rejection across runs 1–3 turned out
to be a defect on our side of the wire, not a defect in the judge:

| Run | Judge said | It was right because |
|---|---|---|
| 1 | Cited evidence contains no reaction counts | The payload builder was dropping `reactions`/`comments` from the rows |
| 1 | Deliverable does not state which sources failed | The criterion asked the *prose* to do what DASH renders itself |
| 2 | Deliverable does not include fetch receipts | It shipped eight; the judge had to notice them rather than be told |
| 3 | Deliverable lacks subject headings | It had five; the case file carried them and did not print them |
| 3 | Cited evidence contains no reaction counts | The rows carried them; the case file printed only headline and summary |

The pattern is one thing said five ways, and it is the main engineering lesson of
the spike: **a field the payload carries and the case file hides does not exist
as far as the judge is concerned, and the claim resting on it is genuinely
unsupported.** The fix each time was to render the whole row and to state the
deterministic facts in a ground-truth block.

**Which contract each run judged.** Runs 1–3 judged the contract *before* the
last two fixes; their remaining rejections say so in as many words. Run 4 judged
the contract as it stands in this repository, and accepted the brief. The 42
direct tests cover that version, and `fixtures/case-file-sample.txt` is its
complete output for the as-written case, so anyone can read exactly what the
judge is handed.


### Timings, measured

| Step | to ACCEPTED | to FINALIZED |
|---|---|---|
| deploy | 5.2 s | 34 s |
| `open_commission` (payable) | 4.6 s | 33 s |
| `submit_deliverable` (21 KB payload) | 4.6 s | 34 s |
| `evaluate` (LLM judgement) | 18–90 s | 50–123 s |

The appeal window on Studionet is **30 seconds** (`sim_getFinalityWindowTime`
returns `30`), which is most of the gap between accepted and finalized. Nothing
appealed during these runs, so the window is measured but the appeal path is
**not exercised** — see "What was rough".

Studionet is gasless. `estimateTransactionFeesForWrite` was never needed and no
fee was reported; `genlayer-js@1.1.8` has no fee parameters at all — those are
v2.0.0-rc.1 / Consensus v0.6, which pairs with Studio-dev on chain 61997, not
Studionet.

### The escrow moves

Run 4 released it: the deliverer's balance went from 1 to **101** on ACCEPTED,
and the two non-accepted commissions left their bounties in the contract. Run 3,
where nothing was accepted, is the mirror image — client 1000 → 700, contract
holding all 300, deliverer untouched.

Studio simulates balances in a local database, in whole units, with no EVM layer
and no ghost contracts — the GenLayer docs state this directly. **So the release
is proven in Studio's simulation, not against a real chain-layer ghost
contract.** Bradbury would prove that, and did not happen tonight.

---

## What was rough

**1. The equivalence principle is not testable in direct mode, out of the box.**
`gl.eq_principle.prompt_non_comparative` does not call `gl.nondet.exec_prompt`.
It issues `{'ExecPromptTemplate': {'template': 'EqNonComparativeLeader', ...}}`
so node operators can tune the judging prompt without a contract change — which
is the whole reason to use it. `gltest`'s direct VM handles `ExecPrompt` and has
no branch for `ExecPromptTemplate`: the call falls through, returns `None`, and
the contract receives `null`. `mock_llm` never fires. Every `gl.eq_principle.*`
function is affected. `tests/direct/conftest.py` shims it in about 20 lines and
documents the gap. **This is worth reporting upstream.**

**2. Direct mode is broken on Windows.** `gltest/direct/loader.py` writes the
entry message to a temp file, `dup2`s it onto fd 0, then unlinks the path.
POSIX allows unlinking an open file; Windows raises `PermissionError [WinError
32]`, and every direct test fails inside the framework before reaching the
contract. Shimmed in `conftest.py`, Windows-only, upstream-reportable.

**3. The direct-mode SDK downloader 404s.** It resolves the newest GenVM release
(`v0.3.0-rc7`) and fetches `genvm-universal.tar.xz` from it; that asset is not
there. `genvm-lint download` fetches the same artifact successfully into a
*different* cache. Copying one file across unblocks it. Separately,
`genvm-lint download` itself crashes on a Windows console after a complete
download — `'charmap' codec can't encode '✓'` — so it needs `PYTHONUTF8=1`.

**4. Nondeterminism is visible and it is at the model layer.** The leader model
differed between transactions in the same run: `llm-router/policy:prd-kimi` on
one case, `prd-gemini` on another. That is the equivalence principle doing its
job, but it means **verdict wording is not reproducible** and the same
deliverable can draw differently-worded reasons on different runs. The verdict
enum was stable across our runs; the reasons were not.

**4b. The judge can also be wrong, and there is no appeal wired up.** Run 3
rejected the revised deliverable partly on this: *"P2 describes OpenClaw as 'a
renaming of a product previously called Moltbot', but E4's title 'OpenClaw –
Moltbot Renamed Again' indicates Moltbot was renamed again to OpenClaw, not that
OpenClaw was renamed from Moltbot."* Those are the same fact. The judge
misparsed a headline and produced a confident, specific, wrong reason. This is
the case the appeal path exists for, and we did not exercise it — which makes
appeals the highest-value thing to add next, not a nice-to-have.

**5. The judge is strict in ways the terms must anticipate.** Run 2 rejected an
honest deliverable for "not including fetch receipts" — it shipped eight of
them, in their own section of the case file, but the judge had to *notice* them
rather than being told. The fix was to state the deterministic facts in the
CITATION AUDIT block as ground truth. A criterion the judge has to infer is a
criterion it will sometimes decide was unmet. Likewise our first acceptance
criteria asked the *prose* to state what was set aside — something DASH
deliberately renders itself, outside the brief. **Writing the terms is a real
design task, not boilerplate.**

**6. Hosted Studio is flaky under a multi-transaction script.** One run died
when an RPC answered with an HTML error page, surfacing as
`Unexpected token '<'` from viem's JSON parser rather than as anything the SDK
recognises. Rate limits (60/min, 1000/hr, `-32429`) look similar. Both clear.
`scripts/lib/studio.mjs` now retries transient failures with backoff. Anything
driving Studionet for a demo needs this.

**7. Reading the receipt correctly is the trap.** Three fields answer three
different questions and it is very easy to collapse them:

| Field | Question | Where it lives |
|---|---|---|
| `status` | did it reach a decision? | `status_name` |
| execution result | did the leader's call succeed? | `consensus_data.leader_receipt[0].execution_result` |
| consensus result | did the committee accept the leader? | `result_name` |

Reading the third as the second reports a failed call as a success (cost us two
runs). Reading the first two and ignoring the third reports a transaction that
**changed nothing** as a success (cost us the revised case in run 4). A write can
be FINALIZED, with SUCCESS execution, and apply no state, because consensus was
MAJORITY_DISAGREE. `applied()` in `scripts/lib/studio.mjs` is the three-part
check. Anything driving GenLayer needs it before it needs anything else.

**8. Verdict stability is 80%, and one run in ten returns nothing.** Measured, not
guessed: ten judgements of the identical case file gave 8 ACCEPTED, 1 REJECTED, 1
no-verdict. See "How stable is that verdict?" above. Two consequences for anyone
building on this. A borderline claim will flip, so terms and deliverables have to
be written to sit clearly inside the evidence rather than at its edge. And a
judgement that applies no state is a normal outcome at roughly one in ten, so the
calling application needs a resubmit path, not a retry loop that assumes an
answer is coming.

**8b. Judgement latency is wildly variable.** Across those ten, `evaluate` took
between **16 and 249 seconds** to reach accepted, and between 45 and 281 seconds
to finalize. The whole ten-judgement run took 30 minutes. Budget for the tail,
not the median, and never demo against a fixed timeout.

**9. Not done tonight, and it should be said:** no appeal was filed, so the
appeal economics and the recomputation path are unexercised — which matters more
after run 4, because we now have a live case (MAJORITY_DISAGREE, no state) whose
only remedy *is* the appeal path. Nothing ran on Bradbury, so no real
chain-layer value transfer and no real fee. No `--fee-profile` was measured.
GLSim and local Studio were skipped — Studionet was faster to a real answer than
Docker would have been.

---

## Verdict: **GO**

The thesis survived contact with the network, and it survived in the strongest
possible way: the honest deliverable was rejected on a real defect that the
receipts proved. A demo where the judge catches a frontier model overstating its
own evidence, on chain, against the agent's own audit trail, is a better story
than any acceptance would have been — and we have the acceptance too, from the
revision.

The build is small because DASH already produces the hard part. There is no new
data model to invent: `artifact_version: 2` briefs, index-bound paragraphs,
`derived_from.items_digest`, and `sources_fetched` already exist and already
ship. The hackathon work is a broker operation, an MCP registry component, and a
demo.

Cost to reach a submittable entry: **three sessions**, against a deadline of
**17 September 15:30 UTC**.

### The three-session plan

**Session 1 — the DASH side: `genlayer.adjudicate`.**
One broker operation, following `lib/broker/operations.ts`' four-part rule: a
card sentence in the user's words (*"have this brief judged on GenLayer"*), an
unchanged scope list, a request shape carrying only `commission_id`, the
deliverable payload and the terms, and a projection that returns
`{verdict, reasons[]}` and nothing an author could fill. One connection kind
(`genlayer`, holding an RPC endpoint and a contract address — **no key**: the
throwaway account is created per run). One Output-stage receipt line, so the
verdict appears where every other piece of evidence appears. The payload builder
is `scripts/dash-brief-to-payload.mjs` in this repo, ported; `lib/brief/
fingerprint.ts` is already the other half of it.

**Session 2 — the MCP side: `onchain_adjudication`.**
A registry component in OrchestrateKit-MCP, so a plan that produces a
deliverable can route it to adjudication and the planner can say what it costs
and what it risks. Edges into the existing evidence components. This is what
makes it a *pattern* rather than one app's feature — and the MCP's own CI gate
already checks the DASH vocabulary, so the component's language stays honest.

**Session 3 — the demo and the entry.**
First: tighten the showcase deliverable so no sentence sits on the evidence's
edge, then re-run the three cases and record the address. Then record the video,
write the portal application, submit. Video script below. Budget a full session — the
run takes 6–10 minutes of wall clock, Studio's speed varies by an order of
magnitude, and the narration is the deliverable. Add an appeal to the demo if
session 2 finishes early: a wrong verdict being overturned on chain is a better
90 seconds than a correct verdict standing.

Buffer: two of the three sessions have hard external dependencies (Studionet
availability, the panel's own uptime near the deadline). Start session 1 within
a week of 4 September.

---

## Portal application — draft

Everything here is ready to paste, except the two decisions marked for Henrik.

**Project name:** BriefAcceptance
*(alternative if a longer name reads better on a card: "BriefAcceptance — evidence-bound work, judged on chain")*

**Track:** Onchain Justice
*(matches the track's own first listed idea: "Agentic marketplace disputes. Escrow released when a deliverable meets machine-readable terms.")*

**One-paragraph pitch:**

> Agent marketplaces have no way to settle "did the agent actually do the work?"
> — so a human reads the output and guesses. BriefAcceptance makes the question
> answerable. A client opens a commission with machine-readable terms and locks a
> bounty. A supervised agent submits its deliverable together with the provenance
> its runtime generated while producing it: every paragraph bound by index to the
> evidence it was written from, every source it fetched with the ones that failed,
> and a digest the contract re-derives from the submitted bytes. GenLayer's
> validators judge the prose against that audit trail and release the escrow, or
> refuse it with reasons that name the paragraph and the evidence. It runs today
> on Studionet against a real brief from a real agent: the bounty was released on
> acceptance, a falsified version of the same brief was refused with all three of
> its planted defects named, and on a third case the validators overruled the
> leader's proposed verdict and the transaction applied nothing — consensus doing
> the job it exists for. The differentiator is the input, not the judge: the
> deliverer is a supervised agent whose deliverable ships with runtime-generated
> provenance the judge can check, not prose it has to trust.

**Live on Studionet:** contract `BriefAcceptance`, chain 61999, at
`0xc5808632a9571Fb9E01680305c6afAc58EddC195` — deployed, escrowed and judged. The
brief was accepted and **100 GEN moved to the deliverer**; a deliberately
falsified version of the same brief was refused as INSUFFICIENT_EVIDENCE with all
three of its planted defects named; and on a third case the validator committee
overruled the leader's verdict outright, so the transaction finalized and applied
no state. Full transcripts with transaction hashes are in the repo.

**Links:**
- Repo: https://github.com/orchestratemcp/brief-acceptance (public)
- Explorer: `https://explorer-studio.genlayer.com`
- Demo video: *(session 3)*

**Video script (about 2 minutes):**

1. *0:00* — A brief on screen that reads perfectly. "An agent wrote this. Would you pay for it?"
2. *0:15* — The commission: terms in plain language, bounty locked on chain.
3. *0:30* — The submission: the same brief, but every paragraph carrying its evidence indices, the reaction counts and dates on each row, and the two sources that never answered.
4. *0:50* — `evaluate()` runs. Wait on the real appeal window; do not cut it.
5. *1:00* — **ACCEPTED**, with the judge naming the evidence behind each paragraph. The deliverer's balance moves 1 → 101.
6. *1:20* — The falsified version. **INSUFFICIENT_EVIDENCE**, all three planted defects named, bounty stays in escrow.
7. *1:40* — The case the demo is really about: a run where the validators **overruled** the leader's verdict and the transaction applied nothing. "The judge doesn't get the last word either."
8. *1:55* — Close on the differentiator sentence.

Shoot case 3 from a recorded transcript if it will not reproduce live — it is a
consensus outcome, not something the contract can force.

---

## Open questions — only Henrik can answer these

**1. Which brief goes in the showcase, and is this one publishable?**
The fixture is your real competitor brief: OpenClaw and Hermes Agent, from the
scout's 2026-08-20 run. Everything in it is a summary of public posts, and it
contains no credential, path or private data — but publishing it does tell the
world what you watch, and this repo has to be public to be submitted. Swap it
for the `ai-agent-news` scout's output if you would rather not. The pipeline does
not care which brief it is given; only the fixture changes.

**2. Does the escrow demo move GEN, or stay verdict-only?**
Today it moves GEN on Studionet, where balances are simulated in Studio's local
database with no EVM layer and no ghost contract. Proving a real value transfer
means Bradbury, a funded account, and a faucet claim that cannot be automated
(Cloudflare Turnstile — you would have to click it). Verdict-only on Studionet is
honest and needs nothing from you. Real GEN on Bradbury is a stronger demo and
costs you one faucet claim plus the risk of a slower, less reliable network on
video. **Recommendation: keep Studionet for the demo, and say on screen that the
transfer is simulated.** Overclaiming here is the one thing that would cost us
the panel's trust.

**3. Cross-chain settlement was ruled out of scope tonight — does it stay out?**
Releasing to Base or Ethereum is a genuine GenLayer capability and would widen
the story. It is also a second integration in a 13-day window. Recommendation:
stays out; mention it as future work in the application.

---

## Running it

```bash
git clone <this repo> && cd agent-tank
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
npm install
```

```bash
PYTHONUTF8=1 .venv/Scripts/genvm-lint check contracts/brief_acceptance.py
```

```bash
PYTHONUTF8=1 .venv/Scripts/python -m pytest tests/direct/ -q
```

```bash
npm run payloads
```

```bash
node scripts/studionet-run.mjs --bounty 100 --out transcripts/my-run.json
```

The Studionet run needs no key and no funding. It creates two throwaway accounts
and claims from the built-in faucet. Nothing in this repository reads a keystore,
a vault, or any credential.

### Layout

| Path | What it is |
|---|---|
| `contracts/brief_acceptance.py` | The contract. One file. |
| `tests/direct/` | 39 direct-mode tests, plus the two documented framework shims. |
| `scripts/dash-brief-to-payload.mjs` | DASH brief + digest → on-chain payload. Re-checks the fingerprint. |
| `scripts/studionet-run.mjs` | The live run. Writes a transcript. |
| `scripts/lib/studio.mjs` | genlayer-js helpers, retry, receipt reading. |
| `fixtures/commission-terms.json` | The machine-readable terms. One copy, shared by tests and driver. |
| `fixtures/dash-brief-competitor-scout.json` | The real DASH brief and its digest, as exported. |
| `transcripts/` | What actually happened, with transaction hashes. |

### One design note worth reading

The payload carries **no addresses**. DASH's rule is that model-authored prose
can never carry a link, because the model is never sent one; the evidence rows
keep that property on chain by carrying a receipt id — `<digest artifact>#<n>` —
instead of a URL. The receipt resolves back to a row in the run DASH holds. The
judge can check a claim against the row; a model cannot mint one. A test asserts
that no `http://` or `https://` ever reaches the case file.

---

*Built for the GenLayer Agent Tank hackathon. MIT licensed. The contract pins
runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.*
