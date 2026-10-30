# PurpleFlow — a stage orchestrator for claude and codex, built on OpenSpec

[Русский](README.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [MIT](LICENSE) license

PurpleFlow is a desktop app that walks a coding task through fixed stages: **clarify → plan → approval → implementation → checks → review by another model → acceptance → archive and commit**.

PurpleFlow has no agent of its own. Each stage runs the CLI you already have installed — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or [Codex CLI](https://github.com/openai/codex) (`codex`). PurpleFlow handles orchestration, human approval gates and the UI.

Every task is a single [OpenSpec](https://github.com/Fission-AI/OpenSpec) change. By default it runs in its own git worktree on a `purpleflow/<change-id>` branch, so your working copy stays untouched. You decide when to merge, or open a PR straight from the app.

> The interface, prompts and code comments are in Russian. Issues and pull requests in English are welcome.

## Features

- **Modes:** quick fix, bug (a failing test reproduces the bug first), task, large task (design plus phased implementation), refactoring (checks must be green before and after).
- **Roles:** for planner, executor and reviewer you choose `claude` or `codex` and a model. By default the reviewer is a different model from the executor.
- **Gates:** you approve the plan, answer clarifying questions, and accept the result in a Monaco diff with line comments. From acceptance you can request a quick fix.
- **Checks:** lint and tests run against the run's worktree. They are compared with the base commit, so pre-existing failures are not blamed on the task. Flaky tests are detected and retried.
- **Visual check:** the app from the run's branch starts on a free port. The agent drives a browser and takes screenshots for acceptance.
- **Project knowledge:** a project profile and lessons from past runs are added to every agent's prompt.
- **Run manager and on-the-fly control:** add a note for the executor, pause, restart implementation or go back to the plan.
- **Parallel runs:** a queue with a configurable limit.
- **PRs on GitHub** via `gh`, with CI status and a follow-up round on review comments.
- **Chat:** talk to an agent outside the pipeline and turn the conversation into a task.

## Getting started

You need Node.js ≥ 22.18, git, and the agents:

```bash
npm i -g @anthropic-ai/claude-code @openai/codex @fission-ai/openspec
```

```bash
npm install
```

```bash
npm run dev
```

On first launch the app finds `git`, `claude`, `codex` and `openspec` in your login shell's PATH. You can also point to each tool manually.

The optional PurpleSchool account provides an AI proxy for `claude` and `codex`. Without an account, the agents run on your own subscriptions.

## Building

```bash
npm run dist:mac -w @purpleflow/app
```

`dist:win` and `dist:linux` work the same way. The output goes to `app/release/`. Signing and notarization settings are described in the Russian README, in the «Сборка» section.

## Development

```bash
npm run check
```

This runs typecheck, ESLint, Prettier and tests, the same as CI. The pipeline tests drive a whole run on a temporary git repository with real git and openspec and fake agents. They need neither `claude` nor `codex` and finish in seconds.

A sample project to try a run on:

```bash
npm run make-sample -- ~/purpleflow-sample
```

## Repository layout

```
core/       orchestrator core, plain TypeScript, no Electron
  src/      kernel → stages/ + services/ → engine → orchestrator (see ARCHITECTURE.md)
  prompts/  stage prompts and the reviewer's JSON schema
app/        Electron + electron-vite + React; the core runs in a utilityProcess
examples/   sample projects for trying runs end to end
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the process model, the core's layers and the IPC contract. The architecture doc is in Russian; the diagrams and file names should be easy to follow.
