import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { POLL_MS } from "../src/repositories.tsx";
import {
	coverage,
	freshness,
	ids,
	index,
	json,
	problem,
	profile,
	renderApp,
	repository,
	session,
	sha,
	signedIn,
	snapshot,
	stubApi,
} from "./support.tsx";

const ME = "GET /api/v1/auth/me";
const LIST = "GET /api/v1/repositories";
const REPO = `GET /api/v1/repositories/${ids.repo}`;
const SNAPSHOTS = `GET /api/v1/repositories/${ids.repo}/snapshots`;
const profileOf = (id: string) => `GET /api/v1/repositories/${id}/profile`;
const list = (...items: unknown[]) => json({ items, next_cursor: null });

async function rowOf(name: string): Promise<HTMLElement> {
	const row = (await screen.findByRole("link", { name })).closest("li");
	if (!row) throw new Error(`No row for ${name}`);
	return row;
}

/** The value next to a <dt> label. */
const fact = (container: HTMLElement, label: string) =>
	within(container).getByText(label).nextElementSibling?.textContent;

function fillSignIn(password: string) {
	fireEvent.change(screen.getByLabelText("Email"), {
		target: { value: "owner@example.com" },
	});
	fireEvent.change(screen.getByLabelText("Password"), {
		target: { value: password },
	});
	fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("session", () => {
	it("redirects to sign-in on 401, signs in with the CSRF header, and returns to the page", async () => {
		let authenticated = false;
		const calls = stubApi({
			[ME]: () =>
				authenticated
					? json(session())
					: problem(
							401,
							"unauthenticated",
							"Sign in or provide a valid personal access token",
						),
			"POST /api/v1/auth/login": () => {
				authenticated = true;
				return json(signedIn());
			},
			[REPO]: () => json({ repository: repository() }),
			[SNAPSHOTS]: () => json({ snapshots: [snapshot()] }),
			[profileOf(ids.repo)]: () => json(profile()),
		});
		renderApp(`/repositories/${ids.repo}`);
		await screen.findByRole("heading", { name: "Sign in" });
		fillSignIn("correct horse");
		expect(
			await screen.findByRole("heading", { level: 1, name: "bench-shop" }),
		).toBeTruthy();
		const login = calls.find((call) => call.method === "POST");
		expect(login?.path).toBe("/api/v1/auth/login");
		expect(login?.headers["x-tracera-csrf"]).toBe("1");
		expect(login?.body).toEqual({
			email: "owner@example.com",
			password: "correct horse",
		});
	});

	it("shows a rejected sign-in with its code and stays on the form", async () => {
		stubApi({
			"POST /api/v1/auth/login": problem(
				401,
				"invalid_credentials",
				"Email or password is incorrect",
			),
		});
		renderApp("/sign-in");
		fillSignIn("wrong password");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Email or password is incorrect");
		expect(alert.textContent).toContain("invalid_credentials");
		expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
	});

	it("returns to sign-in when the session ends while the app is in use", async () => {
		stubApi({ [ME]: json(session()), [LIST]: problem(401, "unauthenticated") });
		renderApp("/");
		expect(
			await screen.findByRole("heading", { name: "Sign in" }),
		).toBeTruthy();
	});

	it("shows who is signed in and signs out with the CSRF header", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: list(),
			"POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
		});
		renderApp("/");
		// The account menu names the user, the workspace, and the role.
		fireEvent.click(
			await screen.findByRole("button", { name: /account menu/ }),
		);
		expect(screen.getByText("Acme")).toBeTruthy();
		expect(screen.getByText("(owner)")).toBeTruthy();
		expect(screen.getAllByText("Ada Owner").length).toBeGreaterThan(0);
		// jsdom hides the closed popover but does not run popovertarget invocation; the Playwright
		// journey opens the real menu in a browser.
		fireEvent.click(
			screen.getByRole("button", { name: "Sign out", hidden: true }),
		);
		expect(
			await screen.findByRole("heading", { name: "Sign in" }),
		).toBeTruthy();
		const logout = calls.find((call) => call.path === "/api/v1/auth/logout");
		expect(logout?.headers["x-tracera-csrf"]).toBe("1");
	});
});

