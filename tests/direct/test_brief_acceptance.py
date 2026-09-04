"""
Direct-mode tests for BriefAcceptance.

These run in-process with no server and no network. The model is mocked, so what
they pin is everything around the judgement: the escrow lifecycle, the structural
refusals, the digest binding, the citation audit the judge is handed as ground
truth, and what happens to the money on each of the three verdicts.

The two payload fixtures are built from one REAL DASH brief — the competitor
scout's run of 2026-08-20, written by anthropic/claude-sonnet-5 over a 53-item
digest with 8 fetch receipts — by `scripts/dash-brief-to-payload.mjs`. The
mutated one differs from the honest one in three deliberate ways and nothing
else.
"""

import hashlib
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
CONTRACT = "contracts/brief_acceptance.py"

# One copy of the terms, shared with `scripts/studionet-run.mjs`, so what the
# tests pin is what the network judge is actually shown.
_TERMS = json.loads((FIXTURES / "commission-terms.json").read_text(encoding="utf-8"))
ASKED = _TERMS["asked"]
CRITERIA = _TERMS["acceptance_criteria"]
EVIDENCE_RULES = _TERMS["evidence_requirements"]


def load_payload(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture()
def accepted_payload() -> dict:
    return load_payload("payload-accepted.json")


@pytest.fixture()
def mutated_payload() -> dict:
    return load_payload("payload-mutated.json")


@pytest.fixture()
def revised_payload() -> dict:
    return load_payload("payload-corrected.json")


def judge(direct_vm, verdict: str, reasons: list[str]) -> None:
    """Mock the leader's judging model."""
    direct_vm.mock_llm(
        r"\[EqNonComparativeLeader\]",
        json.dumps({"verdict": verdict, "reasons": reasons}),
    )


def open_and_submit(contract, direct_vm, payload, *, sender, bounty: int = 0) -> str:
    direct_vm.sender = sender
    direct_vm.value = bounty
    cid = payload["commission_id"]
    contract.open_commission(cid, ASKED, CRITERIA, EVIDENCE_RULES)
    direct_vm.value = 0
    contract.submit_deliverable(cid, payload["brief_digest"], payload["deliverable_json"])
    return cid


# ---------------------------------------------------------------- commission


def test_open_commission_records_the_machine_readable_terms(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)

    state = contract.get_commission("c1")
    assert state["status"] == "open"
    assert state["asked"] == ASKED
    assert state["acceptance_criteria"] == CRITERIA
    assert state["evidence_requirements"] == EVIDENCE_RULES
    assert state["client"].lower() == direct_alice.as_hex.lower()
    assert contract.list_commissions() == ["c1"]


def test_open_commission_holds_the_bounty(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 7 * 10**18
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    assert contract.get_commission("c1")["bounty"] == 7 * 10**18


def test_a_commission_id_cannot_be_reused(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    with direct_vm.expect_revert("commission already exists"):
        contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)


# --------------------------------------------------------------- deliverable


def test_submitting_the_real_dash_brief(contract, direct_vm, direct_alice, direct_bob, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    direct_vm.sender = direct_bob
    contract.submit_deliverable  # bound; the submission above stands

    state = contract.get_commission(cid)
    assert state["status"] == "submitted"
    assert state["digest_verified"] is True
    assert state["brief_digest"] == accepted_payload["brief_digest"]


def test_the_digest_must_match_the_bytes(contract, direct_vm, direct_alice, accepted_payload):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    wrong = hashlib.sha256(b"a different document").hexdigest()
    with direct_vm.expect_revert("brief_digest does not match"):
        contract.submit_deliverable("c1", wrong, accepted_payload["deliverable_json"])


def test_the_digest_must_look_like_a_digest(contract, direct_vm, direct_alice, accepted_payload):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    with direct_vm.expect_revert("brief_digest must be a sha256"):
        contract.submit_deliverable("c1", "not-a-digest", accepted_payload["deliverable_json"])


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ('{"paragraphs": [], "evidence": []}', "paragraphs must be a non-empty list"),
        ('{"evidence": []}', "paragraphs must be a non-empty list"),
        ('{"paragraphs": [{"body": "x"}]}', "evidence must be a list"),
        ('{"paragraphs": [{"items": [0]}], "evidence": []}', "paragraph 1 has no body"),
        ('{"paragraphs": [{"body": "x", "items": ["a"]}], "evidence": []}', "must be a list of non-negative"),
        ('{"paragraphs": [{"body": "x", "items": [-1]}], "evidence": []}', "must be a list of non-negative"),
        ('{"paragraphs": [{"body": "x"}], "evidence": [{"no": "headline"}]}', "evidence 1 has no headline"),
        ("not json at all", "not valid JSON"),
        ('["a", "list"]', "must be a JSON object"),
    ],
)
def test_a_malformed_deliverable_is_refused(contract, direct_vm, direct_alice, payload, message):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    with direct_vm.expect_revert(message):
        contract.submit_deliverable("c1", digest, payload)


def test_a_deliverable_cannot_replace_one_already_submitted(contract, direct_vm, direct_alice, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    with direct_vm.expect_revert("commission is not open"):
        contract.submit_deliverable(cid, accepted_payload["brief_digest"], accepted_payload["deliverable_json"])


# ---------------------------------------------------------------- case file


def test_the_case_file_carries_the_citation_audit_and_no_addresses(
    contract, direct_vm, direct_alice, accepted_payload
):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    case_file = contract.get_case_file(cid)

    assert "=== COMMISSION (machine-readable terms) ===" in case_file
    assert "=== CITATION AUDIT" in case_file
    assert "=== DELIVERABLE" in case_file
    assert "=== EVIDENCE" in case_file
    assert "=== FETCH RECEIPTS" in case_file
    assert "Every paragraph cites at least one evidence item" in case_file
    assert "Digest verified by the contract against the submitted bytes: yes" in case_file

    # The unreachable sources travel too: a judge must be able to see that DASH
    # asked eight sources and two did not answer.
    assert "status=unreachable" in case_file

    # DASH's rule, kept on-chain: the model is never shown an address.
    assert "http://" not in case_file
    assert "https://" not in case_file


def test_the_case_file_states_the_fetch_receipts_as_ground_truth(
    contract, direct_vm, direct_alice, accepted_payload
):
    """
    Studionet run 2 rejected a deliverable for "not including fetch receipts"
    that shipped eight of them, because the judge had to notice a section
    further down rather than being told. The audit states it.
    """
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    case_file = contract.get_case_file(cid)
    assert "The deliverable ships 8 fetch receipts." in case_file
    assert "2 source(s) did not answer" in case_file
    assert "OpenClaw on Reddit" in case_file


def test_the_case_file_renders_every_recorded_evidence_field(
    contract, direct_vm, direct_alice, accepted_payload
):
    """
    Studionet run 3 rejected a deliverable because "none of the cited evidence
    contains any reaction counts". The rows carried them; this block printed the
    headline and nothing else. A field the case file hides does not exist as far
    as the judge is concerned.
    """
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    case_file = contract.get_case_file(cid)

    first = accepted_payload["deliverable"]["evidence"][0]
    assert f"reactions={first['reactions']}" in case_file
    assert f"comments={first['comments']}" in case_file
    assert f"published_at={first['published_at']}" in case_file
    assert f"receipt={first['id']}" in case_file
    # Every scalar on every cited row travels.
    for item in accepted_payload["deliverable"]["evidence"]:
        for key, value in item.items():
            if key in ("id", "source_name", "headline", "summary") or value is None:
                continue
            if isinstance(value, (dict, list)):
                continue
            assert f"{key}={value}" in case_file


def test_the_case_file_renders_the_subject_headings(contract, direct_vm, direct_alice, accepted_payload):
    """
    Studionet run 3 rejected a deliverable for having no subject headings. It had
    five; this renderer was carrying them and not drawing them. A case file that
    omits a field the acceptance criteria ask about will lose on it.
    """
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    case_file = contract.get_case_file(cid)

    headings = [p["section"] for p in accepted_payload["deliverable"]["paragraphs"]]
    for heading in dict.fromkeys(headings):
        assert f"## {heading}" in case_file
    assert f"organised under {len(dict.fromkeys(headings))} subject heading(s)" in case_file


def test_a_paragraph_section_must_be_a_string(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    payload = json.dumps(
        {"paragraphs": [{"body": "x", "items": [0], "section": 7}], "evidence": [{"headline": "y"}]}
    )
    with direct_vm.expect_revert("section must be a string"):
        contract.submit_deliverable("c1", hashlib.sha256(payload.encode("utf-8")).hexdigest(), payload)


def test_a_deliverable_with_no_fetch_receipts_is_named_as_such(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    payload = json.dumps(
        {"paragraphs": [{"body": "A claim.", "items": [0]}], "evidence": [{"headline": "A receipt."}]}
    )
    contract.submit_deliverable("c1", hashlib.sha256(payload.encode("utf-8")).hexdigest(), payload)
    assert "The deliverable ships NO fetch receipts." in contract.get_case_file("c1")


def test_the_revised_deliverable_is_the_brief_with_one_sentence_repaired(
    accepted_payload, revised_payload
):
    """
    The revision is narrow on purpose: one sentence, in one paragraph, and the
    citations are untouched. Anything wider would mean the second verdict was
    about a different document.
    """
    original = accepted_payload["deliverable"]
    revised = revised_payload["deliverable"]

    assert [p["items"] for p in original["paragraphs"]] == [p["items"] for p in revised["paragraphs"]]
    assert original["evidence"] == revised["evidence"]
    differing = [
        index
        for index, (a, b) in enumerate(zip(original["paragraphs"], revised["paragraphs"]))
        if a["body"] != b["body"]
    ]
    assert differing == [0]
    assert "well over a thousand reactions" in original["paragraphs"][0]["body"]
    assert "well over a thousand reactions" not in revised["paragraphs"][0]["body"]
    assert revised["revision"]["of"] == accepted_payload["commission_id"]


def test_the_revised_deliverable_can_be_accepted(contract, direct_vm, direct_alice, revised_payload):
    cid = open_and_submit(contract, direct_vm, revised_payload, sender=direct_alice, bounty=100)
    judge(direct_vm, "ACCEPTED", ["Every paragraph's claims are within its cited evidence."])
    assert contract.evaluate(cid) == "ACCEPTED"
    assert contract.get_commission(cid)["status"] == "accepted"


def test_the_case_file_names_an_uncited_paragraph(contract, direct_vm, direct_alice, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice)
    case_file = contract.get_case_file(cid)
    assert "cites no evidence" in case_file
    assert "which is not in the evidence list" in case_file


def test_there_is_no_case_file_before_a_deliverable(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    assert contract.get_case_file("c1") == ""


# ----------------------------------------------------------------- verdicts


def test_accepted_releases_the_bounty_to_the_deliverer(
    contract, direct_vm, direct_alice, direct_bob, accepted_payload
):
    direct_vm.sender = direct_alice
    direct_vm.value = 5 * 10**18
    cid = accepted_payload["commission_id"]
    contract.open_commission(cid, ASKED, CRITERIA, EVIDENCE_RULES)

    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.submit_deliverable(cid, accepted_payload["brief_digest"], accepted_payload["deliverable_json"])

    judge(direct_vm, "ACCEPTED", ["P1 is supported by E1, E2, E3, E7.", "Both projects are covered."])
    assert contract.evaluate(cid) == "ACCEPTED"

    state = contract.get_commission(cid)
    assert state["status"] == "accepted"
    assert state["verdict"] == "ACCEPTED"
    assert state["deliverer"].lower() == direct_bob.as_hex.lower()
    assert len(state["reasons"]) == 2


def test_rejected_on_the_mutated_deliverable(contract, direct_vm, direct_alice, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice, bounty=5 * 10**18)
    judge(
        direct_vm,
        "REJECTED",
        ["P1 claims an acquisition and a migration figure that appear in none of E1, E2, E3, E7."],
    )
    assert contract.evaluate(cid) == "REJECTED"
    assert contract.get_commission(cid)["status"] == "rejected"


def test_insufficient_evidence_is_its_own_verdict(contract, direct_vm, direct_alice, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice)
    judge(direct_vm, "INSUFFICIENT_EVIDENCE", ["P2 cites no evidence.", "P3 cites E30, which does not exist."])
    assert contract.evaluate(cid) == "INSUFFICIENT_EVIDENCE"
    assert contract.get_commission(cid)["status"] == "insufficient_evidence"


def test_evaluate_needs_a_deliverable(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.open_commission("c1", ASKED, CRITERIA, EVIDENCE_RULES)
    with direct_vm.expect_revert("nothing to evaluate"):
        contract.evaluate("c1")


def test_a_commission_is_judged_once(contract, direct_vm, direct_alice, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    judge(direct_vm, "ACCEPTED", ["Fine."])
    contract.evaluate(cid)
    with direct_vm.expect_revert("nothing to evaluate"):
        contract.evaluate(cid)


def test_an_unknown_commission_is_refused(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("unknown commission"):
        contract.get_commission("nope")


# ------------------------------------------------------- judge misbehaviour


@pytest.mark.parametrize(
    "reply",
    [
        "the deliverable looks fine to me",
        '{"verdict": "LOOKS_GOOD", "reasons": []}',
        '{"verdict": "accepted-ish", "reasons": []}',
    ],
)
def test_a_judge_reply_that_is_not_a_verdict_stops_the_transaction(
    contract, direct_vm, direct_alice, accepted_payload, reply
):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    direct_vm.mock_llm(r"\[EqNonComparativeLeader\]", reply)
    with direct_vm.expect_revert("[LLM_ERROR]"):
        contract.evaluate(cid)
    # Nothing moved: the commission is still awaiting a judgement.
    assert contract.get_commission(cid)["status"] == "submitted"


def test_a_fenced_json_reply_is_still_read(contract, direct_vm, direct_alice, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    direct_vm.mock_llm(
        r"\[EqNonComparativeLeader\]",
        'Here is my ruling:\n```json\n{"verdict": "ACCEPTED", "reasons": ["ok"]}\n```\n',
    )
    assert contract.evaluate(cid) == "ACCEPTED"


def test_a_single_reason_string_is_accepted(contract, direct_vm, direct_alice, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    direct_vm.mock_llm(
        r"\[EqNonComparativeLeader\]",
        '{"verdict": "REJECTED", "reasons": "P4 overstates what E11 says."}',
    )
    assert contract.evaluate(cid) == "REJECTED"
    assert contract.get_commission(cid)["reasons"] == ["P4 overstates what E11 says."]


# -------------------------------------------------------------- the reclaim


def test_the_client_reclaims_after_a_rejection(contract, direct_vm, direct_alice, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice, bounty=5 * 10**18)
    judge(direct_vm, "REJECTED", ["P1 is unsupported."])
    contract.evaluate(cid)

    direct_vm.sender = direct_alice
    contract.reclaim(cid)
    assert contract.get_commission(cid)["status"] == "reclaimed"


def test_only_the_client_reclaims(contract, direct_vm, direct_alice, direct_bob, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice, bounty=5 * 10**18)
    judge(direct_vm, "REJECTED", ["P1 is unsupported."])
    contract.evaluate(cid)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("only the client can reclaim"):
        contract.reclaim(cid)


def test_an_accepted_bounty_cannot_be_reclaimed(contract, direct_vm, direct_alice, accepted_payload):
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice, bounty=5 * 10**18)
    judge(direct_vm, "ACCEPTED", ["Every paragraph is backed."])
    contract.evaluate(cid)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("bounty is not reclaimable"):
        contract.reclaim(cid)


# ------------------------------------------------------- validator behaviour


def test_the_validator_is_shown_the_leaders_verdict_and_the_same_case_file(
    contract, direct_vm, direct_alice, accepted_payload
):
    """
    The point of `prompt_non_comparative`: the validator does not write a second
    verdict. It runs the same input function and is handed the leader's output to
    judge against the same criteria.
    """
    cid = open_and_submit(contract, direct_vm, accepted_payload, sender=direct_alice)
    judge(direct_vm, "ACCEPTED", ["Backed throughout."])
    contract.evaluate(cid)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r"\[EqNonComparativeValidator\]", "true")
    assert direct_vm.run_validator() is True

    shown = direct_vm.last_template_prompt
    assert shown.startswith("[EqNonComparativeValidator]")
    assert "ACCEPTED" in shown  # the leader's output
    assert "=== CITATION AUDIT" in shown  # the same input function
    assert "The verdict must be one of ACCEPTED" in shown  # the same criteria


def test_a_validator_may_disagree_with_the_leader(contract, direct_vm, direct_alice, mutated_payload):
    cid = open_and_submit(contract, direct_vm, mutated_payload, sender=direct_alice)
    judge(direct_vm, "ACCEPTED", ["Looks fine."])
    contract.evaluate(cid)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r"\[EqNonComparativeValidator\]", "false")
    assert direct_vm.run_validator() is False
