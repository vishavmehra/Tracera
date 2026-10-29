# Tracera

**From symptom to certainty.** Tracera turns a bug report into an evidence-backed investigation. It indexes your repository, reproduces the bug in a Docker sandbox, proposes a patch, verifies that exact patch, and asks a human to review it. It never states more than it observed: a generated explanation is not a confirmed root cause, and a generated patch is not a verified fix.

## From bug to fix

1. **Show the bug.** File a bug report with a description, steps, and optional stack traces or logs.
2. **Understand the evidence.** Tracera normalizes the report, parses stack traces and logs, and collects bounded context from the repository and its git history.
3. **Investigate the code.** A static code graph of the repository supports cited hypotheses about where the bug lives, ranked by the evidence behind them.
4. **Generate a fix.** A patch is proposed and checked against policy before anything runs.
5. **Run it in the sandbox.** Tests (or a browser reproduction for UI bugs) run in a locked-down Docker container, first to reproduce the bug and then against the patch.
6. **Verify.** The outcome is derived by rules from what the sandbox observed. A passing test suite alone never produces "verified".
7. **Show the developer what changed.** The diff, impact analysis, evidence, and a resolution report are presented for review. Approval records a decision and changes no files.

## Features

- Local-path repositories, indexed into a versioned code graph for JavaScript, TypeScript, and SQL: files, symbols, calls, routes, client requests, events, data access, and configuration reads. Indexing only parses text and is incremental.
- Cited answers to engineering questions and feasibility and change-size assessments, with the evidence and its limits.
- Patch impact analysis for two revisions or a diff: what changed, which tests cover it, and what it can reach.
- The investigation pipeline described above, with dependency preparation behind an egress-restricted proxy and browser reproduction for UI bugs.
- Review and approval of patches, resolution reports, and an audit trail.
- A web workspace (React) for repositories, graph exploration, questions, impact, investigations, and review.
- A local stdio MCP server so coding agents can use Tracera (see below).

**Stack:** TypeScript on Node.js, Fastify, PostgreSQL with Drizzle ORM, pg-boss for background jobs, Zod schemas shared through `packages/contracts`, React with Vite and Tailwind for the web app, Docker for the sandbox, Vitest and Playwright for tests.

## Models

Tracera's inference runs on Meta's Muse models through the Meta Model API (Muse Spark 1.3 by default). Set `TRACERA_INFERENCE_PROVIDER=meta` and `TRACERA_META_API_KEY`. An OpenAI-compatible adapter (`TRACERA_INFERENCE_PROVIDER=openai_compatible`) is available as an alternative, and a deterministic mock provider (`mock`, the default) needs no key and is meant for tests and offline use. Every model call goes through one gateway that redacts secrets, enforces budgets, and validates structured output. Results are labelled `[mock]` or `[live]` so mock output is never mistaken for analysis.

## Architecture

- `apps/server`: the REST API and the background worker (one codebase, two entrypoints), plus the inference gateway and the Docker sandbox executor.
- `apps/web`: the web workspace.
- `apps/mcp`: the MCP server.
- `packages/contracts`: every request, response, and model-output schema.
- PostgreSQL for state and the job queue; Docker for sandboxed execution.

## Getting started

Prerequisites: Node.js 24, Docker, and git.

```sh
npm ci
cp .env.example .env     # then edit .env (variables below)
npm run db:up            # PostgreSQL in Docker
npm run db:migrate
npm run db:seed          # creates the owner account from the seed variables
npm run sandbox:pull     # pulls the pinned sandbox images
npm run dev              # API and worker, http://127.0.0.1:8787
npm run dev:web          # web app, http://127.0.0.1:5173
```

Open the web app and sign in with the seed owner credentials. With the Vite dev server, `TRACERA_PUBLIC_URL` must equal the web origin (`http://127.0.0.1:5173`): the API rejects changes whose origin differs.

Set these in `.env` (placeholders shown; `.env.example` lists every option):

```sh
POSTGRES_PASSWORD=<database-password>
DATABASE_URL=postgres://tracera:<database-password>@127.0.0.1:5432/tracera
TRACERA_PUBLIC_URL=<web origin>
TRACERA_REPO_ROOTS=<absolute paths, semicolon-separated, that may contain repositories>
TRACERA_SEED_OWNER_EMAIL=<owner email>
TRACERA_SEED_OWNER_PASSWORD=<at least 12 characters>
TRACERA_INFERENCE_PROVIDER=<mock | meta | openai_compatible>
TRACERA_META_API_KEY=<key, when the provider is meta>
# openai_compatible only:
TRACERA_OPENAI_COMPAT_BASE_URL=<base url>
TRACERA_OPENAI_COMPAT_API_KEY=<key>
TRACERA_MODEL_REASONING=<model id>
```

