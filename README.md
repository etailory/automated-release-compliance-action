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
      - uses: markgrendev/automated-release-compliance-action@dev
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          compliance-profile: iso27001
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
| `compliance-profile` | no | Compliance framework: `iso27001`, `soc2`, `dora`, or `general` (default). |
| `report-path` | no | Path to write the JSON compliance report. Omit to skip. |
| `fail-on-incomplete` | no | Fail the job if the checklist does not pass (default `false`). |
| `license-key` | no | Enables the premium audit bridge (requires `COMPLIANCE_BACKEND_URL`). |

| Output | Description |
| --- | --- |
| `passed` | `'true'` if the release satisfied the basic compliance checklist, otherwise `'false'`. |
| `score` | Number of checklist items passed out of the total (e.g. `3/3`). |
| `tier` | Which tier ran: `'free'` or `'premium'`. |
| `profile` | Compliance profile that was evaluated: `'iso27001'`, `'soc2'`, `'dora'`, or `'default'`. |
| `report-path` | Path of the written JSON compliance report, if `report-path` input was provided. |
| `audit-verdict` | **Premium only.** Governance verdict from the backend: `'approved'`, `'conditional'`, or `'blocked'`. |

## Deploy the backend

The premium tier requires a running instance of the Governor OS web server. Use
Docker or Compose to self-host it alongside your GitHub Actions workflow.

### Quick-start (Docker Compose)

Two commands from the repo root:

```bash
cp .env.example .env          # fill in SESSION_SECRET, ADMIN_SECRET, LICENSE_SECRET
docker compose up -d
# Verify: curl http://localhost:3000/health
# → {"status":"ok","service":"governor-os-web","version":"1.0.0"}
# OpenAPI spec: curl http://localhost:3000/openapi.yaml
```

The `docker-compose.yml` at the repo root builds the `web/` image, mounts a
`./data` volume so the org registry and audit log survive restarts, and
documents every environment variable as commented stubs.

### Build the image manually

```bash
cd web
docker build -t governor-os-web .
docker run --rm -p 3000:3000 governor-os-web
```

The server starts on `http://localhost:3000`.

### Verify your deployment

After bringing the container up, run the smoke-test script to confirm the
server is healthy and the admin API is correctly wired:

```bash
ADMIN_SECRET=your-secret bash scripts/smoke-test.sh
# or against a remote deployment:
BASE_URL=https://compliance.your-company.com ADMIN_SECRET=your-secret bash scripts/smoke-test.sh
```

The script checks `/health`, creates a temporary test org via `POST /admin/orgs`,
confirms it appears in `GET /admin/orgs`, and removes it with
`DELETE /admin/orgs/:id`. It prints a pass/fail summary and exits 0 only when
all checks succeed.

Set `COMPLIANCE_BACKEND_URL` in your GitHub Actions workflow to point to the
public URL where you've deployed this container:

```yaml
- uses: markgrendev/automated-release-compliance-action@dev
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    license-key: ${{ secrets.GOVERNOR_LICENSE_KEY }}
  env:
    # URL of your self-hosted Governor OS backend:
    COMPLIANCE_BACKEND_URL: ${{ secrets.COMPLIANCE_BACKEND_URL }}
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the server binds to |
| `SESSION_SECRET` | — | HMAC secret for signing session tokens. Required in production. Generate: `openssl rand -hex 32`. |
| `ADMIN_SECRET` | — | Protects the `/admin/orgs` endpoints. When unset all admin endpoints return 503. Generate: `openssl rand -hex 32`. |
| `LICENSE_SECRET` | — | The license key the server accepts from the action (`Authorization: Bearer <key>`). When unset, any non-empty key is accepted (dev mode only). |
| `ORGS_FILE` | `data/orgs.json` | Path inside the container to the org registry JSON file. |
| `AUDIT_LOG_FILE` | `data/audit-log.ndjson` | Path inside the container to the durable audit log. |
| `DATABASE_URL` | — | PostgreSQL connection string (future) |
| `GITHUB_OIDC_JWKS_URL` | GitHub default | Override for GitHub Enterprise |

Copy `.env.example` to `.env` and fill in secrets. Never commit `.env`.

---

## Premium tier

Once the backend is deployed, add `license-key` and `COMPLIANCE_BACKEND_URL` to
your workflow to enable the premium audit bridge. The action will submit release
metadata to the backend, poll until the audit job completes, and expose the
governance verdict as the `audit-verdict` output.

### Full workflow example

```yaml
name: Release Compliance (Premium)
on:
  release:
    types: [published]

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - name: Run Governor OS compliance audit
        id: compliance
        uses: markgrendev/automated-release-compliance-action@dev
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          compliance-profile: iso27001
          license-key: ${{ secrets.GOVERNOR_LICENSE_KEY }}
          report-path: compliance-report.json
          fail-on-incomplete: "true"
        env:
          COMPLIANCE_BACKEND_URL: ${{ secrets.COMPLIANCE_BACKEND_URL }}

      - name: Enforce governance verdict
        if: steps.compliance.outputs.audit-verdict == 'blocked'
        run: |
          echo "Deployment blocked by Governor OS governance audit."
          exit 1

      - name: Log audit result
        run: |
          echo "Tier: ${{ steps.compliance.outputs.tier }}"
          echo "Profile: ${{ steps.compliance.outputs.profile }}"
          echo "Passed: ${{ steps.compliance.outputs.passed }}"
          echo "Score: ${{ steps.compliance.outputs.score }}"
          echo "Verdict: ${{ steps.compliance.outputs.audit-verdict }}"

      - uses: actions/upload-artifact@v4
        with:
          name: release-compliance-report
          path: compliance-report.json
```

Set `COMPLIANCE_BACKEND_URL` as a repository secret pointing to your deployed
backend (e.g. `https://compliance.your-company.com`). The action reads this
environment variable automatically — no additional `backend-url` input is
required.

### Governance verdicts

| Verdict | Meaning |
| --- | --- |
| `approved` | Release is a fully-published, non-draft production release. All governance controls are satisfied. Safe to deploy. |
| `conditional` | Release is a pre-release. Reduced controls apply. Manual review recommended before promoting to production. |
| `blocked` | Release is a draft. The audit cannot be approved until the release is published. Block deployment. |

The `audit-verdict` output is only set when the premium tier runs (i.e., when
`license-key` is provided and `COMPLIANCE_BACKEND_URL` is reachable). On the
free tier the output is an empty string.

### Audit result structure

The backend returns a JSON job result that is summarised in the action workflow
run. The key fields are:

```jsonc
{
  "auditTrailId": "audit-acme_widgets-v1.2.0-1748692800000",
  "repository":   "acme/widgets",
  "release": {
    "tag":         "v1.2.0",
    "publishedAt": "2026-05-31T12:00:00.000Z",
    "author":      "octocat"
  },
  "governanceVerdict": {
    "verdict": "approved",                            // "approved" | "conditional" | "blocked"
    "reason":  "Release meets Governor OS governance requirements."
  },
  "isoControlMapping": {
    "CC6.1": "Change management: Release tag and metadata captured.",
    "CC7.2": "System monitoring: CI workflow completion linked to release.",
    "CC8.1": "Change management: Release notes and issue references reviewed."
  },
  "completedAt": "2026-05-31T12:00:01.234Z"
}
```

---

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
