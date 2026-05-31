# Autonomous Development Loop

This document defines the **self-perpetuating development process** Claude follows
when triggered by the `Claude Autonomous Loop` workflow (see
`.github/workflows/claude-autonomous.yml`). The goal is to drive the repository
toward the product vision in [`README.md`](../README.md) — **Governor OS**, the
unified Product/Engineering/Quality compliance platform — by shipping a usable
**MVP that can be deployed and used by real companies**, one issue at a time.

The loop intentionally works **directly on the `dev` branch** so that no pull
request is required between iterations.

---

## Trigger

The loop runs when an issue is **labeled `claude-auto`**. The issue body
describes the unit of work to implement.

## The process (run top to bottom, every iteration)

### 1. Set up
- You are checked out on the `dev` branch. Stay on it — do **not** create a
  feature branch.
- Read `README.md` to re-anchor on the product goal and the MVP priority.
- Read the triggering issue (number provided in the prompt) to understand the
  task to implement.

### 2. Implement the issue
- Implement the smallest correct change that satisfies the issue and moves the
  MVP forward. Favour deployable, real-world-usable increments over breadth.
- Add or update tests (`bun test`) and keep the build green (`bun run build`).
- Follow the conventions in `CLAUDE.md`.

### 3. Review & self-correct
- Review your own diff for bugs, security issues, and compliance-domain
  correctness (this is a regulated-industries product — treat data integrity,
  auditability, and access control as first-class).
- Fix every finding you raise. Re-run tests and the build until clean.
- If a finding is out of scope for this issue, capture it as a follow-up
  (see step 5) rather than leaving it silently unaddressed.

### 4. Commit to `dev` (no PR)
- Commit with a clear, conventional message referencing the issue
  (e.g. `feat: add audit-trail endpoint (#5)`).
- Push **directly to `dev`**. Do not open a pull request.
- Comment the result on the triggering issue and close it if fully resolved.

### 5. Plan the next best step toward the MVP
- With the README vision in mind, decide the single **next best step** that most
  advances a deployable MVP for real companies. Prefer steps that:
  1. Make an existing slice end-to-end usable before adding new slices.
  2. Unblock deployment (config, packaging, docs, CI).
  3. Reduce compliance/audit risk for the target industries.
- Write the plan as a concrete, scoped issue: clear outcome, acceptance
  criteria, and any files likely involved.

### 6. Create the next issue (continues the loop)
- Create the issue with the GitHub CLI, **tagging `@claude`** in the body and
  applying the `claude-auto` label so this workflow re-triggers automatically:

  ```bash
  gh issue create \
    --title "<concise next-step title>" \
    --label claude-auto \
    --body "$(cat <<'EOF'
  @claude plan and implement

  ## Goal
  <how this advances the deployable MVP from README.md>

  ## Acceptance criteria
  - [ ] ...

  ## Notes
  <files / context>
  EOF
  )"
  ```

- This new issue's `claude-auto` label fires the workflow again, continuing the
  loop without human intervention.

## Guardrails
- **Never** push to `main`. All autonomous work lands on `dev`.
- Keep each iteration small and shippable; one issue → one focused commit set.
- If you cannot proceed safely (ambiguous requirements, destructive change,
  missing secret), stop and explain on the issue instead of guessing.
- Respect the workflow permission boundary: you cannot edit
  `.github/workflows/**` — if a change there is needed, describe it in the issue
  for a human to apply.
