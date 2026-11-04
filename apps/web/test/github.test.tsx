import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ids, json, renderApp, session, sha, stubApi } from "./support.tsx";

// TEST DOUBLES ONLY: replies copy the shape of the server's GitHub views so each state of the panel
// on the repositories page can be checked without a server and without GitHub.

const at = "2026-10-24T09:00:00.000Z";
const GHI = "ghi_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
const RUP = "rup_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
const WHD = "whd_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
const ME = "GET /api/v1/auth/me";
const LIST = "GET /api/v1/repositories";
const STATUS = "GET /api/v1/github/status";
const REPOSITORIES = `GET /api/v1/github/installations/${GHI}/repositories`;
const CONNECT = `POST /api/v1/github/installations/${GHI}/repositories`;
const SYNC_STATUS = `GET /api/v1/repositories/${ids.repo}/sync`;
const SYNC = `POST /api/v1/repositories/${ids.repo}/sync`;
const VARIABLES = [
	"TRACERA_GITHUB_APP_ID",
	"TRACERA_GITHUB_APP_PRIVATE_KEY_PATH",
	"TRACERA_GITHUB_WEBHOOK_SECRET",
	"TRACERA_GITHUB_CLIENT_ID",
	"TRACERA_GITHUB_CLIENT_SECRET",
];

const status = (overrides: Record<string, unknown> = {}) => ({
	configured: true,
	missing: [],
	webhook_path: "/api/v1/webhooks/github",
	callback_path: "/api/v1/github/callback",
	required_permissions: { contents: "read", metadata: "read" },
	events: ["push", "pull_request", "repository"],
	app: null,
	app_error: null,
	installations: [],
	...overrides,
});
const installation = (overrides: Record<string, unknown> = {}) => ({
	id: GHI,
	installation_id: 42,
	account_login: "acme",
	account_type: "Organization",
	repository_selection: "selected",
	permissions: { contents: "read", metadata: "read" },
	events: ["push"],
	status: "active",
	permission_problems: [],
	permission_warnings: [],
	created_at: at,
	updated_at: at,
	...overrides,
});
const candidate = (overrides: Record<string, unknown> = {}) => ({
	github_repository_id: 7,
	full_name: "acme/shop",
	private: true,
	default_branch: "main",
	archived: false,
	connected_repository_id: null,
	...overrides,
});
const update = (overrides: Record<string, unknown> = {}) => ({
	id: RUP,
	repository_id: ids.repo,
	trigger: "manual",
	ref: "main",
	target_sha: null,
	indexed_sha: null,
	status: "pending",
	snapshot_id: null,
	patch_analysis_id: null,
	pull_request: null,
	delivery_id: null,
	attempts: 0,
	coalesced: 0,
	error: null,
	created_at: at,
	started_at: null,
	finished_at: null,
	...overrides,
});
const syncStatus = (overrides: Record<string, unknown> = {}) => ({
	repository_id: ids.repo,
	source: "github",
	tracked_ref: "main",
	freshness: null,
	latest_indexed: {
		snapshot_id: ids.snapNew,
		commit_sha: sha.indexed,
		status: "ready",
		finished_at: at,
	},
	last_synced_at: at,
	summary: {
		pending: 0,
		failed: 0,
		failed_deliveries: 0,
		latest_known_commit: null,
		last_failure: null,
	},
	pending: [],
	failed: [],
	recent: [],
	deliveries: {
		failed: [],
		recent: [
			{
				id: WHD,
				delivery_guid: "delivery-1",
				event: "push",
				action: null,
				status: "processed",
				reason: null,
				error: null,
				attempts: 1,
				next_attempt_at: null,
				received_at: at,
				processed_at: at,
			},
		],
	},
	github: {
		installation: GHI,
		full_name: "acme/shop",
		private: true,
		access: "active",
	},
	reconciliation: { interval_seconds: 300 },
	...overrides,
});
const empty = () => json({ items: [], next_cursor: null });
const panel = async () =>
	within(await screen.findByRole("region", { name: "GitHub" }));

