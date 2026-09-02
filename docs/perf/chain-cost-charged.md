# chain-cost-charged — CU of the charged shot (tag 7, five bytes)

Date: 2026-09-03. Instrument: `scripts/spike/cu-charged/` (mollusk-svm 0.15.1), adopted
from A5's scratch harness. Raw output of the tree run: `docs/perf/chain-cost-charged-run.txt`.

**Headline: the charged shot costs the chain one syscall, only when asked for.** `shoot`
reads `Clock::get()?.slot` only when the charged byte is 1 — a plain shot, the auto-fire hot
path, never pays it. Measured on the shipped ELF, `charged = 1` is **+129 CU** over
`charged = 0` on every ray length, and a `NotCharged` refusal (a step inside the hold)
costs **931 CU** and spends nothing on the seat. No per-tick cost moved: `move` and
`boss_tick` are untouched by this slice (`chain-cost-archer.md` already prices both).

## 1. The controlled A/B (A5, same tree snapshot, six files apart)

Base = the snapshot before A5's chain files, cand = after; nothing else differed (boss at
the pre-A1 `(512, 400)`, old hitboxes). Base 116,416 B, cand 117,688 B. Straight-up shots
from under the boss, 64 each, p50 (every run is deterministic, min = p50 = max):

| case | BASE | CAND charged=0 | CAND charged=1 | Δ plain | Δ charged |
|---|---|---|---|---|---|
| point blank | 5,255 | 5,328 | 5,457 | +73 | +202 |
| 120 u hit | 7,575 | 7,658 | 7,787 | +83 | +212 |
| 200 u hit | 9,910 | 10,003 | 10,132 | +93 | +222 |
| full miss | 14,083 | 14,173 | 14,302 | +90 | +219 |
| `NotCharged` refusal (step 5 slots ago) | — | — | 931 | | |
| old 4-byte block on cand | 141 (`InvalidInstructionData`) | | | | |
| new 5-byte block on base | 142 (`InvalidInstructionData`) | | | | |

The plain delta (+73..+93) is the five-byte parse and the `charged_at: Option<u32>` plumb
through `fire()`; the syscall itself is the remaining 129, which is why the plan's literal
"read the Clock unconditionally" was rejected (it would have put +192..+220 on every shot).

## 2. Absolute numbers on the shipped ELF (this run)

`target/deploy/heartrot.so`, 117,928 B, sha256 `b5b72916…0cef19f8`, built with
`HEARTROT_TREASURY=FbDoanj…` on the tree at A10's gate. Same ELF passed as base and cand,
so the BASE rows (4-byte block) are the deploy-order refusal at 141 CU. On the painted rig
a straight-up shot from under the boss crosses the **sealed core** first — an absorb the
chain scores at zero — so the stands aim at the centre of `claws` (`PART_HITBOXES[8]`)
and every accepted shot below landed (64/64), except the deliberate miss:

| case (stand → aim) | charged=0 | charged=1 | Δ |
|---|---|---|---|
| point blank (612,382) → (−32,−127) | 2,968 | 3,097 | +129 |
| 120 u hit (662,472) → (−51,−127) | 6,312 | 6,441 | +129 |
| 200 u hit (712,602) → (−50,−127) | 11,066 | 11,195 | +129 |
| full miss (662,472) → (0,127) | 4,902 | 5,031 | +129 |
| `NotCharged` refusal | | 931 | |
| old 4-byte block | 141 (`InvalidInstructionData`) | | |

A shot's cost follows the ray length (the walk is per tile), which is why the absolute
rows are not comparable with §1's — the map and the rig moved in the same round. The
deltas are the invariant: **+129 for the Clock read, on the charged byte only.**

## 3. What did not move

- `PlayerSlot` 96 B, `Arena` 1,200 B, `LAYOUT_VERSION` 1: the harness pours fixtures from
  the tree's structs and mollusk accepted them against the ELF.
- The refusal path is cheaper than any accepted shot (931 vs 2,968+), so a client that
  races a step with a charged send loses nothing on chain; the client resends uncharged
  once (`App.tsx`).
