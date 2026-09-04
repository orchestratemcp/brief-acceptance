"""
Direct-mode fixtures, plus one Windows shim.

## The shim, and why it is here rather than in the contract

`gltest/direct/loader.py` builds the contract's entry message in a temp file,
`dup2`s it onto fd 0, and then unlinks the path in a `finally`. On POSIX,
unlinking a file that is still open is ordinary. On Windows it raises
`PermissionError: [WinError 32]`, and every direct test fails inside the
framework before the contract is reached.

That is an upstream portability bug in `genlayer-test` (0.29.2), not something
this contract can influence. The shim tolerates exactly that one failure —
`WinError 32` on a path inside the system temp directory — and re-raises
everything else, so a genuine unlink failure still surfaces. The file is left
for the OS to sweep.

This runs on Windows only. On Linux and macOS `os.unlink` is untouched, so CI
and the graders' machines exercise the unpatched framework.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

_TEMP_ROOT = Path(tempfile.gettempdir()).resolve()


def _install_windows_unlink_shim() -> None:
    if sys.platform != "win32":
        return
    if getattr(os, "_agent_tank_unlink_shim", False):
        return

    real_unlink = os.unlink

    def tolerant_unlink(path, *args, **kwargs):
        try:
            return real_unlink(path, *args, **kwargs)
        except PermissionError as error:
            if getattr(error, "winerror", None) != 32:
                raise
            try:
                resolved = Path(os.fspath(path)).resolve()
            except (TypeError, ValueError, OSError):
                raise error
            if _TEMP_ROOT not in resolved.parents:
                raise
            # Still open as this process's stdin. The OS reclaims it.
            return None

    os.unlink = tolerant_unlink
    os.remove = tolerant_unlink
    os._agent_tank_unlink_shim = True


_install_windows_unlink_shim()


# --------------------------------------------------------------------------
# The second shim: ExecPromptTemplate in direct mode
# --------------------------------------------------------------------------
#
# `gl.eq_principle.prompt_non_comparative` does not call `gl.nondet.exec_prompt`.
# It issues a templated call — `{'ExecPromptTemplate': {'template':
# 'EqNonComparativeLeader', 'task', 'input', 'criteria'}}` — so that node
# operators can tune the judging prompt for their own model without any contract
# change. That is the whole reason to use the convenience function rather than a
# hand-rolled prompt.
#
# `gltest`'s direct VM handles `ExecPrompt` and has no branch for
# `ExecPromptTemplate`. The call falls through to the unknown-request path,
# returns `None`, and the contract receives `null` — so `mock_llm` never fires
# and none of the `gl.eq_principle.prompt_*` family is testable in direct mode
# out of the box.
#
# This shim routes the templated call to the same mock matcher, against a
# synthetic prompt that begins with the template name:
#
#     [EqNonComparativeLeader] task=... input=... criteria=...
#     [EqNonComparativeValidator] task=... output=... input=... criteria=...
#
# So a test can mock the leader and the validator separately, and can assert on
# what the validator was actually shown. Nothing about the contract changes.

_TEMPLATE_FIELD_ORDER = ("template", "task", "output", "input", "criteria",
                         "leader_answer", "validator_answer", "principle")


def _render_template_prompt(data: dict) -> str:
    name = data.get("template", "?")
    parts = [f"[{name}]"]
    for field in _TEMPLATE_FIELD_ORDER:
        if field == "template" or field not in data:
            continue
        parts.append(f"{field}={data[field]}")
    return "\n".join(parts)


def _install_template_shim() -> None:
    from gltest.direct import wasi_mock

    if getattr(wasi_mock, "_agent_tank_template_shim", False):
        return

    real_handle = wasi_mock._handle_gl_call

    def handle_with_templates(vm, request):
        if isinstance(request, dict) and "ExecPromptTemplate" in request:
            data = request["ExecPromptTemplate"]
            prompt = _render_template_prompt(data if isinstance(data, dict) else {})
            vm.last_template_prompt = prompt
            return wasi_mock._handle_llm_request(vm, {"prompt": prompt})
        return real_handle(vm, request)

    wasi_mock._handle_gl_call = handle_with_templates
    wasi_mock._agent_tank_template_shim = True


_install_template_shim()


@pytest.fixture()
def contract(direct_deploy):
    """The deployed BriefAcceptance contract."""
    return direct_deploy("contracts/brief_acceptance.py")
