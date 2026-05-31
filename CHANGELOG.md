# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-31

### Added

- **Compliance checklist engine** with four selectable profiles via the `compliance-profile` input:
  - `default` — 5 core rules covering release notes, semantic versioning, linked issues/PRs, changelog reference, and deployment sign-off
  - `iso27001` — extends `default` with a security review check (ISO 27001 alignment)
  - `soc2` — extends `default` with a testing evidence check (SOC 2 alignment)
  - `dora` — extends `default` with a risk/impact assessment check (DORA alignment)
- **Regulatory control references** — each checklist rule maps to a specific framework control ID (e.g. `A.12.1.2`, `CC8.1`, `Art.9`) surfaced in the report for auditor traceability
- **Machine-readable JSON audit report** (`report-path` input) — schema-versioned `ComplianceReport` written to a configurable path, suitable for archiving as a CI artifact for auditors
- **SHA-256 integrity hash** (`integrity-hash` output) — tamper-evidence hash of the compliance report, embedded in the artifact and surfaced as an action output
- **GitHub job summary** — per-rule pass/fail status rendered in the Actions UI job summary after each run
- **`fail-on-incomplete` gate** — optional hard step failure when the compliance checklist does not fully pass (defaults to warn-only)
- **Profile-aware failure messages** — when `fail-on-incomplete` is `true`, the failure message lists the specific rules that blocked the release for the active profile
- **Commit metadata enrichment** — release reports include commit count, unique committer authors, and full commit SHAs sourced from the GitHub API for traceability
- **Custom rules path** (`custom-rules-path` input) — extend any built-in profile with org-specific controls defined in a local JSON file; the path is recorded in the audit report for full traceability
- **Action outputs**: `passed`, `score`, `profile`, `report-path`, `integrity-hash`
- **Free tier** local checklist evaluation with no external dependencies beyond `secrets.GITHUB_TOKEN`
- **ESLint + TypeScript linting** via `bun run lint` (replaces placeholder script)

### Changed

- Removed legacy `action/` subdirectory (stale duplicate of root action)
- Updated `action.yml` description to reflect the full feature set

[1.0.0]: https://github.com/markgrendev/automated-release-compliance-action/releases/tag/v1.0.0