describe("repository overview", () => {
	it("shows a loading state", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: () => new Promise<Response>(() => {}),
		});
		renderApp("/");
		expect(await screen.findByText("Loading repositories…")).toBeTruthy();
	});

	it("shows an empty state that links owners to registration", async () => {
		stubApi({ [ME]: json(session()), [LIST]: list() });
		renderApp("/");
		expect(
			await screen.findByText("No repositories in this workspace yet."),
		).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: "Register a repository" })
				.getAttribute("href"),
		).toBe("/repositories/new");
	});

	it("does not offer registration to members", async () => {
		const member = session();
		member.workspace.role = "member";
		stubApi({ [ME]: json(member), [LIST]: list() });
		renderApp("/");
		expect(await screen.findByText(/ask an owner to add one/)).toBeTruthy();
		expect(screen.queryByRole("link", { name: /Register/ })).toBeNull();
	});

	it("shows an API error with its code and request ID", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: problem(500, "internal_error", "An unexpected error occurred"),
		});
		renderApp("/");
		const notice = (await screen.findByText("Repositories could not be loaded"))
			.parentElement;
		expect(notice?.textContent).toContain("An unexpected error occurred");
		expect(notice?.textContent).toContain("internal_error");
		expect(notice?.textContent).toContain("req-test-1");
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});

	it("shows an error for a malformed response and none of its data", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: json({
				items: [{ id: "repo_x", name: "ghost-repo" }],
				next_cursor: null,
			}),
		});
		renderApp("/");
		expect(
			await screen.findByText("Repositories could not be loaded"),
		).toBeTruthy();
		expect(screen.getByText(/did not have the expected shape/)).toBeTruthy();
		expect(screen.getByText("invalid_response")).toBeTruthy();
		expect(screen.queryByText("ghost-repo")).toBeNull();
	});

	it("keeps every repository's own data when one profile fails", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: list(
				repository(),
				repository({
					id: ids.repo2,
					name: "billing-api",
					source_type: "local_path",
					synthetic: false,
					index: index({ status: "partial" }),
				}),
			),
			[profileOf(ids.repo)]: json(profile()),
			[profileOf(ids.repo2)]: problem(
				500,
				"internal_error",
				"An unexpected error occurred",
			),
		});
		renderApp("/");
		const healthy = await rowOf("bench-shop");
		expect(await within(healthy).findByText("Complete")).toBeTruthy();
		expect(fact(healthy, "Unresolved calls")).toBe("14");
		expect(within(healthy).getByText("Up to date")).toBeTruthy();

		const broken = await rowOf("billing-api");
		expect(
			await within(broken).findByText(
				"Coverage and freshness could not be loaded",
			),
		).toBeTruthy();
		expect(broken.textContent).toContain("internal_error");
		expect(within(broken).getByText("Partial")).toBeTruthy();
	});

	it("shows indexing progress, announces status changes, and polls until indexing ends", async () => {
		let polls = 0;
		const indexing = index({
			status: "indexing",
			finished_at: null,
			progress: {
				phase: "parsing",
				done: 120,
				total: 450,
				updated_at: "2026-10-24T09:00:01.000Z",
			},
		});
		stubApi({
			[ME]: json(session()),
			[LIST]: () => {
				polls += 1;
				return list(repository({ index: polls === 1 ? indexing : index() }));
			},
			[profileOf(ids.repo)]: () =>
				polls === 1
					? problem(
							409,
							"graph_not_indexed",
							"This repository has no completed graph snapshot yet; request indexing first",
						)
					: json(profile()),
		});
		renderApp("/");
		const bar = await screen.findByRole("progressbar", {
			name: "Indexing, phase parsing",
		});
		expect(bar.getAttribute("value")).toBe("120");
		expect(bar.getAttribute("max")).toBe("450");
		expect(screen.getByText(/120 of 450/)).toBeTruthy();
		expect(screen.getByText("bench-shop: indexing, parsing")).toBeTruthy();
		expect(await screen.findByText(/No usable snapshot yet/)).toBeTruthy();

		expect(
			await screen.findByText(
				"bench-shop: ready",
				{},
				{ timeout: POLL_MS + 2000 },
			),
		).toBeTruthy();
		expect(await screen.findByText("Complete")).toBeTruthy();
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(polls).toBe(2);
	});

	it("shows stale freshness with its reasons and both commits", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: list(repository()),
			[profileOf(ids.repo)]: json(
				profile({
					freshness: freshness({
						stale: true,
						current_commit: sha.current,
						reasons: ["ref_moved"],
					}),
				}),
			),
		});
		renderApp("/");
		const row = await rowOf("bench-shop");
		expect(await within(row).findByText("Stale")).toBeTruthy();
		expect(
			within(row).getByText(/The ref has moved since indexing/),
		).toBeTruthy();
		expect(fact(row, "Indexed commit")).toBe(sha.indexed.slice(0, 12));
		expect(fact(row, "Current commit")).toBe(sha.current.slice(0, 12));
	});

	it("says when a repository has no snapshot, without requesting its profile", async () => {
		const calls = stubApi({
			[ME]: json(session()),
			[LIST]: list(repository({ index: null })),
		});
		renderApp("/");
		const row = await rowOf("bench-shop");
		expect(within(row).getByText("No snapshot yet.")).toBeTruthy();
		expect(
			within(row).getByText("Not available: the repository has no snapshot."),
		).toBeTruthy();
		expect(calls.some((call) => call.path.endsWith("/profile"))).toBe(false);
	});

	it("shows a failed newest snapshot beside the coverage of the older usable one", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: list(
				repository({
					index: index({
						status: "failed",
						commit_sha: sha.current,
						error: {
							code: "clone_failed",
							message: "git could not clone the repository",
							retryable: true,
						},
					}),
				}),
			),
			[profileOf(ids.repo)]: json(
				profile({
					snapshot: snapshot({ id: ids.snapOld, status: "partial" }),
					latest_snapshot: snapshot({
						status: "failed",
						commit_sha: sha.current,
					}),
					coverage: coverage({
						complete: false,
						parse_failures: [
							{ path: "src/broken.ts", message: "Unexpected token", line: 3 },
						],
					}),
				}),
			),
		});
		renderApp("/");
		const row = await rowOf("bench-shop");
		expect(within(row).getByText("Failed")).toBeTruthy();
		expect(within(row).getByText("clone_failed")).toBeTruthy();
		expect(
			await within(row).findByText(/A newer snapshot is failed\./),
		).toBeTruthy();
		expect(within(row).getByText("Partial")).toBeTruthy();
		expect(fact(row, "Parse failures")).toBe("1");
	});
});