describe("the GitHub panel on the repositories page", () => {
	it("says the server is not configured and names the unset variables", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[STATUS]: json(status({ configured: false, missing: VARIABLES })),
		});
		renderApp("/");
		const github = await panel();
		expect(
			await github.findByText("GitHub is not configured on this server."),
		).toBeTruthy();
		for (const name of VARIABLES) expect(github.getByText(name)).toBeTruthy();
		expect(github.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
	});

	it("offers an owner Connect GitHub when no account is connected, and asks the server for the install address", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[STATUS]: json(status()),
			"GET /api/v1/github/install": json({
				url: "https://github.com/apps/tracera-test/installations/new?state=s",
				expires_in_seconds: 600,
			}),
		});
		renderApp("/");
		const github = await panel();
		expect(
			await github.findByText("No GitHub account is connected."),
		).toBeTruthy();
		fireEvent.click(github.getByRole("button", { name: "Connect GitHub" }));
		await waitFor(() =>
			expect(calls.some((call) => call.path === "/api/v1/github/install")).toBe(
				true,
			),
		);
	});

	it("tells a member that an owner connects GitHub", async () => {
		const member = session();
		member.workspace.role = "member";
		stubApi({
			[ME]: json(member),
			[LIST]: empty(),
			[STATUS]: json(status()),
		});
		renderApp("/");
		const github = await panel();
		expect(
			await github.findByText(/A workspace owner connects GitHub/),
		).toBeTruthy();
		expect(github.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
	});

	it("lists the installation's repositories and connects the one picked with the commands shown", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[STATUS]: json(status({ installations: [installation()] })),
			[REPOSITORIES]: json({
				repositories: [
					candidate(),
					candidate({
						github_repository_id: 8,
						full_name: "acme/docs",
						private: false,
					}),
				],
				truncated: false,
			}),
			[CONNECT]: json(
				{
					repository: { id: ids.repo, name: "shop" },
					update: update({ trigger: "connect" }),
				},
				201,
			),
		});
		renderApp("/");
		const github = await panel();
		expect(await github.findByText("acme/shop")).toBeTruthy();
		expect(github.getByText("acme/docs")).toBeTruthy();
		fireEvent.change(github.getByLabelText("Test command"), {
			target: { value: "npm run test:unit" },
		});
		fireEvent.click(
			github.getAllByRole("button", { name: "Connect" })[0] as HTMLElement,
		);
		await waitFor(() =>
			expect(
				calls.find(
					(call) => call.method === "POST" && call.path === CONNECT.slice(5),
				)?.body,
			).toEqual({
				github_repository_id: 7,
				commands: {
					install: "npm ci --ignore-scripts",
					test: "npm run test:unit",
				},
			}),
		);
	});

	it("shows what the API reports about a connected repository and requests a sync on demand", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[STATUS]: json(status({ installations: [installation()] })),
			[REPOSITORIES]: json({
				repositories: [candidate({ connected_repository_id: ids.repo })],
				truncated: false,
			}),
			[SYNC_STATUS]: json(
				syncStatus({
					summary: {
						pending: 0,
						failed: 1,
						failed_deliveries: 0,
						latest_known_commit: null,
						last_failure: {
							update_id: RUP,
							code: "sync_failed",
							message: "The fetch failed",
							at,
						},
					},
				}),
			),
			[SYNC]: json({ update: update() }, 202),
		});
		renderApp("/");
		const github = await panel();
		expect(await github.findByText(/0 pending, 1 failed/)).toBeTruthy();
		expect(github.getByText("sync_failed")).toBeTruthy();
		expect(github.getByText(/last webhook/)).toBeTruthy();
		expect(github.queryByRole("button", { name: "Connect" })).toBeNull();
		fireEvent.click(github.getByRole("button", { name: "Sync" }));
		await waitFor(() =>
			expect(
				calls.some(
					(call) => call.path === SYNC.slice(5) && call.method === "POST",
				),
			).toBe(true),
		);
	});

	it("lists a withdrawn permission instead of the repositories", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[STATUS]: json(
				status({
					installations: [
						installation({ permission_problems: ["missing:contents:read"] }),
					],
				}),
			),
		});
		renderApp("/");
		const github = await panel();
		expect(await github.findByText(/missing:contents:read/)).toBeTruthy();
		expect(calls.some((call) => call.path === REPOSITORIES.slice(4))).toBe(
			false,
		);
	});
});
