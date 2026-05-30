# Setting up the Claude Autonomous Loop

This guide wires up a **self-perpetuating** Claude development loop that:

1. Implements a labeled issue,
2. Reviews its own work and fixes findings,
3. Commits **directly to `dev`** (no PR needed),
4. Plans the next best step toward the deployable MVP described in
   [`README.md`](../README.md), and
5. Opens the next issue (tagging `@claude`, labeled `claude-auto`) — which
   re-triggers the loop.

The process Claude follows each iteration is defined in
[`.github/AUTONOMOUS_LOOP.md`](../.github/AUTONOMOUS_LOOP.md).

---

## One-time setup

1. **Create the `dev` branch** (the loop integrates here):

   ```bash
   git checkout main && git pull
   git checkout -b dev
   git push -u origin dev
   ```

2. **Create the `claude-auto` label**:

   ```bash
   gh label create claude-auto \
     --description "Triggers the Claude autonomous development loop" \
     --color 5319e7
   ```

3. **Add the workflow file** below as `.github/workflows/claude-autonomous.yml`.

   > Claude (the GitHub App) cannot create files under `.github/workflows/`,
   > so this step must be done by a human (or a token with `workflow` scope).

4. Ensure the `ANTHROPIC_API_KEY` repository secret is set (the existing
   `claude.yml` already uses it).

---

## The workflow file

Save this as `.github/workflows/claude-autonomous.yml`:

```yaml
name: Claude Autonomous Loop

on:
  issues:
    types: [labeled]

# Prevent overlapping iterations of the loop.
concurrency:
  group: claude-autonomous
  cancel-in-progress: false

jobs:
  autonomous:
    # Only run when an issue gets the `claude-auto` label.
    if: github.event.label.name == 'claude-auto'
    runs-on: ubuntu-latest
    permissions:
      contents: write        # commit/push to dev
      issues: write          # comment, close, and create follow-up issues
      pull-requests: write
      id-token: write
    steps:
      - name: Checkout dev branch
        uses: actions/checkout@v6
        with:
          ref: dev
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Run Claude Autonomous Loop
        uses: anthropics/claude-code-action@main
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # Automation mode: run from a direct prompt (no @claude mention needed).
          prompt: |
            You are running the Governor OS autonomous development loop.

            REPOSITORY:   ${{ github.repository }}
            ISSUE_NUMBER: ${{ github.event.issue.number }}
            ISSUE_TITLE:  ${{ github.event.issue.title }}
            BRANCH:       dev

            Follow the process in .github/AUTONOMOUS_LOOP.md EXACTLY, in order:
              1. Implement the issue above (smallest deployable MVP increment).
              2. Review your own diff and fix every finding.
              3. Commit and push DIRECTLY to the `dev` branch (no pull request).
              4. Comment the result on issue #${{ github.event.issue.number }}
                 and close it if fully resolved.
              5. Decide the next best step toward the MVP in README.md and open a
                 NEW issue for it with `gh issue create`, tagging @claude in the
                 body and applying the `claude-auto` label so this loop continues.

            Never push to `main`. Keep each iteration small and shippable.
          claude_args: |
            --model claude-sonnet-4-6
            --max-turns 40
            --allowedTools "Bash,Edit,Write,Read,Glob,Grep"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Starting the loop

Create (or label) an issue to kick things off:

```bash
gh issue create \
  --title "Bootstrap MVP: <first step>" \
  --label claude-auto \
  --body "@claude plan and implement the first MVP increment."
```

From then on, each iteration ends by opening the next `claude-auto` issue, so the
loop continues on its own. Remove the `claude-auto` label (or close issues
without a follow-up) to stop it.

## Notes & caveats

- **`GITHUB_TOKEN` and recursive triggers:** issues created by the default
  `GITHUB_TOKEN` do **not** trigger further workflow runs. To make the loop fully
  self-perpetuating, create the follow-up issues with a **Personal Access Token
  (PAT)** or **GitHub App token** that has `issues: write`, and pass it to the
  step as `GH_TOKEN`. With the default token you'll get one iteration per manual
  label.
- **Cost & safety:** `--max-turns` and the `concurrency` group bound runaway
  loops. Review `dev` periodically and merge to `main` via a normal PR when you
  want to cut a release.
- **Workflow edits:** Claude cannot modify `.github/workflows/**`; adjust this
  file by hand.