describe("repository page", () => {
	it("shows the repository, its coverage details, and recent snapshots", async () => {
		stubApi({
			[ME]: json(session()),
			[REPO]: json({ repository: repository() }),
			[SNAPSHOTS]: json({
				snapshots: [
					snapshot(),
					snapshot({
						id: ids.snapOld,
						status: "failed",
						commit_sha: sha.current,
						error: { code: "context_timeout", message: "Indexing timed out" },
					}),
				],
			}),
			[profileOf(ids.repo)]: json(
				profile({
					coverage: coverage({
						complete: false,
						parse_failures: [
							{
								path: "src/legacy/parser.js",
								message: "Unexpected token (3:14)",
								line: 3,
							},
						],
						notes: [
							"1 file(s) could not be parsed; their symbols and edges are missing.",
						],
					}),
				}),
			),
		});
		renderApp(`/repositories/${ids.repo}`);
		expect(
			await screen.findByRole("heading", { level: 1, name: "bench-shop" }),
		).toBeTruthy();
		const snapshots = within(
			await screen.findByRole("region", { name: "Recent snapshots" }),
		);
		expect(await snapshots.findByText("context_timeout")).toBeTruthy();
		expect(snapshots.getAllByRole("listitem")).toHaveLength(2);
		const graph = within(screen.getByRole("region", { name: "Graph" }));
		expect(await graph.findByText("src/legacy/parser.js:3")).toBeTruthy();
		expect(graph.getByText(/could not be parsed/)).toBeTruthy();
		expect(graph.getByText("Partial")).toBeTruthy();
	});

	it("does not call the API for a malformed repository ID", async () => {
		const calls = stubApi({ [ME]: json(session()) });
		renderApp("/repositories/not-an-id");
		expect(
			await screen.findByRole("heading", { name: "Repository not found" }),
		).toBeTruthy();
		expect(
			calls.map((call) => call.path).filter((path) => path !== "/readyz"),
		).toEqual(["/api/v1/auth/me"]);
	});

	it("shows the API's not_found problem", async () => {
		stubApi({
			[ME]: json(session()),
			[REPO]: problem(404, "not_found", `Repository ${ids.repo} was not found`),
		});
		renderApp(`/repositories/${ids.repo}`);
		expect(
			await screen.findByRole("heading", { name: "Repository not found" }),
		).toBeTruthy();
		expect(
			screen.getByText(`Repository ${ids.repo} was not found`),
		).toBeTruthy();
	});
});
