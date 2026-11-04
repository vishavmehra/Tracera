# Tracera

Tracera is an evidence-backed engineering workspace that goes from a bug signal to a reviewed fix. Show it a bug report, a screenshot, a screen recording, or a meeting transcript and it indexes the repository into a versioned code graph, investigates the code with cited hypotheses, proposes a patch, reproduces the bug and verifies that exact patch in a Docker sandbox, and puts the diff and the evidence in front of a person to review.

Tracera is decision support, not an oracle. A generated explanation is not a confirmed root cause, and a generated patch is not a verified fix. Every record says whether it was observed, reported, or inferred, models only propose, and a result is called verified only when the stored sandbox run says so. Inference runs on Meta's Muse models: Muse Spark 1.3 for reasoning and vision, Muse Wonder for escalation, and SAM 3.1 for locating elements in screenshots.

## Live deployment

| | |
|---|---|
| Web app | https://tracera-gules.vercel.app |
| API | https://tracera-api.onrender.com ([`/healthz`](https://tracera-api.onrender.com/healthz), [`/readyz`](https://tracera-api.onrender.com/readyz)) |
| Judging account | Email `judge@tracera.example`, password `Tracera-Judge-4271` |

The judging account is a shared email-and-password account with the workspace **member** role, created for reviewers. It already has two registered, indexed repositories: `shop-ui` (Lumen Goods, a small shop whose cart page promises free shipping from $50 but charges $4.99 on an order of exactly $50.00) and `bench-shop`. **Continue with Google** is also on the sign-in page. The API and worker run in one container on Render's free plan in Singapore with a free Render Postgres, behind a Vercel static site that proxies `/api`. The free instance sleeps after 15 minutes without traffic and needs 40 to 50 seconds to wake; the web app wakes it from the browser and retries, and says so on screen. The container has no Docker, so the sandbox stages and applying a patch are **local-only**; the hosted deployment runs investigations as analysis and labels what it cannot do. Model calls draw on a shared daily budget.

## Walkthrough video

**[Watch the narrated walkthrough: diagrams/walkthrough/tracera-walkthrough.mp4](diagrams/walkthrough/tracera-walkthrough.mp4)** (37 min 27 s, 68 MB; captions also in [`tracera-walkthrough.srt`](diagrams/walkthrough/tracera-walkthrough.srt)). It explains each part of Tracera and narrates the architecture diagrams next to the features they describe. It shows both ways to run it: the hosted website, and a local install on a laptop with its own database and Docker sandbox. It tours every page of the web app. On the laptop it follows a real Google Meet call from transcript import to a verified, applied patch, shows how the sandbox isolates repository code, files a bug from the Chrome extension, connects GitHub and syncs a repository, analyses a screen recording, and drives Tracera from a coding agent through MCP. The voiceover is synthetic and the captions are burned in. Where a long wait is skipped, the narration says so.

**Architecture and workflow diagrams:** all 27 are in [`diagrams/`](diagrams/), as editable draw.io sources (`diagrams/src/`) and PNG (`diagrams/png/`), indexed with titles and captions in [`diagrams/index.json`](diagrams/index.json). Each is embedded below in the section it explains.

## Contents

