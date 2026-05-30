# Automated Release Compliance Governor

A lightweight GitHub Action that checks every published release against a basic
compliance checklist — and prepares the bridge to premium, AI-driven ISO 27001 /
SOC 2 / DORA auditing.

- **Free tier** (no license key): runs a fully local checklist on the release
  notes and logs a summary to the job console + the GitHub job summary.
- **Premium tier** (with `license-key`): prepares a secure bridge to the hosted
  audit backend. *(Transmission is stubbed in this MVP — no data leaves the runner yet.)*

## Usage

```yaml
name: Release Compliance
on:
  release:
    types: [published]

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: markgrendev/automated-release-compliance-action@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # license-key: ${{ secrets.COMPLIANCE_LICENSE_KEY }}  # enables premium tier
          # fail-on-incomplete: "true"                          # hard-gate the release
```

## Inputs

| Input                | Required | Default          | Description                                                                 |
| -------------------- | -------- | ---------------- | --------------------------------------------------------------------------- |
| `github-token`       | yes      | `${{ github.token }}` | Token used to read release/repo context.                               |
| `license-key`        | no       | `""`             | Premium license key. When set, prepares the hosted-backend audit bridge.    |
| `fail-on-incomplete` | no       | `"false"`        | When `"true"`, fails the workflow if the free-tier checklist does not pass. |

## Outputs

| Output   | Description                                            |
| -------- | ------------------------------------------------------ |
| `passed` | `"true"` if all checklist items passed.                |
| `score`  | Passed-over-total, e.g. `"2/3"`.                       |
| `tier`   | Which tier ran: `"free"` or `"premium"`.               |

## Free-tier checklist

1. Release notes contain a description of the changes.
2. Release notes link to an issue, pull request, or ticket.
3. Release notes are not an empty/placeholder body.

## Project layout

```
action.yml          Action metadata + input/output contract
src/index.js        Entry point: parses the release event, routes free vs premium
src/checklist.js    Free-tier, fully-local compliance rules
src/premium.js      Premium bridge stub (payload shaping; no transmission yet)
dist/index.js       Bundled output that the action actually runs (built via ncc)
test/               Unit tests (run with `npm test`)
```

## Development

```bash
npm install      # install @actions/core, @actions/github, ncc
npm test         # run the unit tests
npm run build    # bundle src/ -> dist/ (commit dist/ so the action runs without install)
```

> **Note:** `dist/index.js` must be built and committed for the action to run on
> the marketplace. Run `npm run build` after changing anything under `src/`.

## Roadmap

The premium backend will perform AI-driven ISO control mapping over the commits
and PRs in a release, generate signed PDF evidence reports, and optionally block
releases on critical compliance risk.
