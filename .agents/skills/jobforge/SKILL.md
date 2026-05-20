---
name: JobForge
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
arguments: mode # Claude Code specific
user-invocable: true
argument-hint: "[scan | deep | pdf | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | update]"
license: MIT
---

# JobForge -- Router

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `interview-prep` | `interview-prep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |

**Auto-pipeline detection:** If `$mode` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `$mode` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
JobForge -- Command Center

Available commands:
  /JobForge {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /JobForge pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /JobForge oferta    → Evaluation only A-F (no auto PDF)
  /JobForge ofertas   → Compare and rank multiple offers
  /JobForge contacto  → LinkedIn power move: find contacts + draft message
  /JobForge deep      → Deep research prompt about company
  /JobForge interview-prep → Generate company-specific interview prep doc
  /JobForge pdf       → PDF only, ATS-optimized CV
  /JobForge training  → Evaluate course/cert against North Star
  /JobForge project   → Evaluate portfolio project idea
  /JobForge tracker   → Application status overview
  /JobForge apply     → Live application assistant (reads form + generates answers)
  /JobForge scan      → Scan portals and discover new offers
  /JobForge batch     → Batch processing with parallel workers
  /JobForge patterns  → Analyze rejection patterns and improve targeting
  /JobForge followup  → Follow-up cadence tracker: flag overdue, generate drafts

Inbox: add URLs to data/pipeline.md → /JobForge pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `interview-prep`, `training`, `project`, `patterns`, `followup`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="JobForge {mode}"
)
```

Execute the instructions from the loaded mode file.