- [The problem](#the-problem)
- [How a bug flows](#how-a-bug-flows)
- [Reading the results: evidence and outcomes](#reading-the-results-evidence-and-outcomes)
- [Features](#features)
- [Architecture](#architecture)
- [Meta models and the model gateway](#meta-models-and-the-model-gateway)
- [Authentication](#authentication)
- [Data model](#data-model)
- [Security model](#security-model)
- [Hosted and local](#hosted-and-local)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Database migrations](#database-migrations)
- [Deployment](#deployment)
- [Tests](#tests)
- [Scope](#scope)
- [Repository layout](#repository-layout)
- [Acknowledgments](#acknowledgments)

## The problem

A bug report is a symptom: a sentence, a screenshot, a remark in a call. Turning it into a fix means finding the code, reproducing the failure, writing a change, and proving the change works. Teams do this by hand, and AI coding tools shortcut it with confident patches that nobody can tell from a guess: the output says "fixed" without showing what was observed.

Tracera makes each step explicit and inspectable:

- Which code the symptom points to, with citations into a versioned code graph and the git history.
- Which hypotheses were considered, ranked by the evidence behind them, and which one the checks supported.
- Whether the bug was reproduced in a sandbox, with run output and browser screenshots.
- Whether the proposed patch makes that reproduction pass, and what else it can reach.
- Who approved it and who authorized each step that touches a repository.

## How a bug flows

![From bug report to reviewed fix](diagrams/png/04-bug-to-fix-workflow.png)

1. **Show the bug.** File a report with a description, steps, screenshots, a screen recording, logs, or stack traces, or import a meeting and confirm a candidate.
2. **Understand the evidence.** Tracera normalizes the report, parses traces and logs, reads screenshots and recording keyframes into labelled evidence, and collects bounded context from the repository and its git history.
3. **Investigate the code.** The code graph supports cited hypotheses about where the bug lives, ranked by evidence.
4. **Generate a fix.** A patch is proposed and checked against policy before anything runs.
5. **Run it in the sandbox.** Tests, or a browser reproduction for UI bugs, run in a locked-down Docker container: first to reproduce the bug, then against the patch.
6. **Verify.** The outcome is derived by rules from what the sandbox observed. A passing test suite alone never produces "verified".
7. **Review.** The diff, impact analysis, evidence and a resolution report are shown for a person to approve or reject. Approval records a decision and changes no files.
8. **Act, one authorization at a time.** Applying the patch to a working tree, committing it to a new branch, pushing that branch, and opening a pull request are separate requests from a signed-in owner.

![Investigation stages and status machine](diagrams/png/05-pipeline-state-machine.png)

## Reading the results: evidence and outcomes

![Evidence and honesty model](diagrams/png/06-evidence-honesty-model.png)

Everything a model sees or says carries a handle that states where it came from:

| Handle | Kind | Meaning |
|---|---|---|
| `EV-n`, `SHOT-n`, `REC-n` | reported | Text from the report, what a vision model read in a screenshot, what the keyframes of a recording show |
| `CODE-n`, `COMMIT-n`, `REPRO-n` | observed | A code excerpt, a commit, a sandbox reproduction run |
| `FIND-n` | observed or inferred | A tool fact (observed) or a model note (inferred) |
| `INFER-n`, `HYP-n`, `RECINFER-n` | inferred | A model's inference or hypothesis, never shown as fact |

Results are labelled `[live]` for a configured provider and `[mock]` for the deterministic mock adapter. Hypothesis states and verification outcomes are set only by code, and `verification_runs.outcome` is written by one function:

![Verification outcome rules](diagrams/png/07-verification-rules.png)

| Outcome | Rule | UI wording |
|---|---|---|
| `not_attempted` | No verification run exists | Not verified |
| `failed` | Any check failed | Verification failed |
| `verified` | The reproduction check passed and every check passed | Fix verified against the original reproduction |
| `partially_verified` | Something passed, but the reproduction did not | Checks passed, but the original failure was not confirmed |
| `inconclusive` | A check was inconclusive; none passed, none failed | Verification inconclusive |
| `blocked` | All checks blocked or not attempted, for example with no sandbox | Verification could not run |

## Features

Each feature below covers what it does and how it works.

- [Repositories and the code graph](#repositories-and-the-code-graph)
- [Questions, feasibility, and impact](#questions-feasibility-and-impact)
- [Screenshot understanding](#screenshot-understanding)
- [Screen recordings](#screen-recordings)
- [Reproduction in the sandbox](#reproduction-in-the-sandbox)
- [GitHub sync](#github-sync)
- [Review and authorized actions](#review-and-authorized-actions)
- [Opening a pull request](#opening-a-pull-request)
- [Meetings and Google Meet](#meetings-and-google-meet)
- [Chrome extension](#chrome-extension)
- [MCP server](#mcp-server)
- [Demo repositories](#demo-repositories)

### Repositories and the code graph

![Repository intelligence](diagrams/png/11-repository-intelligence.png)

Register a local git repository inside `TRACERA_REPO_ROOTS` with its install, test, and optional start commands. Tracera indexes it into a versioned graph for JavaScript, TypeScript, and SQL: files, symbols, calls, routes, client requests, events, data access, and configuration reads. Indexing only parses text, never runs repository code, and is incremental per commit. Other languages are detected and counted.

### Questions, feasibility, and impact

Ask the codebase a question and get an answer whose claims cite graph nodes and code. Ask for a feasibility and change-size assessment. **Patch impact** takes two revisions or a diff and reports what changed, which tests cover it, and what it can reach.

![Patch impact analysis](diagrams/png/12-patch-impact.png)

### Screenshot understanding

![Screenshot understanding](diagrams/png/08-screenshot-understanding.png)

Attach a screenshot to a bug report (from the form or the extension). A vision model reads it into derived evidence: visible text, error messages, interface elements. That evidence is labelled `[mock]` or `[live]`, stored as `SHOT-n` (reported), and kept apart from what is inferred. On request SAM 3.1 marks where a named element sits in the screenshot, as a display aid and not as proof of a defect.

### Screen recordings

![Screen recording analysis](diagrams/png/09-recording-analysis.png)

Attach a screen recording. The browser samples keyframes (the first, the last, and ten evenly spaced, at most 1280 px wide, with timestamps) and uploads only those frames through the screenshot evidence path; the recording itself never leaves the browser. Each frame is read like a screenshot, a text-only step builds a timeline (visible versus inferred), error messages, the failing element, and inferred repro steps, and SAM 3.1 runs on at most six frames. The analysis reaches the investigation as `REC-n` (reported) and `RECINFER-n` (inferred), neither of which can move a hypothesis on its own, and every label says it rests on N keyframes at stated timestamps.

### Reproduction in the sandbox

![Docker sandbox](diagrams/png/13-docker-sandbox.png)

Dependencies are installed from lockfiles without lifecycle scripts, through a proxy that admits only the configured registry. Tests and checks run in a container with no network, a read-only root filesystem, a non-root user, dropped capabilities, and CPU, memory, process, and time limits. For UI bugs Tracera starts the registered app in the sandbox, reproduces the bug in a browser, and runs the same steps against the patched app; the review page shows the before and after screenshots with each step's result.

![Runtime demo: shop-ui before and after](diagrams/png/14-runtime-demo.png)

### GitHub sync

![GitHub App sync](diagrams/png/26-github-app-sync.png)

Besides local paths, repositories can come from GitHub through a **GitHub App**. On the Repositories page the owner clicks **Connect GitHub**, installs the App on an account and the repositories to share, returns to Tracera, picks a repository with **Connect** (its install and test commands are the two fields above the list), and presses **Sync** whenever the branch moved. The worker fetches the repository into a bare cache at `<TRACERA_DATA_DIR>/sources/<repository id>.git` with a one-off, read-only installation token for that one repository, and indexes the exact head it fetched. The code graph, questions, and change impact then work on it like on any other repository. The cache has no working tree, so applying, committing, and pushing a patch stay with local-path repositories.

- **Signed state.** The install link carries a state (workspace, user, nonce, 10-minute expiry) that is accepted only for the same signed-in owner; the OAuth code returned by GitHub proves the installer can reach that installation, and the App's permissions are checked before anything is listed.
- **Tokens never leak.** The App's private key stays on the server (`TRACERA_GITHUB_APP_PRIVATE_KEY_PATH`). The App JWT is used only for `/app` calls; installation tokens live in memory, go to git through its environment, and never appear in a URL, an argument, a log, or a file. GitHub endpoints are fixed constants and redirects are never followed.
- **Webhooks are optional signals.** A push webhook (`POST /api/v1/webhooks/github`, `X-Hub-Signature-256` HMAC-SHA256 over the raw body, deduplicated by delivery GUID) or the Sync button queues one `repository.sync` job; a burst of pushes merges into one fetch and one index, and the worker also reconciles every five minutes. What is indexed is always the head the sync observed, not what a webhook claims.
- **Not configured is not broken.** With any of the five variables unset, the GitHub panel names the unset variables, `GET /api/v1/github/status` reports `configured: false`, and everything else works.

To register the App, open GitHub, Settings, Developer settings, GitHub Apps, New GitHub App: add the callback URLs `<web origin>/api/v1/github/callback` (for example `http://127.0.0.1:5173/api/v1/github/callback`), tick **Request user authorization (OAuth) during installation** and leave the Setup URL empty, give it Repository permissions **Contents: Read-only**, **Metadata: Read-only**, and **Pull requests: Read-only**, and leave the webhook inactive unless you have a public HTTPS URL. Then set `TRACERA_GITHUB_APP_ID`, `TRACERA_GITHUB_APP_PRIVATE_KEY_PATH` (the downloaded `.pem`), `TRACERA_GITHUB_WEBHOOK_SECRET` (16 to 256 characters), `TRACERA_GITHUB_CLIENT_ID`, and `TRACERA_GITHUB_CLIENT_SECRET`.

### Review and authorized actions

![Authorized actions on an approved patch](diagrams/png/15-authorized-actions.png)

A person reviews the diff, impact, evidence, and risks, then approves or rejects. Approval is a session-only decision and changes no files. Applying the patch to the local working tree, committing it to a new branch (from a temporary worktree, with a secret scan of the added lines), and pushing that branch (never forced, never to the default branch), and opening a pull request from it are four separate requests that only a signed-in owner session can make. Each must echo the verification outcome the person saw and acknowledge the risks unless the outcome is `verified`, runs git with hooks disabled, and writes an audit event. API tokens and MCP clients get `session_required`.

### Opening a pull request

![Opening a pull request](diagrams/png/27-pull-request-opening.png)

After a successful push, the patch review panel offers **Open pull request** as the fourth authorized action: a title field prefilled from the patch summary, an **Open as a draft** checkbox, and **Confirm pull request**. It is the same owner-session request as apply, commit, and push (`POST /api/v1/patches/{id}/actions` with `kind: "pull_request"`).

- **What it needs.** An approved patch, an `acknowledged_outcome` equal to the recorded verification outcome (and `acknowledged_risks` unless it is `verified`), a successful push for this patch, and `TRACERA_GITHUB_TOKEN`. A hosted server refuses it (`unavailable_in_hosted_environment`), and tokens and MCP clients get `session_required`.
- **Where it goes.** The head is the branch of the latest push. The repository comes from the push remote's URL (`https://github.com/OWNER/REPO` or `git@github.com:OWNER/REPO`; anything else is `remote_not_github`). The base is the request's `base`, or the repository's default branch.
- **What it says.** The title is yours or the patch summary. The description is built by code from stored rows, never by a model: the summary, the diagnosis with its stored status, the files changed, and the stored verification outcome with the checks that ran and did not. Anything other than `verified` reads "Not verified". Text a model or the repository wrote is quoted as inert single lines (no mentions, issue references, or links) and secrets are redacted.
- **What it records.** Only what GitHub answered: the URL and number, shown as "[live] Opened pull request #N on GitHub" with a link. Tracera never merges or edits the pull request afterwards.

To set it up, create one fine-grained personal access token on GitHub, limited to the target repository, with **Contents: Read and write** and **Pull requests: Read and write** (Metadata: Read is added automatically), and set it as `TRACERA_GITHUB_TOKEN` in the server's environment. When it is set and the push address is a `github.com` https URL, the push step authenticates with the same token, handed to git through the process environment only and never in a URL, argument, file, or log; otherwise the machine's own git credentials are used. Register the repository as a local path whose remote points at the GitHub repository, run an investigation, approve the verified patch, then apply, commit, push, and open the pull request.

### Meetings and Google Meet

![Google Meet ingestion](diagrams/png/18-google-meet.png)

Meetings turn what people said in a call into reviewed bug reports. A model reads the transcript and proposes candidates; code rejects any candidate whose quotes do not occur verbatim in the segments it cites and flags likely duplicates, and the model sets no status. A person edits, dismisses, or confirms each remaining candidate, and confirming creates a bug report and, unless declined, an investigation.

- **Upload** a `.vtt`, `.srt`, or `.txt` transcript up to 5 MB, with an attestation that you may share it.
- **Import from Google Meet.** The Meetings page connects a Google account (OAuth with state and PKCE, the single read-only scope `meetings.space.readonly`), lists conferences that have transcripts, and imports one into the same pipeline. Tokens are encrypted at rest with `TRACERA_ENCRYPTION_KEY`, and re-importing the same transcript is idempotent.

To enable the import, create an OAuth client in the Google Cloud console, enable the **Google Meet REST API**, add the scope `https://www.googleapis.com/auth/meetings.space.readonly`, and register the redirect URI `<web origin>/api/v1/integrations/google/callback`. While the consent screen is in testing mode only listed test users can connect. Google creates transcripts only on Workspace editions that support them, only when transcription was started in the call, and only after the meeting has ended. Microsoft Teams is not implemented; export a Teams transcript as WebVTT and upload it.

### Chrome extension

![Chrome extension](diagrams/png/19-chrome-extension.png)

`apps/extension` is a Manifest V3 extension for reporting a bug from the page you are looking at. Click its icon, review what will be sent (title, description, steps, page address without query string or fragment, scrubbed console lines), black out regions of the screenshot (they are burned into the pixels before upload), and submit. It creates a bug report, uploads the screenshot as evidence, and can start an investigation. Nothing is captured until you click, and it needs a personal access token (client kind `extension`) that you paste once after accepting the consent text.

```sh
# the API and web origins are fixed at build time; the API origin becomes its only host permission
TRACERA_EXTENSION_DEFAULT_API_URL=<API origin> TRACERA_EXTENSION_DEFAULT_WEB_URL=<web origin> npm run build:extension
```

Open `chrome://extensions`, enable developer mode, and load `apps/extension/dist` unpacked. It works against a local or the hosted API.

### MCP server

![MCP server](diagrams/png/20-mcp-server.png)

`apps/mcp` is a local stdio MCP server. Coding agents such as Claude Code and Codex use it to search a registered repository, ask evidence-backed questions, estimate change impact, report bugs, run investigations, and read findings, diffs, verification results, and reports. It is a thin client of the REST API: it holds no database connection, opens no ports, runs nothing on your machine, and cannot approve patches. Its 14 tools are `tracera_list_repositories`, `tracera_get_repository_status`, `tracera_search_code`, `tracera_get_graph_node`, `tracera_trace_flow`, `tracera_get_change_impact`, `tracera_ask_question`, `tracera_get_answer`, `tracera_create_bug_report`, `tracera_start_investigation`, `tracera_get_investigation_status`, `tracera_get_findings`, `tracera_get_patch_diff`, and `tracera_get_resolution_report`.

1. Create a personal access token with client kind `mcp`: sign in, then `POST /api/v1/tokens` with `{"name": "mcp", "client_kind": "mcp"}` (cookie-authenticated requests need the `X-Tracera-CSRF: 1` header and an `Origin` equal to `TRACERA_PUBLIC_URL`). The response contains the token secret once.
2. Register the server. Run it with `node` directly, not through `npm run`, because npm writes to stdout, which carries the protocol. `TRACERA_API_URL` defaults to `http://127.0.0.1:8787` (`https`, or plain `http` only to loopback); `TRACERA_TOKEN` is the token secret.

```sh
# Claude Code
claude mcp add tracera -s user \
  -e TRACERA_API_URL=http://127.0.0.1:8787 -e TRACERA_TOKEN=<token> \
  -- node /path/to/tracera/apps/mcp/src/index.ts
```

```toml
# Codex, ~/.codex/config.toml
[mcp_servers.tracera]
command = "node"
args = ["/path/to/tracera/apps/mcp/src/index.ts"]
env_vars = ["TRACERA_TOKEN"]

[mcp_servers.tracera.env]
TRACERA_API_URL = "http://127.0.0.1:8787"
```

### Demo repositories

`fixtures/shop-ui` (Lumen Goods) is a small cart page with one planted bug: an order of exactly $50.00 is charged shipping although the page promises free shipping from $50. A refactor commit turned `>=` into `>`. `npm run setup` creates it as a git repository named `shop-ui` and `npm run demo:setup` rebuilds it. Register it with the commands `npm ci --ignore-scripts`, `npm test`, and `npm run start` and the app `{ "port": 4173, "ready_path": "/health", "base_url_path": "/cart" }`, then report the bug with the page URL `http://localhost:4173/cart`. `eval/bench-shop` is the benchmark fixture (`npm run bench:setup`, `npm run bench:eval`).

## Architecture

![System context](diagrams/png/01-system-context.png)

- `apps/server`: the REST API and the background worker (one codebase, two entrypoints), the inference gateway, and the Docker sandbox executor.
- `apps/web`: the React web workspace.
- `apps/mcp`: the MCP server.
- `apps/extension`: the Chrome extension.
- `packages/contracts`: every request, response, and model-output schema (Zod), imported by every client.
- PostgreSQL for state and the job queue; Docker for sandboxed execution.
- Optional GitHub integration: a GitHub App for repository sync, and a personal access token for pushing and opening pull requests.

![Containers](diagrams/png/02-containers.png)

![Monorepo layout and module boundaries](diagrams/png/03-monorepo-layout.png)

The API never calls Docker: long work (indexing, each investigation stage, evidence analysis, meeting extraction) runs as queued jobs on the worker, which owns the sandbox.

![Job queue and worker](diagrams/png/22-queue-worker.png)

**Stack:** TypeScript on Node.js 24 (run directly, no build step), Fastify, PostgreSQL with Drizzle ORM, pg-boss for background jobs, Zod schemas shared through `packages/contracts`, React with Vite and Tailwind for the web app, Docker for the sandbox, Vitest and Playwright for tests.

## Meta models and the model gateway

![Inference gateway and model routing](diagrams/png/10-inference-gateway.png)

Tracera's inference runs on Meta's Model API (base URL `https://api.meta.ai/v1`, set with `TRACERA_META_BASE_URL`; key `TRACERA_META_API_KEY`, read only by the server). All calls leave from one place, the inference gateway in [`apps/server/src/inference/`](apps/server/src/inference/): `gateway.ts` is the only path to a model, `providers.ts` holds the adapters, `tasks.ts` defines every task, and `segmentation.ts` calls SAM. No other code imports a provider SDK or calls a model API, and the browser, the extension and the MCP server never talk to Meta; they talk to Tracera's API. Claude Code and Codex are external clients of that API; Tracera's own inference never goes through them.

**Models.** `muse-spark-1.3` (Muse Spark) does every text task and reads images. `muse-wonder-1.0` (Muse Wonder) is used only for a final patch attempt, and only when `TRACERA_ESCALATION_ENABLED=true`. `sam-3.1` (SAM) locates a named element in an image. A deterministic `mock` adapter replaces Meta in tests and is always labelled `[mock]`; an `openai_compatible` adapter exists as an alternative provider.

**Endpoints.** Chat tasks are `POST {base}/chat/completions` (Meta takes `max_completion_tokens` and a prompt cache key); SAM is `POST {base}/responses` with a noun phrase and an image, and returns boxes or masks.

**Where Meta is called.** Each row is one gateway task with its own prompt, prompt version, strict output schema, and token limit:

| Task | Model | What Meta does | What is sent | Called from |
|---|---|---|---|---|
| `normalize_bug_report` | Muse Spark | Turns a report and its evidence into a structured report: expected and actual behavior, steps, search terms | Report text and evidence text (clipped to fixed limits), screenshot and recording readings | `modules/normalization.ts` |
| `plan_reproduction` | Muse Spark | Plans a test-based reproduction | The normalized report and cited code excerpts | `modules/pipeline.ts` |
| `plan_browser_reproduction` | Muse Spark | Plans browser steps for a UI bug | The report and the app's start path | `modules/pipeline.ts` |
| `generate_hypotheses` | Muse Spark | Proposes ranked hypotheses that cite evidence | The report and the evidence pack (`CODE-n`, `COMMIT-n`, `REPRO-n`, ...) | `modules/pipeline.ts` |
| `generate_patch` | Muse Spark; Muse Wonder for a final attempt when escalation is on | Proposes a patch for the supported hypothesis | The hypothesis and bounded excerpts of the target file | `modules/pipeline.ts` |
| `assess_feasibility` | Muse Spark | Feasibility and change-size assessment | The question and code-graph context | `modules/assessment.ts` |
| `answer_question` | Muse Spark | Answers a question about the codebase with citations | The question and retrieved graph nodes and code | `modules/assessment.ts` |
| `extract_meeting_bugs` | Muse Spark | Proposes bug candidates from a transcript, each with quotes | The transcript's numbered segments | `modules/meeting-extract.ts` |
| `observe_screenshot` | Muse Spark (vision) | Reads a screenshot into visible text, error messages, and interface elements | One image, up to `TRACERA_MAX_IMAGE_BYTES` | `modules/visual-evidence.ts` |
| `analyze_recording` | Muse Spark | Builds a timeline from the keyframe readings (text only, no images) | The readings of the sampled keyframes | `modules/visual-recording.ts` |
| SAM locate | SAM 3.1 | Marks where a named element sits, as a display aid | A keyframe or screenshot and a short noun phrase | `modules/visual-locate.ts` via `inference/segmentation.ts` |

**What every call goes through.** The gateway checks the budget (`TRACERA_LLM_DAILY_BUDGET_USD`, plus per-investigation call and cost limits) and refuses with `budget_exceeded` when it is spent; redacts secrets (and optionally emails) from the prompt; sends it with bounded retries; and requires JSON that matches the task's Zod schema. Evidence is wrapped as untrusted blocks, so instructions inside repository files, logs, transcripts, or screenshots are data. Each call is recorded in `model_executions` with the task, prompt version, provider, model, whether it ran live or as a mock, and the redaction count (listed at `GET /api/v1/investigations/{id}/model-executions`), and results carry `[live]` or `[mock]`.

**What Meta never does.** Models only propose. Code validates every citation, sets hypothesis states, and writes `verification_runs.outcome`; the sandbox runs the tests; people approve and authorize every action. These steps make no model call: indexing the code graph, patch impact, sandbox runs, verification, the authorized actions, and the MCP tools (which call Tracera's REST API).

**What leaves the server.** Only what a task sends: bounded text excerpts of your report, code, and transcript, and the images you attach or the keyframes the browser samples, always after redaction. In one recorded end-to-end run (a screen recording of the cart bug, through to a verified, applied patch) Tracera made 18 Muse Spark calls and 6 SAM calls, about $0.18 in total.

## Authentication

![Authentication and authorization](diagrams/png/16-auth-authorization.png)

Email and password sign-in creates a cookie session. Every query is scoped to a workspace, and personal access tokens are scoped, expiring, and stored hashed.

![Sign in with Google](diagrams/png/17-google-sign-in.png)

"Continue with Google" uses Supabase Auth and appears only when `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are set. The server checks the provider token with Supabase, accepts only an email Google has verified, signs an existing user in, and makes a new email a workspace **member**, never an owner (`TRACERA_GOOGLE_SIGNIN_NEW_USERS=deny` refuses new emails). The session is the same cookie session the password login gives. To set it up, enable the Google provider in Supabase, add `<web origin>/auth/callback` to the Redirect URLs, and set the two variables.

## Data model

![Database overview](diagrams/png/21-database-overview.png)

PostgreSQL holds workspaces, users, repositories, snapshots and the code graph, bug reports and evidence, investigations with their steps, hypotheses, reproductions, patches, verification runs, reports, meetings and candidates, integrations, authorized actions, audit events, and the job queue. IDs are prefixed ULIDs (`inv_…`), JSON is `snake_case` on the wire, and errors are RFC 9457 problem+json with stable codes.

## Security model

![Security controls and trust boundaries](diagrams/png/25-security-controls.png)

- Repository code never runs on the host. Tests, checks, and reproductions run only in the Docker sandbox. If Docker is unavailable the sandbox stages are blocked; there is no fallback to the host.
- Dependencies are installed from lockfiles without lifecycle scripts, through a proxy that admits only the configured registry.
- Models never act. They return strict-schema JSON that code validates; citations are checked, and hypothesis states and verification outcomes are set only by rules in code.
- Nothing is reported as verified, fixed, or confirmed unless the stored data says so.
- Approval changes no files. Apply, commit, push, and open-pull-request are separate requests that only a signed-in owner session can make; git runs with hooks disabled and without force, and the default branch is refused. A pull request's text is built by code from stored rows, never by a model.
- Secrets stay in the server environment: not in the web bundle, logs, or API responses, and they are redacted before every model call.
- GitHub credentials (installation tokens from the GitHub App, and `TRACERA_GITHUB_TOKEN`) live in memory or the process environment, reach git only through its environment, and never appear in a URL, an argument, a file, or a log. GitHub endpoints are fixed, and redirects are never followed.
- Every query is scoped to a workspace; cookie-authenticated changes require a custom header and a same-origin request, decided by the matched route.
- Repository files, logs, transcripts, screenshots, and other inputs are treated as untrusted data.
- Two integration suites hold every registered route to a written access rule (`apps/server/test/security-routes.ts`): a security matrix for authentication, token scopes, owner-only routes, and CSRF, and a workspace isolation suite for foreign IDs.

## Hosted and local

![Hosted versus local](diagrams/png/24-hosted-local-capability-map.png)

| Capability | Hosted demo | Local install |
|---|---|---|
| Web workspace, email and password sign-in, Google sign-in | yes | yes |
| Repositories and the versioned code graph | demo repositories (the GitHub App is not configured on the demo) | any local git repository, or a GitHub repository through the GitHub App |
| Cited answers, feasibility, patch impact | yes | yes |
| Bug reports, screenshot and recording understanding, SAM 3.1 | yes (live models) | yes |
| Meetings: transcript upload and Google Meet import | upload; Meet import for accounts on the Google test-user list | yes |
| Investigations: findings, hypotheses, patch proposal | analysis only | full |
| Sandbox: reproduction, browser evidence, verification | no | yes (Docker) |
| Applying, committing, pushing, and opening a pull request for an approved patch | no (`unavailable_in_hosted_environment`) | yes, one authorization per action |
| Chrome extension and MCP server | yes, pointed at the hosted API | yes |

The web app asks the API what the environment can do (`GET /api/v1/capabilities`) and labels unavailable features instead of hiding them. The local install keeps your code, database, and sandbox on your machine; only model calls and the optional Google Meet import use the network.

## Local setup

Prerequisites: Node.js 24, git, and Docker (Docker Desktop on Windows and macOS). Docker runs the PostgreSQL database and the sandbox that runs repository code. Without it everything except sandboxed reproduction and verification still works, provided `DATABASE_URL` points at a PostgreSQL you run yourself.

```sh
npm ci            # installs the dependencies of every workspace
npm run setup     # checks prerequisites, creates .env, starts PostgreSQL, applies the schema, creates the owner account and the demo repositories
npm run local     # starts the API, the worker, and the web app
```

Open <http://127.0.0.1:5173> and sign in. The owner's email is `TRACERA_SEED_OWNER_EMAIL` and its password is `TRACERA_SEED_OWNER_PASSWORD`, both in `.env`. Until you configure a model provider the models are the deterministic mock, and every mock result is labelled. For live models set `TRACERA_INFERENCE_PROVIDER=meta` and `TRACERA_META_API_KEY` in `.env`, and pull the sandbox images with `npm run setup -- --pull-images`.

**Open the app at `127.0.0.1`, not `localhost`.** The API accepts a change only when the browser's origin equals `TRACERA_PUBLIC_URL`. `npm run local` sets that to `http://127.0.0.1:<TRACERA_WEB_PORT>`; the web app forwards `/api` to the API, so the browser talks to one address. Any other spelling makes sign-in and every save fail.

About `npm run setup`:

- It creates `.env` from `.env.example` only when there is none, with a generated database password, owner password, and encryption key. An existing `.env` is never changed, so running setup again is safe.
- PostgreSQL takes the first free port from 5432, the web app uses 5173, and the API 8787.
- Tracera keeps its files in `~/.tracera` (`TRACERA_DATA_DIR`). Repositories you register must be inside `~/tracera-repos` by default (`TRACERA_REPO_ROOTS`). Keep both outside the Tracera source tree.
- `npm run setup` and `npm run local` refuse a `DATABASE_URL` that is not on this machine, because they change that database; add `-- --allow-remote-db` only for a database you mean to change.
- To configure by hand: copy `.env.example` to `.env`, replace every placeholder, and run `npm run db:up`, `npm run db:migrate`, `npm run db:seed`, and `npm run sandbox:pull`. For development, `npm run dev` (API and worker) and `npm run dev:web` run the pieces separately with file watching.

## Environment variables

`.env.example` lists every option. The ones you are most likely to set:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TRACERA_PUBLIC_URL` | The web app's origin (`http://127.0.0.1:5173` locally); must equal the browser's origin |
| `TRACERA_ENVIRONMENT` | `local` (default) or `hosted`; hosted disables the sandbox-dependent actions |
| `TRACERA_REPO_ROOTS`, `TRACERA_DATA_DIR` | Where repositories may live, and where Tracera keeps its files |
| `TRACERA_SEED_OWNER_EMAIL`, `TRACERA_SEED_OWNER_PASSWORD` | The first owner (password at least 12 characters) |
| `TRACERA_JUDGE_EMAIL`, `TRACERA_JUDGE_PASSWORD` | Optional shared member login for reviewers |
| `TRACERA_INFERENCE_PROVIDER` | `mock` (default), `meta`, or `openai_compatible` |
| `TRACERA_META_API_KEY`, `TRACERA_META_BASE_URL` | Meta Model API key and base URL |
| `TRACERA_MODEL_REASONING`, `TRACERA_MODEL_ESCALATION`, `TRACERA_MODEL_VISION`, `TRACERA_MODEL_SEGMENT` | Model ids (defaults `muse-spark-1.3`, `muse-wonder-1.0`, the provider's vision model, `sam-3.1`) |
| `TRACERA_LLM_DAILY_BUDGET_USD` | Daily model spend cap |
| `TRACERA_SANDBOX_MODE` | `docker` or `disabled` |
| `TRACERA_DEMO_REPOS` | Build and register the demo repositories on boot (hosted) |
| `TRACERA_ENCRYPTION_KEY` | 32 random bytes, base64: encrypts OAuth tokens at rest |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Meet import |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TRACERA_GOOGLE_SIGNIN_NEW_USERS` | Continue with Google (`member` or `deny` for new users) |
| `TRACERA_GITHUB_APP_ID`, `TRACERA_GITHUB_APP_PRIVATE_KEY_PATH`, `TRACERA_GITHUB_WEBHOOK_SECRET`, `TRACERA_GITHUB_CLIENT_ID`, `TRACERA_GITHUB_CLIENT_SECRET` | GitHub sync: all five must be set; the private key is a `.pem` file path on the server |
| `TRACERA_GITHUB_TOKEN` | Opening pull requests, and pushing to a `github.com` remote with the same token: a fine-grained personal access token for the target repository (Contents and Pull requests, read and write) |
| `TRACERA_TRUST_PROXY` | `true` behind a proxy such as Vercel |
| `TRACERA_MAX_IMAGE_BYTES` | Largest screenshot or keyframe in bytes (default 8 MB) |

## Database migrations

Migrations live in `apps/server/src/db/` and are applied by `npm run db:migrate`; the API also applies pending migrations on start when `TRACERA_AUTO_MIGRATE=true`. `npm run db:generate` creates a new one from the Drizzle schema, and `npm run db:seed` creates the owner. The migration step keeps Supabase's public Data API locked down, so tables are reachable only through Tracera's API.

## Deployment

![Deployment](diagrams/png/23-deployment.png)

- `Dockerfile` builds one image that runs the API and the worker together (`scripts/start.ts`). It waits for the database, starts the API (which applies migrations) and then the worker, can create the first owner and the judge login, and with `TRACERA_DEMO_REPOS=true` rebuilds the two demo repositories on every boot, registers them when missing, and requests their indexing (a free instance loses its storage whenever it sleeps).
- `render.yaml` is a Render Blueprint for that image on free plans: one web service (no disk) plus its own Postgres. The container has no Docker, so `TRACERA_SANDBOX_MODE=disabled` and `TRACERA_ENVIRONMENT=hosted`.
- `vercel.json` builds the web app and proxies `/api/*`, `/healthz`, and `/readyz` to the API, so the browser sees a single origin. Cookies, the CSRF check, and OAuth callbacks depend on that: set `TRACERA_PUBLIC_URL` to the web app's origin and `TRACERA_TRUST_PROXY=true` behind the proxy.

## Tests

```sh
npm run check:fast     # typecheck, lint, comment check, unit tests
npm run check          # the same plus integration tests (needs npm run db:up)
npm run test:web       # web app tests
npm run test:mcp       # MCP server tests
npm run test:docker    # sandbox security tests (needs Docker and npm run sandbox:pull)
npm run test:e2e       # browser end-to-end tests of the web app
```

Integration tests run against the local Docker PostgreSQL and refuse remote hosts.

## Scope

- The code graph parses JavaScript, TypeScript, and SQL; other languages are detected and counted.
- Repositories are local git work trees inside `TRACERA_REPO_ROOTS`, or GitHub repositories synced through the GitHub App. The apply, commit, push, and pull-request actions need a local work tree, so they are local features; a GitHub-synced repository is a bare cache with no working tree.
- Recording analysis rests on sampled keyframes at stated timestamps, not on every frame.
- Accounts come from `npm run db:seed` and Google sign-in; personal access tokens are created through the REST API.
- There is no CI pipeline.

## Repository layout

```text
apps/server/        REST API, worker, inference gateway, Docker sandbox executor, migrations
apps/web/           React web workspace
apps/mcp/           stdio MCP server
apps/extension/     Manifest V3 Chrome extension
packages/contracts/ Zod schemas shared by every client
fixtures/shop-ui/   Lumen Goods demo app with the planted $50 shipping bug
eval/bench-shop/    benchmark fixture
scripts/            setup, local run, start, demo and benchmark scripts
diagrams/           draw.io sources (src/), PNG exports (png/), index.json, walkthrough/
Dockerfile, render.yaml, vercel.json   hosted deployment
```

## Acknowledgments

Meta's Muse Spark, Muse Wonder, and SAM models power the inference. Supabase provides Google sign-in, Render and Vercel host the demo, Docker runs the sandbox, Playwright drives browser reproduction, and draw.io drew the diagrams.

## License

MIT. See [LICENSE](LICENSE).