Repositories must be local git work trees inside one of the `TRACERA_REPO_ROOTS` paths. Docker must be running for sandboxed reproduction and verification; with `TRACERA_SANDBOX_MODE=disabled` those stages are recorded as blocked instead of running.

## MCP server

`apps/mcp` is a local stdio MCP server. Coding agents such as Claude Code and Codex use it to search a registered repository, ask evidence-backed questions, estimate change impact, report bugs, run investigations, and read findings, diffs, verification results, and reports. It is a thin client of the REST API: it holds no database connection, opens no ports, runs nothing on your machine, and cannot approve patches.

1. Start the API and create a personal access token with client kind `mcp`: sign in, then `POST /api/v1/tokens` with `{"name": "mcp", "client_kind": "mcp"}` (cookie-authenticated requests need the `X-Tracera-CSRF: 1` header and an `Origin` equal to `TRACERA_PUBLIC_URL`). The response contains the token secret once.
2. Register the server. Run it with `node` directly, not through `npm run`, because npm writes to stdout, which carries the protocol.

| Variable | Default | Meaning |
|---|---|---|
| `TRACERA_API_URL` | `http://127.0.0.1:8787` | API base URL; `https`, or plain `http` only to `127.0.0.1`, `localhost`, or `[::1]` |
| `TRACERA_TOKEN` | none | The token secret. Without it the tools still list, and each call explains how to set it |

Claude Code:

```sh
claude mcp add tracera -s user \
  -e TRACERA_API_URL=http://127.0.0.1:8787 -e TRACERA_TOKEN=<token> \
  -- node /path/to/tracera/apps/mcp/src/index.ts
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.tracera]
command = "node"
args = ["/path/to/tracera/apps/mcp/src/index.ts"]
env_vars = ["TRACERA_TOKEN"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.tracera.env]
TRACERA_API_URL = "http://127.0.0.1:8787"
```

## Google Meet (in progress)

Meeting context from Google Meet is being built and is not available yet. There is nothing to configure today.

## Testing

```sh
npm run check:fast     # typecheck, lint, comment check, unit tests
npm run check          # typecheck, lint, comment check, unit and integration tests (needs npm run db:up)
npm run test:unit      # unit tests
npm run test:int       # integration tests against a local PostgreSQL
npm run test:web       # web app tests
npm run test:mcp       # MCP server tests
npm run test:docker    # sandbox security tests (needs Docker and npm run sandbox:pull)
npm run test:e2e       # browser end-to-end tests of the web app
```

Integration tests run against the local Docker PostgreSQL and refuse remote hosts.

## Security model

- Repository code never runs on the host. Tests, checks, and reproductions run only in the Docker sandbox: no network, read-only root filesystem, non-root user, dropped capabilities, and CPU, memory, process, and time limits. If Docker is unavailable the sandbox stages are blocked; there is no fallback to the host.
- Dependencies are installed from lockfiles without lifecycle scripts, through a proxy that admits only the configured registry.
- Models never act. They return strict-schema JSON that code validates; citations are checked, and hypothesis states and verification outcomes are set only by rules in code.
- Nothing is reported as verified, fixed, or confirmed unless the stored data says so.
- Approval is a review decision made in a signed-in session and changes no files.
- Secrets stay in the server environment: they are not in the web bundle, logs, or API responses, and they are redacted before every model call.
- Every query is scoped to a workspace, cookie-authenticated changes require a custom header and a same-origin request (decided by the matched route, so percent-encoded and absolute-form URL spellings get no bypass), and API tokens are scoped, expiring, and stored hashed.
- Two integration suites hold every registered route to a written access rule (`apps/server/test/security-routes.ts`): a security matrix for authentication, token scopes, owner-only routes, and CSRF, and a workspace isolation suite for foreign IDs. A new route fails them until its rule is added.
- Repository files, logs, and other inputs are treated as untrusted data.

## Known limitations

- Repositories are local paths only. There is no integration with GitHub or other hosted Git providers: no remote cloning, sync, or pull-request creation.
- Applying a patch to a working tree, committing, pushing, and opening a pull request are not implemented. Approval records a decision only.
- Google Meet integration is in progress. There is no browser extension in this repository.
- The code graph parses JavaScript, TypeScript, and SQL. Other languages are detected and counted but not parsed.
- The Meta adapter is exercised in automated tests against a local stand-in server; running it for real needs a Meta Model API key with billing enabled.
- Accounts come from `npm run db:seed`; there is no sign-up flow, and personal access tokens are created through the REST API because the web app has no token screen.

## Deployment

Not configured yet. Tracera runs locally with the steps above; there is no container image for the API or web app, no CI pipeline, and no hosted environment.

## License

MIT. See [LICENSE](LICENSE).
