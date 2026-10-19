# Third-Party Notices

AgentForge's Best-of-N mode (`src/main/bestofn.ts`, `src/renderer/BonView.tsx`) was written from scratch.
The projects below were read as design references only; no source code was copied from them.
They are listed here to credit the ideas that informed the design.

## parallel-code
- Source: https://github.com/johannesjo/parallel-code
- License: MIT, Copyright (c) 2026 Johannes Millan
- Referenced ideas: one git worktree + branch per agent task, diff review in the UI, merge of the chosen branch followed by worktree/branch cleanup.

## omp-best-of
- Source: https://github.com/wolfiesch/omp-best-of
- License: MIT, Copyright (c) 2026 Wolfgang Schoenberger
- Referenced ideas: create all isolated candidate workspaces from one base before starting, run candidates concurrently and collect every outcome, re-check that the parent checkout did not move before applying the winner, keep per-candidate artifacts.
  (Its automatic verifier-based winner selection was intentionally not adopted: AgentForge lets the user choose.)

## Planner (계획 도우미)
The planner (`src/shared/planner.ts`, `src/main/planner.ts`, `src/renderer/PlannerPanel.tsx`) was written from scratch. The projects and products below were read as design references only; no source code was copied from them.

### agent-orchestrator (Orchestrator.inc)
- Source: https://github.com/OrchestratorInc/agent-orchestrator
- License: Apache-2.0
- Referenced ideas: a planning/coordination agent that does not implement itself, scoped to a project and told to inspect current state before delegating; delegated work items get short readable labels; explicit user restrictions are carried over to delegated work. (Its automatic task spawning without a human gate was intentionally not adopted: AgentForge creates a task only after the user confirms.)

### Superset
- Source: https://github.com/superset-sh/superset
- License: Elastic License 2.0 (source-available, not an OSI open-source license). Only its public documentation and README were read; no code was taken.
- Referenced ideas: a structured completion envelope that carries next-step context, and a coordinator table of work items.

### Amp (Sourcegraph), "handoff"
- Reference: https://ampcode.com/news/handoff (documentation only; closed source)
- Referenced idea: generate a draft starting prompt for a new thread from the current context and let the user review and edit it before it is sent.
