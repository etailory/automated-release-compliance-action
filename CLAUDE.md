# CLAUDE.md

Repo-specific guidance for Claude when working in this repository.

## Product

This repo builds **Governor OS (ComplianceSuite)** — see [`README.md`](README.md).
It is a unified Product/Engineering/Quality platform for regulated industries
(Fintech, MedTech, GovTech) under ISO 27001, SOC2, and DORA. The current
priority is a **deployable MVP usable by real companies**, not feature breadth.

## Repository layout

- `action/` — GitHub Action ("Trojan Horse") for friction-free onboarding (node20, OIDC).
- `web/` — Express API server for premium audit-trail generation.
- `src/` — TypeScript compliance-checklist library (Bun): `types.ts`, `checklist.ts`,
  `index.ts`, `premium.ts`.
- `dist/` — bundled output from `bun run build`.
- `test/` — `bun:test` TypeScript unit tests.

## Commands

```bash
bun install          # install root deps
bun test             # TypeScript unit tests (src/ library, scoped to test/)
bun run build        # bundle src/index.ts -> dist/index.js

cd action && npm install   # action deps
cd web && npm install      # web server deps
cd web && node --test server.test.js  # Express API integration tests
```

Before committing changes to `src/`, run `bun test` and `bun run build` and
commit the refreshed `dist/` output.

## Conventions

- TypeScript is strict (`tsconfig.json`: `strict: true`, `moduleResolution: bundler`).
  Put shared interfaces in `src/types.ts`.
- Use conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`...).
- Treat this as a regulated-industries product: data integrity, auditability,
  and access control are first-class concerns in every change.

## Branching

- `main` — released/stable. Never push directly here from automation.
- `dev` — integration branch for autonomous and iterative work.

## Autonomous loop

When triggered via the `Claude Autonomous Loop` workflow (issues labeled
`claude-auto`), follow [`.github/AUTONOMOUS_LOOP.md`](.github/AUTONOMOUS_LOOP.md)
exactly: implement → self-review & fix → commit to `dev` → plan the next best
MVP step → open the next `claude-auto` issue tagging `@claude`.

## Permission note

Claude (GitHub App) **cannot modify `.github/workflows/**`**. Workflow changes
must be described for a human to apply.
