import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAssessJob } from "../../server/src/modules/assessment.ts";
import { runIndexJob } from "../../server/src/modules/graph.ts";
import { workspacesRoot } from "../../server/src/modules/workspace.ts";
import { QUEUES } from "../../server/src/queue.ts";
import type { SandboxRunRequest } from "../../server/src/sandbox/executor.ts";
import {
	BUG,
	createFixtureRepository,
	SCENARIO,
} from "../../server/test/e2e/fixture.ts";
import { createFixtureProvider } from "../../server/test/e2e/fixture-provider.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	driveInvestigation,
	type FakeRun,
	fakeExecutor,
	login,
	repositoryBody,
	resetDatabase,
	type TestContext,
	tapOutput,
} from "../../server/test/helpers.ts";
import { createApi, loadConfig, VERSION } from "../src/api.ts";
import { buildServer } from "../src/server.ts";

// The MCP server against the real API over loopback HTTP, the test database, the E2E fixture
// repository, the fixture provider [mock], and the fake sandbox executor (no Docker, no model).

let ctx: TestContext;
let base: string;
let session: ReturnType<typeof asSession>;
let token: string;

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.app.listen({ host: "127.0.0.1", port: 0 });
	base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	const cookie = await login(ctx);
	session = asSession(ctx, cookie);
	token = await createToken(ctx, cookie, { name: "agent", client_kind: "mcp" });
});

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (result: ToolResult) =>
	(result.content as Array<{ text?: string }>)
		.map((block) => block.text ?? "")
		.join("\n");
/** A nested value of a tool result's structured content. */
function pick<T = string>(
	result: ToolResult,
	...keys: Array<string | number>
): T {
	let value: unknown = result.structuredContent;
	for (const key of keys)
		value = (value as Record<string | number, unknown> | undefined)?.[key];
	return value as T;
}

/** An MCP client connected in memory to a fresh server that uses `secret` against the real API. */
async function agent(secret = token) {
	const server = buildServer(
		createApi(loadConfig({ TRACERA_API_URL: base, TRACERA_TOKEN: secret })),
	);
	const client = new Client({ name: "j07-agent", version: "1.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	await client.connect(clientSide);
	await client.listTools(); // the client then validates structuredContent against outputSchema
	return (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args });
}

/** Registers the E2E fixture repository and indexes it in-process, as the worker would. */
async function registerFixture(as: typeof session, name: string) {
	const dir = createFixtureRepository(path.join(ctx.repoRoot, name));
	const response = await as(
		"POST",
		"/api/v1/repositories",
		repositoryBody(dir, name),
	);
	expect(response.statusCode).toBe(201);
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: { snapshotId: string };
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' LIMIT 1",
			[QUEUES.index],
		);
		const job = rows[0];
		if (!job) break;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await runIndexJob({ db: ctx.db, config: ctx.config }, job.data.snapshotId);
	}
	return { dir, id: response.json().repository.id as string };
}

/** node:test simulated without executing code: the bug marker in the run copy decides the result. */
function script(request: SandboxRunRequest): FakeRun {
	const buggy = readFileSync(
		path.join(request.workspace, "src", "math.js"),
		"utf8",
	).includes(BUG.marker);
	if (request.argv.includes(".tracera/repro/repro.mjs"))
		return {
			exitCode: buggy ? 1 : 0,
			stdout: tapOutput([
				{ name: "string prices are added as numbers", ok: !buggy },
			]),
		};
	return {
		exitCode: 0,
		stdout: tapOutput([{ name: "total sums prices", ok: true }]),
	};
}

async function tokenId(): Promise<string> {
	return (await session("GET", "/api/v1/tokens")).json().items[0].id;
}

