# 02: The shared resume-report module

Status: done
Type: task

**What to build:** `herdr/mods/tab-tree/resume-report.js`, following the format in the spec ("The resume report"). It imports nothing from `"herdr"`.

- `parseReport(raw)`: a fully validated report, or null. Empty is null.
- `resumeLine(report)`: `cd '<cwd>' && '<argv[0]>' '<argv[1]>' …`, using `shellQuote`.
- `proofHeld(report, readHead)`: whether the proof file exists and its first 4 KB contain `session`. `readHead` is injected, because the mod reads files with `exec` and the stand-in with its own sys layer.
- `legacyReport(labels)`: a report built from `herdr.pi-recovery`, or from `herdr.claude-session` + `herdr.claude-options`, with the same argv the old recipes build today. Proof is the Pi session file, or the Claude transcript found by the existing search.
- `reportOf(labels)`: `herdr.resume` if it's valid, else `legacyReport`.

**Done when:** unit tests cover every rule in the format table, plus the legacy adapter for both agents. `node --test` passes.
