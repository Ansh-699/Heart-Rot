# Resuming the full-screen / archer workflow

Run `wekeq0uy7` (`wf_604db45b-bfe`), launched 2026-09-02. 37 agents.
Full-screen no-pan scenes, boss relighting, archer class + visible arrows,
working spacebar, gate transition, draggable telemetry.

## Where the state lives (written automatically, nothing to do)

| what | where |
|---|---|
| every agent's return value | `~/.claude/projects/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/subagents/workflows/wf_604db45b-bfe/journal.jsonl` |
| per-agent transcripts (37 MB) | same directory, `agent-*.jsonl` |
| the workflow script | `~/.claude/projects/-home-anshtyagi-Documents-pixel-artgame/0170737a-3afb-4aa1-86f7-94a879050eb1/workflows/scripts/heartrot-fullscreen-archer-wf_604db45b-bfe.js` |
| the actual code | this working tree — agents edit files in place |

## Resume

```
Workflow({
  scriptPath: ".../heartrot-fullscreen-archer-wf_604db45b-bfe.js",
  resumeFromRunId: "wf_604db45b-bfe",
})
```

Agents whose (prompt, opts) are unchanged replay from cache; edited or new
calls re-run. Stop the prior run first if it is still going.

**Caveat that matters: the resume cache is SAME-SESSION only.** If this session
ends, `journal.jsonl` is still readable and every agent's result is recoverable
from it, but a `resumeFromRunId` will not replay from cache — it re-runs.

## Reading results without resuming

```
python3 - <<'PY'
import json
J='.../wf_604db45b-bfe/journal.jsonl'
for ln in open(J):
    r=json.loads(ln)
    if r.get('type')=='result': print(r['result'])
PY
```

The specs the run produced are checked into the repo and survive independently:
`docs/architecture/12..17-*.md`, `docs/art/*.md`, `docs/perf/er-baseline.md`.