describe("J-07: a coding agent completes an investigation through MCP [mock inference, fake executor]", () => {
	it("discovers, reports, investigates, and reads status, findings, diff, verification, and report", async () => {
		const repository = await registerFixture(session, "tiny-mcp");
		const call = await agent();

		// Discovery and repository intelligence.
		const repos = await call("tracera_list_repositories");
		expect(repos.structuredContent).toMatchObject({
			repositories: [{ id: repository.id, index: { status: "ready" } }],
		});
		const status = await call("tracera_get_repository_status", {
			repository_id: repository.id,
		});
		expect(status.structuredContent).toMatchObject({
			freshness: { stale: false },
			coverage: { complete: true },
			profile: { test_files: 1 },
		});
		const search = await call("tracera_search_code", {
			repository_id: repository.id,
			query: "total",
		});
		const results = pick<
			Array<{ node: { id: string; name: string; kind: string } | null }>
		>(search, "results");
		const total = results.find(
			(result) =>
				result.node?.name === "total" && result.node.kind === "function",
		)?.node;
		expect(total).toBeDefined();
		const node = await call("tracera_get_graph_node", {
			node_id: total?.id,
		});
		expect(node.structuredContent).toMatchObject({
			node: { name: "total", path: "src/math.js" },
			untrusted_content: true,
		});
		expect(pick(node, "evidence", "excerpt")).toContain("items.reduce");
		const trace = await call("tracera_trace_flow", {
			node_id: total?.id,
			direction: "upstream",
		});
		expect(trace.isError).toBeFalsy();
		const impact = await call("tracera_get_change_impact", {
			repository_id: repository.id,
			targets: [{ kind: "symbol", name: "add", path: "src/math.js" }],
		});
		expect(
			pick<Array<{ node: { name: string } }>>(impact, "affected").map(
				(item) => item.node.name,
			),
		).toContain("total");

		// An engineering question, answered by the fixture provider [mock].
		const asked = await call("tracera_ask_question", {
			repository_id: repository.id,
			question: "Where is the order total computed?",
		});
		const assessmentId = pick(asked, "assessment", "id");
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.assess,
		]);
		await runAssessJob(
			{ db: ctx.db, config: ctx.config, provider: createFixtureProvider() },
			assessmentId,
		);
		const answered = await call("tracera_get_answer", {
			assessment_id: assessmentId,
			wait_seconds: 0,
		});
		expect(textOf(answered)).toContain("[mock]");
		expect(
			pick<Array<{ supported: boolean }>>(answered, "answer", "claims").map(
				(claim) => claim.supported,
			),
		).toEqual([true, false]);
		expect(pick(answered, "answer", "inference_mode")).toBe("mock");

		// Report the bug; a retry with the same arguments returns the same report.
		const bugArgs = {
			title: `${SCENARIO.verified} String prices are concatenated`,
			description: 'total() returns "023" for prices "2" and 3.',
			expected_behavior: "total([{price: '2'}, {price: 3}]) is 5",
			repository_id: repository.id,
			logs: [
				{
					kind: "stack_trace",
					content: "AssertionError: '023' !== 5\n    at src/math.js:6:22",
				},
			],
		};
		const created = await call("tracera_create_bug_report", bugArgs);
		expect(created.structuredContent).toMatchObject({
			bug_report: {
				status: "open",
				source_channel: "mcp",
				evidence: [{ kind: "stack_trace" }],
			},
		});
		const bugId = pick(created, "bug_report", "id");
		expect(
			pick(
				await call("tracera_create_bug_report", bugArgs),
				"bug_report",
				"id",
			),
		).toBe(bugId);

		// Investigate. MCP investigations are never interactive.
		const started = await call("tracera_start_investigation", {
			bug_report_id: bugId,
		});
		expect(textOf(started)).toContain("[mock]");
		const investigationId = pick(started, "investigation", "id");
		const startedVersion = pick<number>(
			started,
			"investigation",
			"state_version",
		);
		expect(
			(await session("GET", `/api/v1/investigations/${investigationId}`)).json()
				.investigation.interactive,
		).toBe(false);
		const executor = fakeExecutor(workspacesRoot(ctx.config), script);
		await driveInvestigation(
			ctx,
			{
				config: ctx.config,
				db: ctx.db,
				pool: ctx.pool,
				boss: ctx.boss,
				provider: createFixtureProvider(),
				executor,
				workerId: "test-worker",
			},
			investigationId,
		);
		expect(executor.runs.length).toBeGreaterThan(0);

		// Poll: the version moved, so the long-poll returns at once.
		const polled = await call("tracera_get_investigation_status", {
			investigation_id: investigationId,
			known_version: startedVersion,
			wait_seconds: 20,
		});
		expect(textOf(polled)).toContain("[mock]");
		expect(polled.structuredContent).toMatchObject({
			investigation: {
				status: "awaiting_approval",
				baseline_reproduction: { status: "reproduced" },
				latest_verification: { outcome: "verified", outcome_reasons: [] },
				inference: { mock: true },
			},
		});
		expect(pick(polled, "next_action")).toContain("MCP cannot approve");

		// Findings: hypotheses, evidence kept apart, and evidence content on request.
		const findings = await call("tracera_get_findings", {
			investigation_id: investigationId,
		});
		expect(textOf(findings)).toContain("[mock]");
		expect(findings.structuredContent).toMatchObject({
			hypotheses: [{ handle: "HYP-1", state: "confirmed" }],
			confirmed_findings: [{ handle: "HYP-1" }],
			model_disclosure: { mock: true },
			untrusted_content: true,
		});
		const codeRef = pick<Array<{ handle: string; content?: string }>>(
			findings,
			"evidence",
			"code_references",
		)[0];
		expect(codeRef?.content).toBeUndefined();
		const withContent = await call("tracera_get_findings", {
			investigation_id: investigationId,
			evidence_handles: [codeRef?.handle],
		});
		expect(
			pick<Array<{ content?: string }>>(
				withContent,
				"evidence",
				"code_references",
			)[0]?.content,
		).toContain("export function total");

		// The proposed patch, the checks that actually ran, and the diff.
		const patch = await call("tracera_get_patch_diff", {
			investigation_id: investigationId,
		});
		expect(textOf(patch)).toContain("[mock]");
		expect(patch.structuredContent).toMatchObject({
			patch: { status: "proposed", files: [{ path: "src/math.js" }] },
			verification: { outcome: "verified" },
			diff: { next_cursor: null },
		});
		expect(pick(patch, "diff", "text")).toContain(
			`+${"\t"}return items.reduce`,
		);
		expect(pick(patch, "diff", "text")).toContain(BUG.fix.replace);
		expect(
			pick<Array<{ kind: string }>>(patch, "verification", "checks").map(
				(check) => check.kind,
			),
		).toContain("reproduction");

		// The report, in both formats, says it was produced with mock inference.
		const markdown = await call("tracera_get_resolution_report", {
			investigation_id: investigationId,
		});
		expect(pick(markdown, "markdown")).toContain(
			"Generated with mock inference",
		);
		const json = await call("tracera_get_resolution_report", {
			investigation_id: investigationId,
			format: "json",
		});
		expect(textOf(json)).toContain("[mock]");
		expect(pick<boolean>(json, "report", "generated_with", "mock")).toBe(true);

		// Every API request the tools made is audited against the token, with the tool name.
		const id = await tokenId();
		const { rows } = await ctx.pool.query<{
			actor_type: string;
			actor_id: string;
			target_type: string;
			target_id: string;
			metadata: { tool: string | null; client: string | null; status: number };
		}>(
			"SELECT actor_type, actor_id, target_type, target_id, metadata FROM audit_events WHERE action = 'mcp.tool_called'",
		);
		expect(rows.length).toBeGreaterThan(20);
		expect(
			rows.every((row) => row.actor_type === "mcp" && row.actor_id === id),
		).toBe(true);
		expect(new Set(rows.map((row) => row.metadata.tool))).toEqual(
			new Set([
				"tracera_list_repositories",
				"tracera_get_repository_status",
				"tracera_search_code",
				"tracera_get_graph_node",
				"tracera_trace_flow",
				"tracera_get_change_impact",
				"tracera_ask_question",
				"tracera_get_answer",
				"tracera_create_bug_report",
				"tracera_start_investigation",
				"tracera_get_investigation_status",
				"tracera_get_findings",
				"tracera_get_patch_diff",
				"tracera_get_resolution_report",
			]),
		);
		expect(rows.every((row) => row.metadata.client === `mcp/${VERSION}`)).toBe(
			true,
		);
		expect(
			rows.some(
				(row) =>
					row.target_type === "investigation" &&
					row.target_id === investigationId,
			),
		).toBe(true);
		const { rows: created_rows } = await ctx.pool.query<{ actor_type: string }>(
			"SELECT actor_type FROM audit_events WHERE action IN ('bug_report.created', 'investigation.created')",
		);
		expect(created_rows.map((row) => row.actor_type)).toEqual(["mcp", "mcp"]);

		// Approval stays a human decision: no tool offers it and the API refuses the token.
		const patchId = pick(patch, "patch", "id");
		const refused = await asToken(ctx, token)(
			"POST",
			`/api/v1/patches/${patchId}/approval`,
			{
				decision: "approved",
				verification_id: pick(patch, "verification", "id"),
			},
		);
		expect(refused.json().code).toBe("session_required");
	}, 120_000);
});

