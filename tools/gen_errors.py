#!/usr/bin/env python3
"""Compile the `heartrot_errors!` table in the program into the client's copy.

    python3 tools/gen_errors.py

`programs/heartrot/src/error.rs` is the map. This tool is the only thing allowed
to write `packages/client/src/errors.ts`; that file carries a "generated" banner
and hand-editing it recreates the exact defect this project keeps paying for --
one fact stored twice, drifting. The discriminants are wire ABI: a Pinocchio
program ships no IDL, so a number typed out by hand in TypeScript is a promise
nothing checks, and the first appended variant breaks it silently.

error.rs's own module header specifies this output: each variant's number is the
`= n` in the macro and its message the first sentence of its doc comment.

Everything below fails loudly, mirroring the `codes_are_frozen` test on the Rust
side: strictly ascending from 1, never above `HIGHEST_ISSUED`, and every variant
documented.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ERROR_RS = ROOT / "programs" / "heartrot" / "src" / "error.rs"
OUT_TS = ROOT / "packages" / "client" / "src" / "errors.ts"

MACRO_OPEN = "heartrot_errors! {"
VARIANT = re.compile(r"^\s{4}(\w+) = (\d+),\s*$")
HIGHEST = re.compile(r"^const HIGHEST_ISSUED: u32 = (\d+);\s*$", re.M)


class GenError(Exception):
    """A table defect. Always fatal -- see the module docstring."""


def die(msg: str) -> None:
    raise GenError(msg)


def prose(doc_lines: list[str]) -> str:
    """The first sentence of a rustdoc comment, as plain text.

    Rustdoc markup is stripped rather than rendered: backticks go, `*emphasis*` goes,
    and an intra-doc link `[`Self::NotOnGate`]` collapses to its own text. The
    bracket rule is deliberately narrow -- a path, and nothing else -- because a doc
    sentence also contains real brackets, and eating those turns
    `[b"crank-executor", arena.crank_authority]` into a seed list with no seeds.
    The result is one line a browser can show a player.
    """
    text = " ".join(line.strip() for line in doc_lines).strip()
    text = text.replace("`", "")
    text = re.sub(r"\[([A-Za-z_][A-Za-z0-9_:]*)\]", r"\1", text)
    text = re.sub(r"\*(\S(?:[^*]*\S)?)\*", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Sentence end = a period followed by whitespace, or the end of the doc.
    return re.split(r"(?<=\.)\s", text, maxsplit=1)[0]


def parse(source: str) -> tuple[list[tuple[str, int, str]], int]:
    highest = HIGHEST.search(source)
    if highest is None:
        die("no `const HIGHEST_ISSUED` in error.rs")
    assert highest is not None  # for type checkers; `die` always raises

    lines = source.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == MACRO_OPEN)
    except StopIteration:
        die(f"no `{MACRO_OPEN}` invocation in error.rs")

    variants: list[tuple[str, int, str]] = []
    docs: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("}"):
            break
        stripped = line.strip()
        if stripped.startswith("///"):
            docs.append(stripped[3:])
            continue
        match = VARIANT.match(line)
        if match is None:
            continue  # blank lines and the retired-code `//` note
        name, code = match.group(1), int(match.group(2))
        if not docs:
            die(f"{name} has no doc comment: it is the client's message for Custom({code})")
        variants.append((name, code, prose(docs)))
        docs = []
    else:
        die("`heartrot_errors!` is not closed by a `}` at column 0")

    if not variants:
        die("`heartrot_errors!` expanded to no variants")

    prev = 0
    for name, code, _ in variants:
        if code <= prev:
            die(f"{name} is numbered {code}, after {prev}: codes must strictly ascend")
        if code > int(highest.group(1)):
            die(f"{name} is numbered {code}, above HIGHEST_ISSUED {highest.group(1)}")
        prev = code

    return variants, int(highest.group(1))


def emit(variants: list[tuple[str, int, str]], highest: int) -> str:
    rows = "".join(
        f"  {code}: {{ name: {json.dumps(name)}, message: {json.dumps(message)} }},\n"
        for name, code, message in variants
    )
    return f'''// @generated from programs/heartrot/src/error.rs by `python3 tools/gen_errors.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the numbers below
// are wire ABI and a Pinocchio program ships no IDL, so a hand-kept table drifts the
// first time a variant is appended and then mislabels every failure a deployed
// browser tab reports. Edit `heartrot_errors!` in error.rs and re-run the command
// above.
/**
 * `HeartrotError` -- the program's `ProgramError::Custom(n)` codes, by number.
 *
 * Only the game-rule codes live here. Conditions the Solana runtime already names
 * ({{@link https://docs.rs/solana-program/latest/solana_program/program_error/enum.ProgramError.html | `MissingRequiredSignature`, `InvalidSeeds`, ...}})
 * are not duplicated, so a `Custom` code absent from this table came from another
 * program in the transaction, not from a rule of ours.
 *
 * Read it through {{@link decodeTransactionError}} rather than indexing it directly.
 */

/** One row: the variant's Rust name and the first sentence of its doc comment. */
export interface HeartrotErrorInfo {{
  readonly name: string;
  readonly message: string;
}}

/**
 * Live codes only. Retired numbers are absent by construction -- they are not in the
 * macro -- so a lookup miss is the honest answer for one, and {{@link HEARTROT_ERROR_HIGHEST}}
 * is what separates "retired" from "newer program than this client".
 */
export const HEARTROT_ERRORS: Readonly<Record<number, HeartrotErrorInfo>> = {{
{rows}}};

/**
 * Highest code the program has ever issued, live or retired. A `Custom` code above
 * this one cannot be a `HeartrotError` at all: the deployed program is newer than
 * this client, or the failure came from a different program.
 */
export const HEARTROT_ERROR_HIGHEST = {highest};
'''


def main() -> int:
    try:
        variants, highest = parse(ERROR_RS.read_text(encoding="utf-8"))
        OUT_TS.write_text(emit(variants, highest), encoding="utf-8")
    except GenError as exc:
        print(f"gen_errors: {exc}", file=sys.stderr)
        return 1
    print(f"gen_errors: {len(variants)} codes, highest issued {highest} -> {OUT_TS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
