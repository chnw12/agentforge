# AgentForge

**English** · [한국어](README.ko.md)

A **Windows desktop app** that runs [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex) in isolated git worktrees and keeps a human in the loop. You can hand it work in two ways:

- **Pipeline**: design → cross-review → build → verify, with your approval before every stage.
- **Best-of-N**: 2–3 slots implement the same request in parallel; you compare diffs and test results, pick one, and merge it.
- **Planner**: paste the results of earlier work and Claude Code or Codex designs the next task. You review the proposal and decide whether to create the task.

Every agent works only inside its own worktree and `af/<id>` branch. Merging always requires an explicit click from you.

> **Status: early (v0.1.0), Windows only.** The UI is available in English and Korean (**Settings → Language**; the default follows your OS language). Most automated checks were run against fake agents; see [Known limitations](#known-limitations).

## Requirements
- Windows 10/11 and `git`
- `claude.exe` and `codex.exe` installed and logged in. They are resolved from `PATH` as `.exe` files; `.cmd` shims are not supported.
- Your own account or API key for each CLI (see [AI usage notes](#ai-usage-notes)).

## Install
**Installer**: download `AgentForge Setup <version>.exe` from the repository's Releases page and run it. The installer is per-user and lets you choose the install folder.

The installer is **not code-signed**, so Windows SmartScreen may warn you. Choose **More info → Run anyway** if you trust the build, or build it yourself from source (below).

**From source** (Node.js and npm required; developed with Node 24):
```
npm install
npm run dev        # development mode
npm run build      # build to out/
npm run dist       # create the installer in release/ (unsigned)
npm run typecheck
npm test
```

## Quick start
1. Click **+ Add project** and pick a git repository folder.
2. Click **+ Task** next to the project, enter a title and a request, and choose the mode (Pipeline or Best-of-N).
3. Follow the mode-specific flow below.

### Pipeline
You advance each stage with the **Approve and run** button.

| Stage | Agent | Permissions |
|---|---|---|
| 1. Design | Claude | read-only |
| 2. Cross-review | Codex | read-only |
| 3. Build | Claude | edits only inside the worktree |
| 4. Verify | Codex | read-only (receives git-collected facts and the diff) |

- Merge approval is only possible when verification ends with `VERDICT: PASS`. Approval pins the head commit, and the head is re-checked right before merging.
- Merging only happens when you click it, and it is refused if the main checkout has uncommitted changes.
- Before verification, the host runs the project's tests in the worktree (60 s timeout) using `scripts.test` from `package.json` (`npm test`) or `*.test.js` files (`node --test`). A failing, timed-out or erroring test run forces FAIL regardless of what Codex says and blocks merge approval. With no tests, it falls back to "no automated tests, code review only".
- Extra rule: if the diff adds new exported functions or classes to the source without any test file change, the result is FAIL. Docs, config, bug fixes, refactors, internal helpers and renames/moves are excluded; only JS/TS is checked.

### Best-of-N
- Create 2–3 slots and pick an agent (Claude Code or Codex) for each. There is no design stage; every slot implements the same request directly.
- Slots implement in parallel. Their tests run one after another as each slot finishes, so they do not interfere with each other.
- The **slot comparison** table shows status, tests, changed files, +/− lines and elapsed time side by side. "Changed files per slot" shows which slot touched which file, including files only one slot touched.
- Choose the result you like with **Pick this result and merge**. That branch is merged and the other slots' worktrees and branches are cleaned up. A slot whose tests did not run or failed needs you to acknowledge a warning first.
- If a merge conflicts, the merge is aborted and the error is shown. The main branch and the slot worktrees are left as they were.

#### Per-slot control
Agents are one-shot processes, so you cannot inject text into a turn that is already running. Control works like this:

- **Stop**: kills only that slot's process; the other slots keep running.
- **Extra instruction while running**: queued, and run in the same worktree right after the current run ends. Stopping the slot clears the queue.
- **Re-run this slot only (after it ends)**: continues a finished, failed or cancelled slot on top of its existing worktree state (not from scratch), optionally with an extra instruction. Tests run again. Not available while other slots are running.

### Diff viewer and copy
- Per-file collapse/expand, line numbers, add/delete colors, and new/deleted/renamed markers. Large diffs open only the first file, and files over 1,500 lines continue with "show more".
- The copy button at the top right of a slot panel copies the current tab. On the diff tab it copies the raw diff text, without line numbers or other UI elements.

## Planner
A collapsible right-hand panel (`Ctrl+J`) for working out what to do next with an agent. See `docs/DESIGN-planner.md` (Korean) for the design and the research behind it.

1. **Create a thread.** Each project can have planning threads. Choose the agent (Claude Code or Codex).
2. **Collect previous results ("reference material").** Paste results from finished work, or add summaries (status, tests, changed files, final answer) with the ✚ in a slot header, **add selected stage to planner** in a stage view, or **send to planner** in a task header. **Diffs are excluded by default**; use **+ add diff** on an item to include one.
3. **Ask.** Write the request in **what to do next** (the design request to the planner) and press `Ctrl+Enter`. The agent inspects the repository **read-only** (Claude: only the Read/Grep/Glob tools; Codex: read-only sandbox) and returns a proposal.
4. **Proposal card.** Shows a title, the request text for the new task, and the rationale, risks and open questions. The mode the agent recommends (Pipeline or Best-of-N) is preselected. Everything is editable.
5. **Create the task.** The new-task dialog opens prefilled with the proposal, and the task is only created when you press **Create**. Nothing is created or started automatically. Created tasks show a "plan origin" link, and you can send their results back to the planner to continue.

- **Conversation mode**: "continue" resends the earlier conversation each time; "fresh" sends only the reference material. Both exist so you can see which works better. In continue mode your earlier request texts are sent again too.
- Pasted text has secret-looking strings masked first (`[REDACTED]`, with a count) and is limited to 30,000 characters per item and 100,000 in total. Reference material is passed to the agent marked as untrusted data.
- If the proposal format (`af-proposal` JSON) is invalid, no card is created; the raw reply and the error are shown with a button that copies the text into a new task request.
- You get a notification when a request finishes while the window is in the background. Quitting the app stops running requests, and they show as "interrupted" on the next start.

## Skills
Open **Skills** (bottom left, or `Ctrl+K` → "skills") to switch instructions on and off for the agents.

- The two top boxes list skills installed for **Claude** (`~/.claude/skills`) and **Codex** (`~/.codex/skills`, or `CODEX_HOME`). Tick one to turn it on.
- **Personal skills** below are instructions you keep inside the app. Type a name and text, or import a `SKILL.md`/`.md`/`.txt` file, then add it; remove it with ✕. Each personal skill can target Claude, Codex or both.
- The **body text** of every enabled skill is placed before the task request for Pipeline, Best-of-N and the Planner. This works with `--safe-mode` on. Files or scripts a skill refers to are not passed along.
- The prompt tells the agent that the task request's constraints (read-only, output format, the VERDICT line, …) take priority over skills. A model is not guaranteed to obey that.
- Limit: 20,000 characters per skill and 40,000 per agent; anything beyond is left out. Longer skills use more of your quota.

## Notifications and status
- The sidebar shows per-task progress (`Pipeline · stage 2/4`, `Best-of-N · 1/3 slots done`) and elapsed time for running tasks.
- States that need you (choose a result, approve a merge, approve the next stage, merge pending, failed) are marked with a dot and text, and the window title gets a `(count)`. A failure marker disappears once you open that task.
- When a running task starts waiting for you, you get a Windows notification and a taskbar flash (only while the window is in the background). Clicking the notification opens the task. This can be turned off in settings.

## Keyboard shortcuts
| Key | Action |
|---|---|
| `Ctrl+K` | Task search / command palette (title, project, status) |
| `Alt+↑` / `Alt+↓` | Previous / next task |
| `Alt+1` … `Alt+4` | Best-of-N: switch tabs on all slots (diff · tests · summary · log). Pipeline: result · log · diff |
| `Ctrl+N` | New task |
| `Ctrl+J` | Open / close the planner panel |
| `Ctrl+,` | Settings |
| `Ctrl+/` | Shortcut help |
| `Esc` | Close the open dialog |
| `Ctrl+Enter` | Send from the extra-instruction box |

Shortcuts use physical keys (`e.code`), so they work while a Korean IME is active.

## Settings
- Language: Auto (follow the OS), English or 한국어. The change applies immediately. The text of the agent prompts the app builds (planner and skills) follows it, and the planner asks the agent to answer in that language.
- Claude `--safe-mode` (on by default)
- Claude model (empty = Claude Code's default; aliases such as `sonnet`/`opus` or a full model ID are passed as `--model`)
- Codex model (default `gpt-5.6-sol`; empty = Codex's own configured model)
- Model settings apply to Pipeline, Best-of-N and the Planner, from the next run on.
- Stage timeout (default 20 minutes)
- Allowed tools for the build stage (`--allowed-tools`)
- Notifications on/off
- Path to a `rea` executable (RE mode, below)

If the default model in `~/.codex/config.toml` is rejected for your account, change the Codex model in settings.

### RE mode
If you set a `rea` executable (`.exe`) path in settings, the result of `analyze-javascript-application <path> --json` for a pipeline task's analysis target is injected into the design stage. This invocation has not been verified by an actual run in the app yet.

## Deleting
- Task 🗑: after confirmation, runs `git worktree remove` (**without `--force`**) and deletes the branch, then removes the task from the list and logs. Disabled while running. If git refuses (for example because of changes), the error is shown and nothing else happens; use "discard" (forced cleanup) first. Merged tasks are only cleaned up with `branch -d`; the main branch history is untouched.
- Project "remove from list": never touches the original folder or repository. If worktrees remain, it asks whether to clean them up; otherwise they stay in the repository.

## Tests
```
npm test                         # unit and integration tests
$env:AF_E2E = 1; npm test        # PowerShell: also runs the Best-of-N E2E against real claude/codex (spends tokens, takes minutes)
```
- `test/bon-control.test.ts` and `test/planner-run.test.ts` use fake `claude.exe`/`codex.exe` compiled from `test/fixtures/fake-agent.cs` with `csc.exe` to check per-slot stop/queue/re-run and the planner runner (read-only arguments, proposal parsing, failure/cancel, history). They are Windows-only and skip themselves elsewhere.

## AI usage notes
AgentForge has no server and everything runs locally, but the `claude` and `codex` CLIs it launches **send your task text and repository files to an external AI provider (Anthropic, OpenAI)**. Please read this before using it. (Based on the providers' public documentation as of October 2026; terms and policies change. This is not legal advice.)

- **Do not feed it sensitive material.** Agents read files in the worktree and send them out along with your request. Make sure personal data (especially of users or customers), confidential material and credentials are not in the repository or in task requests; use fake test data where needed.
- **Use one account per person.** Each user should log in to `claude`/`codex` with their own account or API key. Sharing one account among several people, or paying on others' behalf, may violate Claude Code's terms. AgentForge runs the CLIs unmodified and never handles your login credentials.
- **In an organization, prefer organization plans over personal ones.** Claude Free/Pro/Max fall under the Consumer Terms; Team/Enterprise/API fall under the Commercial Terms. For ChatGPT/Codex, Business, Enterprise and API data is not used for training by default, while Plus/Pro may be, depending on settings (Codex also has a separate training opt-in setting).
- **On personal plans, check the training setting.** Claude personal plans may use conversations to improve models unless you opt out in account settings.
- **The planner also sends data out.** Pasted material, your request, and the repository files the agent reads go to Anthropic/OpenAI. The panel shows the same warning. Secret-looking patterns are masked, but not perfectly.
- **It burns usage quickly.** Best-of-N runs one agent per slot at the same time. Pro/Max limits assume ordinary individual use.
- **Public institutions and welfare facilities: check your own rules first.** Whether business data or personal information may be entered into an external AI service depends on the institution's security and privacy policy (in Korea, for example, the National Intelligence Service's AI security guidance and the Personal Information Protection Commission's guidance on generative AI). This project has not received any such approval or certification.
- **Review generated code yourself.** Verification and the test gate are not a security audit or a license review. The copyright status of AI-generated code and its similarity to existing code is legally unsettled; check before you distribute.

## Known limitations
- Worktrees and Claude's permission modes are **not a security sandbox.** Use it only on repositories you trust.
- Windows only. Two agents (Claude Code and Codex), and 2–3 Best-of-N slots.
- Re-running a slot continues on top of the existing worktree state; it does not start over.
- Per-slot stop and extra instructions exist only for Best-of-N, not for pipeline tasks.
- Planner: there is no way yet to send the same material to Claude and Codex at once and compare their designs side by side. The quality of the mode recommendation and which conversation mode works better have not been judged sufficiently with real agents. In one small test against real Claude Code and Codex, file creation was refused and a file outside the repository was not read, but it was not established whether Codex's read-only sandbox itself blocks outside reads.
- If verification fails in a pipeline, there is no path to re-run the build stage (discard and create a new task).
- It cannot tell whether existing tests actually exercise a new feature (Codex is asked to check), and since worktrees have no `node_modules`, projects that need dependencies may fail `npm test` (which blocks).
- Default icon; no code signing; no auto-update.
- Verification with real `claude`/`codex` end to end is limited. Most automated and E2E checks use fake agents.
- The English texts were written without a native-speaker review, and the build and verify prompts that go to the agents stay in English or Korean as written (only the planner and skills text follow the UI language). Reports of awkward wording are welcome.

## Project layout
```
src/main/       Electron main: git/worktree, pipeline, Best-of-N runner, planner runner, process management, notifications, state storage
src/preload/    IPC API exposed to the renderer (allow-list)
src/renderer/   React UI: App, BonView, DiffView, Palette, PlannerPanel, SkillsDlg
src/shared/     pure logic shared by main/renderer: types, diff parser, attention rules, search, slot warnings, planner (prompt and proposal parser), skills, i18n (Korean source keys + English table, checked by test/i18n.test.ts)
docs/           design docs (Korean)
test/           vitest tests and the fake-agent fixture
```

## Feedback
This is an early project and I would like to hear about:
- whether the Best-of-N compare-and-merge flow is useful in your own work;
- planner proposals that were wrong or unhelpful;
- anything that breaks on your machine (Windows version, CLI versions, repository type).

Please open an issue. Do not paste secrets or private code into issues.

## License
AgentForge is released under the [MIT License](LICENSE). Keep the copyright notice and license text and you may use, modify and redistribute it, as an individual or an organization. The software is provided "as is", without warranty of any kind.

The installer bundles open-source components such as Electron (including Chromium); their license files are included in the install folder. Projects that informed the design are credited in `THIRD_PARTY_NOTICES.md`. The `claude` and `codex` CLIs are not part of this repository and are governed by their providers' terms.