describe("security against the real API", () => {
	it("rejects unknown and revoked tokens", async () => {
		const unknown = await agent(`trc_pat_${"0".repeat(64)}`);
		const denied = await unknown("tracera_list_repositories");
		expect(denied.isError).toBe(true);
		expect(textOf(denied)).toMatch(/^Error \[unauthenticated\]/);

		const call = await agent();
		expect((await call("tracera_list_repositories")).isError).toBeFalsy();
		expect(
			(await session("DELETE", `/api/v1/tokens/${await tokenId()}`)).statusCode,
		).toBe(204);
		expect(textOf(await call("tracera_list_repositories"))).toMatch(
			/^Error \[unauthenticated\]/,
		);
	});

	it("enforces each tool's scope with the token's own scopes", async () => {
		const reporter = await createToken(ctx, await login(ctx), {
			name: "reporter",
			client_kind: "script",
			scopes: ["reports:write"],
		});
		const call = await agent(reporter);
		const listed = await call("tracera_list_repositories");
		expect(textOf(listed)).toMatch(
			/^Error \[insufficient_scope\]: .*repositories:read/,
		);
		const created = await call("tracera_create_bug_report", {
			title: "Scoped",
			description: "Created with a reports:write token",
		});
		expect(pick(created, "bug_report", "source_channel")).toBe("api");
		const started = await call("tracera_start_investigation", {
			bug_report_id: pick(created, "bug_report", "id"),
		});
		expect(textOf(started)).toMatch(
			/^Error \[insufficient_scope\]: .*investigations:write/,
		);
	});

	it("never reveals another workspace's repositories, reports, or investigations", async () => {
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		const foreign = await registerFixture(other, "tiny-foreign");
		const bug = (
			await other("POST", "/api/v1/bug-reports", {
				title: "Foreign",
				description: "Belongs to another workspace",
				repository_id: foreign.id,
				normalize: false,
			})
		).json().bug_report;
		const investigation = (
			await other("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		const own = await registerFixture(session, "tiny-own");

		const call = await agent();
		expect(
			pick<Array<{ id: string }>>(
				await call("tracera_list_repositories"),
				"repositories",
			).map((repo) => repo.id),
		).toEqual([own.id]);
		for (const [name, args] of [
			["tracera_get_repository_status", { repository_id: foreign.id }],
			["tracera_search_code", { repository_id: foreign.id, query: "total" }],
			[
				"tracera_get_change_impact",
				{
					repository_id: foreign.id,
					targets: [{ kind: "file", path: "src/math.js" }],
				},
			],
			[
				"tracera_ask_question",
				{ repository_id: foreign.id, question: "What is total?" },
			],
			[
				"tracera_create_bug_report",
				{ title: "x", description: "y", repository_id: foreign.id },
			],
			["tracera_start_investigation", { bug_report_id: bug.id }],
			[
				"tracera_start_investigation",
				{
					bug_report_id: (
						await session("POST", "/api/v1/bug-reports", {
							title: "own",
							description: "own",
							normalize: false,
						})
					).json().bug_report.id,
					repository_id: foreign.id,
				},
			],
			[
				"tracera_get_investigation_status",
				{ investigation_id: investigation.id },
			],
			["tracera_get_findings", { investigation_id: investigation.id }],
			["tracera_get_patch_diff", { investigation_id: investigation.id }],
			["tracera_get_resolution_report", { investigation_id: investigation.id }],
		] as const) {
			const result = await call(name, args);
			expect(textOf(result), name).toMatch(/^Error \[not_found\]/);
		}
	});

	it("limits each MCP token to 300 reads a minute, without touching other callers, and audits the refusal", async () => {
		const asAgent = asToken(ctx, token);
		// Concurrent batches: the limiter counts in arrival order either way.
		for (let batch = 0; batch < 6; batch++) {
			const statuses = await Promise.all(
				Array.from({ length: 50 }, () =>
					asAgent("GET", "/api/v1/auth/me").then(
						(response) => response.statusCode,
					),
				),
			);
			expect(statuses.every((status) => status === 200)).toBe(true);
		}
		const limited = await asAgent("GET", "/api/v1/auth/me");
		expect(limited.statusCode).toBe(429);
		expect(limited.json().code).toBe("rate_limited");
		expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
		expect((await session("GET", "/api/v1/auth/me")).statusCode).toBe(200);
		const call = await agent();
		expect(textOf(await call("tracera_list_repositories"))).toMatch(
			/^Error \[rate_limited\]: .* Next: Retry in \d+ seconds/,
		);
		// onResponse audits after the reply is sent: allow it a moment to land.
		let audited = 0;
		for (let i = 0; i < 50 && audited === 0; i++) {
			const { rows } = await ctx.pool.query(
				"SELECT 1 FROM audit_events WHERE action = 'mcp.tool_called' AND metadata->>'code' = 'rate_limited'",
			);
			audited = rows.length;
			if (!audited) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(audited).toBeGreaterThan(0);
	}, 60_000);
});

describe("stdio entry", () => {
	it("serves the legacy and the pinned protocol eras from node apps/mcp/src/index.ts", async () => {
		const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: [entry],
				env: {
					...getDefaultEnvironment(),
					TRACERA_API_URL: base,
					TRACERA_TOKEN: token,
				},
				stderr: "pipe",
			});
			let stderr = "";
			transport.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const client = new Client(
				{ name: "stdio-test", version: "1.0.0" },
				{ versionNegotiation: { mode } },
			);
			await client.connect(transport);
			expect(client.getProtocolEra()).toBe(
				mode === "legacy" ? "legacy" : "modern",
			);
			expect((await client.listTools()).tools).toHaveLength(14);
			const result = await client.callTool({
				name: "tracera_list_repositories",
				arguments: {},
			});
			expect(result.isError).toBeFalsy();
			await client.close();
			expect(stderr).toContain(`tracera-mcp ${VERSION} on stdio`);
			expect(stderr).not.toContain(token);
		}
	}, 60_000);
});
