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
      - uses: markgrendev/automated-release-compliance-action/action@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # anthropic-federation-rule-id: ${{ secrets.FEDERATION_RULE_ID }}
          # anthropic-organization-id: ${{ secrets.ORG_ID }}
          # anthropic-service-account-id: ${{ secrets.SERVICE_ACCOUNT_ID }}
```

## Development

```bash
bun install          # install root dependencies
bun test             # run checklist unit tests
bun run build        # bundle src/ -> dist/index.js

cd action && npm install   # install action-specific dependencies
cd web && npm install      # install web server dependencies
```

## Project layout

```
action/             GitHub Action implementation (node20, OIDC-based)
  action.yml        Action metadata + input/output contract
  index.js          Entry point: free-tier + premium OIDC compliance
  package.json      Action dependencies (@actions/core, @actions/github)
web/                Express API server for premium audit trail generation
  server.js         REST API: /api/v1/compliance/verify + /audit
  package.json      Web server dependencies (express)
src/                Bun-native compliance checklist library
  checklist.js      Free-tier compliance rules (ESM)
  index.js          Action entry point (Bun ESM)
  premium.js        Premium bridge stub (Bun ESM)
dist/               Bundled output built via bun build
test/               Unit tests (bun:test)
action.yml          Root action metadata (points to dist/index.js)
LICENSE             MIT License
```
