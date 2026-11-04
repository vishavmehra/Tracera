import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryClient, routes } from "../src/app.tsx";
import {
	json,
	problem,
	renderApp,
	session,
	signedIn,
	stubApi,
} from "./support.tsx";

// TEST DOUBLES ONLY. A stub API stands in for the server; the identity provider is never contacted.

const PROVIDERS = "GET /api/v1/auth/providers";
const GOOGLE = "POST /api/v1/auth/google";
const ME = "GET /api/v1/auth/me";
const LIST = "GET /api/v1/repositories";
const AUTHORIZE =
	"https://project.example.test/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2F127.0.0.1%3A5173%2Fauth%2Fcallback";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.canary-payload.canary-signature";
const home = () => json({ items: [], next_cursor: null });

/** Puts the browser where the provider sends it back to. */
const arriveAt = (suffix: string) =>
	window.history.replaceState(null, "", `/auth/callback${suffix}`);
const fragment = (answer: Record<string, string>) =>
	`#${new URLSearchParams(answer)}`;

afterEach(() => window.history.replaceState(null, "", "/"));

/** Gives a stub reply time to be used, for the cases where nothing is expected to change. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("Continue with Google on the sign-in page", () => {
	it("links to the address the server gives, beside the password form", async () => {
		stubApi({
			[PROVIDERS]: json({
				google: { enabled: true, authorize_url: AUTHORIZE },
			}),
		});
		renderApp("/sign-in");
		const link = await screen.findByRole("link", {
			name: "Continue with Google",
		});
		expect(link.getAttribute("href")).toBe(AUTHORIZE);
		expect(screen.getByLabelText("Password")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
	});

	const absent: Array<[string, () => Response]> = [
		[
			"the server has it turned off",
			() => json({ google: { enabled: false, authorize_url: null } }),
		],
		[
			"the server reports it on without an address",
			() => json({ google: { enabled: true, authorize_url: null } }),
		],
		["the answer cannot be read", () => json({ unexpected: true })],
		["the lookup fails", () => problem(500, "internal_error")],
		[
			"the server cannot be reached",
			() => {
				throw new TypeError("offline");
			},
		],
	];
	for (const [name, reply] of absent)
		it(`shows no Google button when ${name}, and the password form still works`, async () => {
			const calls = stubApi({
				[PROVIDERS]: reply,
				"POST /api/v1/auth/login": json(signedIn()),
				[ME]: json(session()),
				[LIST]: home(),
			});
			const { router } = renderApp("/sign-in");
			await waitFor(() =>
				expect(calls.some((call) => call.path.endsWith("/providers"))).toBe(
					true,
				),
			);
			await settle();
			expect(screen.queryByRole("link", { name: /google/i })).toBeNull();
			fireEvent.change(screen.getByLabelText("Email"), {
				target: { value: "owner@example.com" },
			});
			fireEvent.change(screen.getByLabelText("Password"), {
				target: { value: "correct horse" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
			await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		});
});

describe("the sign-in callback page", () => {
	it("clears the answer from the address before the sign-in finishes, then sends only the access token", async () => {
		let release: (response: Response) => void = () => undefined;
		const calls = stubApi({
			[GOOGLE]: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
			[ME]: json(session()),
			[LIST]: home(),
		});
		arriveAt(
			fragment({
				access_token: TOKEN,
				refresh_token: "refresh-canary",
				provider_token: "provider-canary",
				expires_in: "3600",
				token_type: "bearer",
			}),
		);
		const { router } = renderApp("/auth/callback");
		await waitFor(() =>
			expect(calls.some((call) => call.method === "POST")).toBe(true),
		);

		// The request is still waiting, and the token is already out of the address and the history.
		expect(window.location.hash).toBe("");
		expect(window.location.href).not.toMatch(/canary|access_token/);
		expect(window.location.pathname).toBe("/auth/callback");
		expect(screen.getByRole("status").textContent).toContain("Signing you in");

		release(json(signedIn()));
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		const post = calls.find((call) => call.method === "POST");
		expect(post?.path).toBe("/api/v1/auth/google");
		expect(post?.body).toEqual({ access_token: TOKEN });
		expect(post?.credentials).toBe("same-origin");
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
		// The session is looked up again, as for the password sign-in.
		await waitFor(() =>
			expect(calls.some((call) => call.path === "/api/v1/auth/me")).toBe(true),
		);
	});

	it("signs in once when React runs the page's effects twice", async () => {
		const calls = stubApi({
			[GOOGLE]: json(signedIn()),
			[ME]: json(session()),
			[LIST]: home(),
		});
		arriveAt(fragment({ access_token: TOKEN }));
		const router = createMemoryRouter(routes, {
			initialEntries: ["/auth/callback"],
		});
		const queryClient = createQueryClient(router);
		render(
			<StrictMode>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</StrictMode>,
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
		expect(window.location.hash).toBe("");
	});

	const refused: Array<[string, Response | (() => never), string]> = [
		[
			"a token the provider turned down",
			problem(401, "invalid_provider_token", "detail with a canary inside"),
			"Google did not accept this sign-in",
		],
		[
			"an email Google has not verified",
			problem(403, "email_not_verified"),
			"is not verified",
		],
		[
			"an account that may not sign in",
			problem(403, "signin_not_allowed"),
			"not allowed to sign in here",
		],
		[
			"a provider that cannot be reached",
			problem(502, "provider_unreachable"),
			"sign-in provider could not be reached",
		],
		[
			"Google sign-in being off",
			problem(404, "google_signin_unavailable"),
			"not turned on for this server",
		],
		[
			"too many failed attempts",
			problem(429, "rate_limited"),
			"Too many failed sign-in attempts",
		],
		[
			"a page address the server does not accept",
			problem(403, "csrf_failed"),
			"only from its configured address",
		],
		[
			"a token the server cannot read",
			problem(400, "validation_failed"),
			"cannot read",
		],
		[
			"an error code it does not know",
			problem(500, "internal_error"),
			"could not be completed",
		],
		[
			"an answer of the wrong shape",
			json({ user: null }),
			"could not be completed",
		],
		[
			"a server that cannot be reached",
			() => {
				throw new TypeError("offline");
			},
			"Tracera API could not be reached",
		],
	];
	for (const [name, reply, message] of refused)
		it(`explains ${name} in plain words and links back to sign-in`, async () => {
			const calls = stubApi({ [GOOGLE]: reply });
			arriveAt(fragment({ access_token: TOKEN }));
			renderApp("/auth/callback");
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain(message);
			// The words come from the code, not from the response or the address.
			expect(document.body.textContent).not.toMatch(/canary|eyJ|offline/);
			expect(window.location.hash).toBe("");
			expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
			expect(
				screen
					.getByRole("link", { name: "Back to sign in" })
					.getAttribute("href"),
			).toBe("/sign-in");
		});

	it("leads back to the sign-in page", async () => {
		stubApi({ [GOOGLE]: problem(401, "invalid_provider_token") });
		arriveAt(fragment({ access_token: TOKEN }));
		const { router } = renderApp("/auth/callback");
		fireEvent.click(
			await screen.findByRole("link", { name: "Back to sign in" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/sign-in"),
		);
	});

	const cancelled: Array<[string, string]> = [
		[
			"an error in the fragment",
			fragment({
				error: "access_denied",
				error_description: "User said no <b>evil</b> https://evil.example/x",
			}),
		],
		[
			"only an error description in the fragment",
			fragment({ error_description: "evil text" }),
		],
		[
			"an error in the query",
			"?error=access_denied&error_description=evil+text",
		],
		[
			"an error beside a token",
			fragment({ error: "server_error", access_token: TOKEN }),
		],
	];
	for (const [name, suffix] of cancelled)
		it(`says the sign-in did not complete for ${name}, without repeating it or contacting the server`, async () => {
			const calls = stubApi({ [GOOGLE]: json(signedIn()) });
			arriveAt(suffix);
			renderApp("/auth/callback");
			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain("cancelled or did not complete");
			expect(document.body.textContent).not.toMatch(
				/evil|access_denied|server_error|eyJ/,
			);
			expect(window.location.hash).toBe("");
			expect(window.location.search).toBe("");
			expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
		});

	it("has nothing to complete when the address carries no answer", async () => {
		const calls = stubApi({ [GOOGLE]: json(signedIn()) });
		arriveAt("");
		renderApp("/auth/callback");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("no Google sign-in to complete");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
	});
});
