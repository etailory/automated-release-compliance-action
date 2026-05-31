# Governor OS (ComplianceSuite)

> The Unified Product, Engineering, and Quality Management Platform for Regulated Industries.

Governor OS is an all-in-one platform built specifically for companies operating under strict regulatory frameworks (Fintech, MedTech, GovTech) bound by **ISO 27001, SOC2, and DORA compliance**. 

Instead of forcing teams to manage fragmented tools that don't talk to each other, Governor OS unifies the entire software lifecycle—from corporate strategy to source code and test execution—into a single, AI-driven source of truth.

---

## The Vision: Bridging the Enterprise Divide

Modern software delivery in regulated enterprises suffers from extreme friction between three distinct layers. Governor OS eliminates this by providing an interconnected platform:

*   **Portfolio & Roadmap View (For Leadership & Product):** Executives map high-level strategic milestones. Our integrated AI instantly cross-references these goals against global compliance standards (e.g., ISO, DORA), automatically flagging compliance controls and risk assessments before a single line of code is written.
*   **Sprint & Issue Tracking (For Engineering):** An intuitive agile backlog directly linked to the roadmap. As engineers code, the system dynamically feeds relevant compliance guidelines into their workflow. No manual ticketing or synchronization required.
*   **Integrated QA & Test Management (Replacing TestRail):** When a feature is defined, the AI generates the required technical test protocols instantly. Test execution results are captured natively within our pipelines and permanently linked to the respective strategic goal and compliance control.

### The One-Click Audit
The ultimate enterprise value. Instead of taking weeks to gather screenshots and logs for external auditors, compliance officers can generate a cryptographic, end-to-end audit trail in seconds:

`Strategic Intent ──> Risk Assessment ──> Code Commits ──> QA Verification ──> Production Release`

---

## Repository Architecture (Monorepo)

To ensure the AI engine has complete, uninterrupted context over the entire platform, Governor OS is developed as a Monorepo:

*   `/action`: The lightweight GitHub Action ("Trojan Horse") used for friction-free developer onboarding.
*   `/web`: The unified web application (Next.js/Node.js) hosting the Roadmap, Sprint, and QA interfaces.
*   `/core`: Shared data structures, compliance definitions, and AI prompt pipelines.

---

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
      - uses: markgrendev/automated-release-compliance-action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Write durable audit evidence and archive it as a CI artifact:
          report-path: compliance-report.json
          # license-key: ${{ secrets.GOVERNOR_LICENSE_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: release-compliance-report
          path: compliance-report.json
```

### Audit evidence (`report-path`)

Set the optional `report-path` input to have the action write a schema-versioned,
machine-readable JSON compliance report. This is the first durable piece of the
Governor OS audit trail: archive it as a CI artifact and an auditor can later prove
a release was checked against the checklist at publish time.

```jsonc
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-05-31T12:00:00.000Z",
  "tool": { "name": "automated-release-compliance-action", "version": "0.1.0" },
  "tier": "free",
  "repository": "acme/widgets",
  "release": { "tag": "v1.2.0", "name": "Spring Release", "isPrerelease": false, "isDraft": false, "publishedAt": "2026-05-30T00:00:00Z", "author": "octocat", "url": "https://github.com/acme/widgets/releases/tag/v1.2.0" },
  "compliance": { "passed": true, "score": 3, "total": 3, "checks": [ /* … */ ] }
}
```

| Input | Required | Description |
| --- | --- | --- |
| `github-token` | yes | Token used to read release/repository context. |
| `report-path` | no | Path to write the JSON compliance report. Omit to skip. |
| `fail-on-incomplete` | no | Fail the job if the checklist does not pass (default `false`). |
| `license-key` | no | Enables the (stubbed) premium audit bridge. |

Outputs: `passed`, `score`, `tier`, and `report-path` (set when a report was written).

## Development

The `src/` library and tests are written in **TypeScript**. Bun handles transpilation natively — no separate compile step is needed during development.

```bash
bun install          # install root dependencies
bun test             # run TypeScript unit tests via bun:test
bun run build        # bundle src/index.ts -> dist/index.js (node target)

cd action && npm install   # install action-specific dependencies
cd web && npm install      # install web server dependencies
```

### TypeScript

- Source: `src/*.ts` — strict TypeScript with shared interfaces in `src/types.ts`
- Tests: `test/*.test.ts` — `bun:test` with typed assertions
- Config: `tsconfig.json` — `moduleResolution: bundler`, `strict: true`
- Build: Bun bundles the TypeScript entry point directly; no intermediate `.js` output in `src/`

## Project layout

```
action/             GitHub Action implementation (node20, OIDC-based)
  action.yml        Action metadata + input/output contract
  index.js          Entry point: free-tier + premium OIDC compliance
  package.json      Action dependencies (@actions/core, @actions/github)
web/                Express API server for premium audit trail generation
  server.js         REST API: /api/v1/compliance/verify + /audit
  package.json      Web server dependencies (express)
src/                TypeScript compliance checklist library (Bun)
  types.ts          Shared TypeScript interfaces
  checklist.ts      Free-tier compliance rules
  index.ts          Action entry point
  report.ts         Audit-evidence report builder (free-tier JSON report)
  premium.ts        Premium bridge stub
dist/               Bundled output built via bun build
test/               Unit tests (bun:test, TypeScript)
tsconfig.json       TypeScript compiler configuration
action.yml          Root action metadata (points to dist/index.js)
LICENSE             MIT License
```
