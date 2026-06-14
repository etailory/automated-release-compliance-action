# Automated Release Compliance Action

> Automated release compliance checklist for GitHub Actions. Checks every release against ISO 27001, SOC 2, and DORA rules and produces a machine-readable audit evidence report.

On every `release: [published]` event, this action evaluates the release against a regulatory compliance checklist, writes a tamper-evident JSON audit report, and renders a pass/fail summary in the GitHub Actions UI.

---

## Quick start

```yaml
name: Release Compliance
on:
  release:
    types: [published]

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: etailory/automated-release-compliance-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          compliance-profile: iso27001
          # Write durable audit evidence and archive it as a CI artifact:
          report-path: compliance-report.json
      - uses: actions/upload-artifact@v4
        with:
          name: release-compliance-report
          path: compliance-report.json
```

---

## Full example with integrity verification

The action emits an `integrity-hash` output — a SHA-256 digest of the report file
written at action time. A second workflow job can re-download the artifact and
re-hash it to prove the artifact has not been tampered with between upload and audit.

A complete, copy-pasteable example is in
[`.github/examples/release-compliance.yml`](.github/examples/release-compliance.yml).
The key pattern is a two-job workflow:

```yaml
jobs:
  check:
    outputs:
      integrity-hash: ${{ steps.compliance.outputs.integrity-hash }}
    steps:
      - id: compliance
        uses: etailory/automated-release-compliance-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          compliance-profile: iso27001
          report-path: compliance-report.json
      - uses: actions/upload-artifact@v4
        with:
          name: release-compliance-report
          path: compliance-report.json
          retention-days: 90

  verify:
    needs: check
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: release-compliance-report
      - name: Verify SHA-256 integrity hash
        env:
          EXPECTED_HASH: ${{ needs.check.outputs.integrity-hash }}
        run: |
          ACTUAL_HASH=$(sha256sum compliance-report.json | awk '{ print $1 }')
          if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
            echo "INTEGRITY CHECK FAILED: compliance report has been tampered with."
            exit 1
          fi
          echo "Integrity check passed."
```

---

## Compliance profiles

| Profile | Framework | Extra rules |
|---------|-----------|-------------|
| `default` | Generic | Release notes, semantic versioning, linked issues/PRs, changelog section, deployment sign-off |
| `iso27001` | ISO 27001 | `default` + security review check (maps to A.12.1.2, A.14.2.2, A.14.2.8) |
| `soc2` | SOC 2 | `default` + testing evidence check (maps to CC8.1) |
| `dora` | DORA | `default` + risk/impact assessment check (maps to Art.9, Art.10) |

Custom org-specific rules can be layered on top of any profile via `custom-rules-path`.

---

## Audit evidence (`report-path`)

Set the optional `report-path` input to have the action write a schema-versioned,
machine-readable JSON compliance report. Archive it as a CI artifact and an auditor
can later prove a release was checked against the checklist at publish time.

```jsonc
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-05-31T12:00:00.000Z",
  "tool": { "name": "automated-release-compliance-action", "version": "1.0.0" },
  "tier": "free",
  "repository": "acme/widgets",
  "release": { "tag": "v1.2.0", "name": "Spring Release", "isPrerelease": false, "isDraft": false, "publishedAt": "2026-05-30T00:00:00Z", "author": "octocat", "url": "https://github.com/acme/widgets/releases/tag/v1.2.0" },
  "compliance": { "passed": true, "score": 5, "total": 5, "checks": [
    { "id": "has-description", "label": "Release notes contain a description of the changes", "ok": true, "controlRef": "CTRL-1" },
    { "id": "has-issue-reference", "label": "Release notes link to an issue, pull request, or ticket", "ok": true, "controlRef": "CTRL-2", "evidence": ["#42"] },
    { "id": "not-placeholder", "label": "Release notes are not an empty or auto-generated placeholder", "ok": true, "controlRef": "CTRL-3" },
    { "id": "has-changelog-section", "label": "Release notes include a changelog or 'What's Changed' section heading", "ok": true, "controlRef": "CTRL-4", "evidence": ["## What's Changed"] },
    { "id": "meets-min-length", "label": "Release notes are at least 80 characters", "ok": true, "controlRef": "CTRL-5" }
  ] },
  "commits": { "count": 12, "authors": ["octocat", "codercat"], "firstSha": "abc1234", "lastSha": "def5678" },
  "integrityHash": "a3f1e2b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2"
}
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | `${{ github.token }}` | Token used to read release and repository context. |
| `compliance-profile` | No | `default` | One of `default`, `iso27001`, `soc2`, `dora`. An unrecognised value fails the workflow. |
| `report-path` | No | — | Path to write the JSON compliance report. Omit to skip. |
| `fail-on-incomplete` | No | `false` | Fail the job if the checklist does not pass. |
| `custom-rules-path` | No | — | Path to a JSON file of additional org-specific rules to merge with the selected profile. |

## Outputs

| Output | Description |
|--------|-------------|
| `passed` | `'true'` if all checklist items passed, otherwise `'false'`. |
| `score` | Items passed out of total (e.g. `5/5`). |
| `profile` | Compliance profile that was evaluated: `'default'`, `'iso27001'`, `'soc2'`, or `'dora'`. |
| `report-path` | Path of the written JSON report, if `report-path` input was provided. |
| `integrity-hash` | SHA-256 hex digest of the compliance report artifact. Only set when `report-path` is provided. |

---

## Development

The `src/` library and tests are written in **TypeScript**. Bun handles transpilation natively.

```bash
bun install          # install root dependencies
bun test             # run TypeScript unit tests via bun:test
bun run build        # bundle src/index.ts -> dist/index.js (node target)
bun run lint         # run ESLint + TypeScript linting
```

### Project layout

```
src/                TypeScript compliance checklist library (Bun)
  types.ts          Shared TypeScript interfaces
  checklist.ts      Compliance rules per profile
  index.ts          Action entry point
  context.ts        Release/event context parsing
  commits.ts        GitHub API commit metadata fetcher
  messages.ts       Profile-aware failure messages
  report.ts         Audit-evidence report builder
  summary.ts        GitHub job summary renderer
  custom-rules.ts   Custom rules loader
dist/               Bundled output built via bun build
test/               Unit tests (bun:test, TypeScript)
tsconfig.json       TypeScript compiler configuration
eslint.config.js    ESLint configuration
action.yml          Action metadata (points to dist/index.js)
CHANGELOG.md        Version history
LICENSE             MIT License
```

### TypeScript

- Source: `src/*.ts` — strict TypeScript with shared interfaces in `src/types.ts`
- Tests: `test/*.test.ts` — `bun:test` with typed assertions
- Config: `tsconfig.json` — `moduleResolution: bundler`, `strict: true`
- Build: Bun bundles the TypeScript entry point directly; no intermediate `.js` output in `src/`
