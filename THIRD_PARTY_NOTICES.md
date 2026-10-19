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
