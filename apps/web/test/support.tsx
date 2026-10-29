import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { vi } from "vitest";
import { createQueryClient, routes } from "../src/app.tsx";

// TEST DOUBLES ONLY. These stand in for the Tracera API so the client's handling of each response can
// be checked; the shapes copy the server's view functions (see src/schemas.ts).

export type Call = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	credentials: RequestCredentials | undefined;
};
type Reply = Response | (() => Response | Promise<Response>);

/** Replaces fetch with a table of `"<METHOD> <path>"` replies and records every call. */
export function stubApi(replies: Record<string, Reply>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			calls.push({
				method,
				path: input,
				headers: { ...(init.headers as Record<string, string>) },
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
				credentials: init.credentials,
			});
			const reply = replies[`${method} ${input}`];
			if (!reply)
				return problem(
					404,
					"not_found",
					`No test reply for ${method} ${input}`,
				);
			return typeof reply === "function" ? reply() : reply.clone();
		}),
	);
	return calls;
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const problem = (status: number, code: string, detail = code) =>
	new Response(
		JSON.stringify({
			type: `urn:tracera:problem:${code}`,
			title: "Error",
			status,
			detail,
			code,
			request_id: "req-test-1",
		}),
		{ status, headers: { "content-type": "application/problem+json" } },
	);

export function renderApp(path: string) {
	const router = createMemoryRouter(routes, { initialEntries: [path] });
	const queryClient = createQueryClient(router);
	// Retries of 5xx answers would only slow the tests down.
	queryClient.setQueryDefaults([], { retry: false });
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { router };
}

// ---- Fixtures shaped like the server's views ----------------------------------------------------

export const ids = {
	user: "usr_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	workspace: "wsp_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	repo: "repo_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	repo2: "repo_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D",
	snapNew: "snap_01JC9Z3K8Q5V7W2X4Y6Z8A0B3E",
	snapOld: "snap_01JC9Z3K8Q5V7W2X4Y6Z8A0B4F",
};
export const sha = {
	indexed: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
	current: "9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
};
const at = "2026-10-24T09:00:00.000Z";

export const session = () => ({
	user: { id: ids.user, email: "owner@example.com", display_name: "Ada Owner" },
	workspace: { id: ids.workspace, name: "Acme", role: "owner" },
	auth: { type: "session", scopes: null },
});

export const signedIn = () => ({
	user: { id: ids.user, email: "owner@example.com", display_name: "Ada Owner" },
	workspace: { id: ids.workspace, name: "Acme", role: "owner" },
});

export const index = (overrides: Record<string, unknown> = {}) => ({
	snapshot_id: ids.snapNew,
	status: "ready",
	commit_sha: sha.indexed,
	coverage_complete: true,
	progress: null,
	error: null,
	created_at: at,
	finished_at: at,
	...overrides,
});

export const repository = (overrides: Record<string, unknown> = {}) => ({
	id: ids.repo,
	name: "bench-shop",
	source_type: "fixture",
	source_display: "C:/Users/dev/.tracera/fixtures/bench-shop",
	default_branch: "main",
	synthetic: true,
	commands: {
		install: "npm ci",
		test: "npm test",
		typecheck: null,
		lint: null,
		build: null,
		start: null,
	},
	app: null,
	allow_install_scripts: false,
	index: index(),
	created_at: at,
	updated_at: at,
	...overrides,
});

export const snapshot = (overrides: Record<string, unknown> = {}) => ({
	id: ids.snapNew,
	repository_id: ids.repo,
	ref: "main",
	commit_sha: sha.indexed,
	status: "ready",
	extractor_version: "graph-extract.v3",
	previous_snapshot_id: null,
	coverage_complete: true,
	stats: { nodes: 812, edges: 2290 },
	progress: null,
	cancel_requested_at: null,
	error: null,
	created_at: at,
	started_at: at,
	finished_at: at,
	...overrides,
});

export const coverage = (overrides: Record<string, unknown> = {}) => ({
	complete: true,
	extractor_version: "graph-extract.v3",
	parsed_files: 120,
	parse_failures: [],
	unsupported_code_files: {},
	skipped: {},
	unresolved: {
		imports: 2,
		calls: 14,
		member_calls: 5,
		requests: 1,
		route_handlers: 0,
		routes_with_unknown_prefix: 0,
	},
	truncated_files: [],
	notes: [],
	...overrides,
});

export const freshness = (overrides: Record<string, unknown> = {}) => ({
	stale: false,
	ref: "main",
	indexed_commit: sha.indexed,
	current_commit: sha.indexed,
	reasons: [],
	checked_at: at,
	...overrides,
});

export const profile = (overrides: Record<string, unknown> = {}) => ({
	snapshot: snapshot(),
	profile: { tracked_files: 130, indexed_files: 128 },
	coverage: coverage(),
	freshness: freshness(),
	latest_snapshot: null,
	...overrides,
});
