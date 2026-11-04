import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
	createPullRequest,
	GITHUB_API_VERSION,
	GithubError,
	type GithubErrorCode,
	parseGithubRemote,
} from "../src/modules/github-client.ts";
import { pushAuth } from "../src/modules/publication.ts";
import { type GithubStub, startGithubStub } from "./github-stub.ts";

// Credential-shaped test values are assembled at run time, so the source holds no secret-like literal.
const TOKEN = ["github_pat_", "T".repeat(24), "_", "x".repeat(40)].join("");
const REPO = { owner: "acme", repo: "widgets" };
const PR = {
	head: "fix/total",
	base: "main",
	title: "Multiply price by quantity",
	body: "The description",
	draft: false,
};
const CREATED = {
	number: 7,
	html_url: "https://github.com/acme/widgets/pull/7",
};

describe("reading a remote URL", () => {
	it.each([
		["https://github.com/acme/widgets.git", REPO],
		["https://github.com/acme/widgets", REPO],
		["git@github.com:acme/widgets.git", REPO],
		["git@github.com:acme/widgets", REPO],
		["https://GitHub.com/Acme/Widgets.git", { owner: "Acme", repo: "Widgets" }],
		[
			"https://github.com/acme/my.repo_name-2.git",
			{ owner: "acme", repo: "my.repo_name-2" },
		],
		["https://github.com/acme/.github.git", { owner: "acme", repo: ".github" }],
	])("accepts %s", (url, expected) => {
		expect(parseGithubRemote(url)).toEqual(expected);
	});

	it.each([
		"https://user:secret@github.com/acme/widgets.git",
		"https://x-access-token:abc@github.com/acme/widgets.git",
		"https://github.com:443/acme/widgets.git",
		"http://github.com/acme/widgets.git",
		"https://github.com/acme/widgets/",
		"https://github.com/acme/widgets/extra",
		"https://github.com/acme",
		"https://github.com/acme/widgets.git?x=1",
		"https://github.com/acme/widgets.git#frag",
		"https://github.com.evil.example/acme/widgets.git",
		"https://evil.example/github.com/acme/widgets.git",
		"ssh://git@github.com/acme/widgets.git",
		"git@github.com:acme/widgets.git extra",
		"git@gitlab.com:acme/widgets.git",
		"https://gitlab.com/acme/widgets.git",
		"https://github.com/../widgets.git",
		"https://github.com/-acme/widgets.git",
		"https://github.com/acme/..",
		"https://github.com/acme/.",
		"https://github.com/acme/widgets.git\nhttps://evil.example/x",
		"C:/repos/widgets",
		"/tmp/remote.git",
		"",
	])("refuses %j", (url) => {
		expect(parseGithubRemote(url)).toBeNull();
	});
});

describe("the GitHub settings", () => {
	const base = { DATABASE_URL: "postgres://tracera:pw@127.0.0.1:5432/tracera" };

	it("defaults to api.github.com with no token, and treats empty values as unset", () => {
		for (const env of [
			base,
			{ ...base, TRACERA_GITHUB_TOKEN: "", TRACERA_GITHUB_API_URL: "" },
		])
			expect(loadConfig(env).githubPat).toEqual({
				token: null,
				apiUrl: "https://api.github.com",
			});
	});

	it("keeps the token as given", () => {
		expect(
			loadConfig({ ...base, TRACERA_GITHUB_TOKEN: TOKEN }).githubPat.token,
		).toBe(TOKEN);
	});

	it.each([
		["http://127.0.0.1:4010", "http://127.0.0.1:4010"],
		["http://localhost:4010/", "http://localhost:4010"],
		["http://[::1]:4010", "http://[::1]:4010"],
	])("accepts the loopback override %s", (value, origin) => {
		expect(
			loadConfig({ ...base, TRACERA_GITHUB_API_URL: value }).githubPat.apiUrl,
		).toBe(origin);
	});

	it.each([
		"https://api.github.com",
		"https://127.0.0.1:4010",
		"http://example.com",
		"http://127.0.0.1.evil.example",
		"http://user:pw@127.0.0.1:4010",
		"http://127.0.0.1:4010/api",
		"http://127.0.0.1:4010/?x=1",
		"ftp://127.0.0.1",
		"not a url",
	])(
		"refuses the override %j, which is not a loopback http address",
		(value) => {
			const attempt = () =>
				loadConfig({ ...base, TRACERA_GITHUB_API_URL: value });
			expect(attempt).toThrow(ConfigError);
			expect(attempt).toThrow(/TRACERA_GITHUB_API_URL/);
		},
	);

	it("names a malformed token's variable without echoing the value", () => {
		const bad = `${TOKEN} with spaces`;
		const attempt = () => loadConfig({ ...base, TRACERA_GITHUB_TOKEN: bad });
		expect(attempt).toThrow(/TRACERA_GITHUB_TOKEN/);
		try {
			attempt();
		} catch (error) {
			expect(String((error as Error).message)).not.toContain(TOKEN);
		}
	});
});

describe("opening a pull request on GitHub", () => {
	let stub: GithubStub;
	beforeAll(async () => {
		stub = await startGithubStub();
	});
	afterAll(async () => stub.close());
	afterEach(() => {
		stub.calls.length = 0;
	});
	const api = (timeoutMs?: number) => ({
		apiUrl: stub.url,
		token: TOKEN,
		...(timeoutMs ? { timeoutMs } : {}),
	});
	const attempt = async (call = () => createPullRequest(api(), REPO, PR)) => {
		try {
			await call();
		} catch (error) {
			expect(error).toBeInstanceOf(GithubError);
			return error as GithubError;
		}
		throw new Error("the call did not fail");
	};

	it("sends one authenticated request and returns the link and number from GitHub's answer", async () => {
		stub.respond(() => ({ status: 201, json: CREATED }));
		const created = await createPullRequest(api(), REPO, {
			...PR,
			draft: true,
		});
		expect(created).toEqual({
			url: "https://github.com/acme/widgets/pull/7",
			number: 7,
		});
		expect(stub.calls).toHaveLength(1);
		const [call] = stub.calls;
		expect(call?.method).toBe("POST");
		expect(call?.path).toBe("/repos/acme/widgets/pulls");
		expect(call?.headers).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": GITHUB_API_VERSION,
			"content-type": "application/json",
			"user-agent": "tracera",
		});
		expect(call?.body).toEqual({
			title: PR.title,
			body: PR.body,
			head: "fix/total",
			base: "main",
			draft: true,
		});
	});

	it.each<[string, number, Record<string, string>, unknown, GithubErrorCode]>([
		[
			"a refused token",
			401,
			{},
			{ message: "Bad credentials" },
			"github_auth_failed",
		],
		[
			"a token without the permission",
			403,
			{},
			{ message: "Resource not accessible" },
			"github_permission_denied",
		],
		[
			"an unknown or hidden repository",
			404,
			{},
			{ message: "Not Found" },
			"github_repository_not_found",
		],
		[
			"an exhausted rate limit (403)",
			403,
			{ "x-ratelimit-remaining": "0" },
			{ message: "API rate limit exceeded" },
			"github_rejected",
		],
		[
			"a rate limit (429)",
			429,
			{},
			{ message: "slow down" },
			"github_rejected",
		],
		[
			"a validation failure",
			422,
			{},
			{
				message: "Validation Failed",
				errors: [
					{
						resource: "PullRequest",
						code: "custom",
						message: "No commits between main and fix/total",
					},
				],
			},
			"github_rejected",
		],
		[
			"a server error",
			502,
			{},
			{ message: "Bad gateway" },
			"github_unreachable",
		],
		[
			"an unexpected refusal",
			409,
			{},
			{ message: "Conflict" },
			"github_rejected",
		],
		["an answer that is not JSON", 400, {}, undefined, "github_rejected"],
	])("maps %s to a stable code", async (_name, status, headers, json, code) => {
		stub.respond(() => ({ status, headers, json }));
		const error = await attempt();
		expect(error.code).toBe(code);
		expect(`${error.message}\n${error.stack}`).not.toContain(TOKEN);
		expect(stub.calls).toHaveLength(1);
	});

	it("quotes GitHub's own words for a validation failure", async () => {
		stub.respond(() => ({
			status: 422,
			json: {
				message: "Validation Failed",
				errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
			},
		}));
		const error = await attempt();
		expect(error.code).toBe("github_rejected");
		expect(error.message).toContain("Validation Failed: base invalid");
	});

	it("tells an existing pull request apart, and names it when GitHub lists one", async () => {
		stub.respond((call) =>
			call.method === "POST"
				? {
						status: 422,
						json: {
							message: "Validation Failed",
							errors: [
								{
									resource: "PullRequest",
									code: "custom",
									message: "A pull request already exists for acme:fix/total.",
								},
							],
						},
					}
				: {
						status: 200,
						json: [{ html_url: "https://github.com/acme/widgets/pull/3" }],
					},
		);
		const error = await attempt();
		expect(error.code).toBe("pull_request_exists");
		expect(error.message).toBe(
			"A pull request already exists for this branch: https://github.com/acme/widgets/pull/3",
		);
		const lookup = stub.calls[1];
		expect(lookup?.method).toBe("GET");
		expect(lookup?.path).toBe(
			"/repos/acme/widgets/pulls?state=open&per_page=1&head=acme%3Afix%2Ftotal",
		);
	});

	it.each([
		["finds none", { status: 200, json: [] }],
		["fails", { status: 500 }],
		[
			"names another repository",
			{
				status: 200,
				json: [{ html_url: "https://github.com/evil/other/pull/3" }],
			},
		],
		[
			"names a link that is not a pull request",
			{ status: 200, json: [{ html_url: "javascript:alert(1)" }] },
		],
	])(
		"gives no link for an existing pull request when the lookup %s",
		async (_name, lookup) => {
			stub.respond((call) =>
				call.method === "POST"
					? {
							status: 422,
							json: {
								errors: [
									{
										message:
											"A pull request already exists for acme:fix/total.",
									},
								],
							},
						}
					: lookup,
			);
			const error = await attempt();
			expect(error.code).toBe("pull_request_exists");
			expect(error.message).toBe(
				"A pull request already exists for this branch",
			);
		},
	);

	it("never follows a redirect, so the token goes nowhere else", async () => {
		const elsewhere = await startGithubStub(() => ({
			status: 201,
			json: CREATED,
		}));
		try {
			stub.respond(() => ({
				status: 307,
				headers: { location: `${elsewhere.url}/repos/acme/widgets/pulls` },
			}));
			const error = await attempt();
			expect(error.code).toBe("github_rejected");
			expect(error.message).toContain("does not follow redirects");
			expect(elsewhere.calls).toEqual([]);
		} finally {
			await elsewhere.close();
		}
	});

	it.each([
		["no link", { number: 7 }],
		[
			"a link that is not a pull request",
			{ number: 7, html_url: "https://github.com/acme/widgets/issues/7" },
		],
		[
			"a link on another host",
			{ number: 7, html_url: "https://evil.example/acme/widgets/pull/7" },
		],
		[
			"a link to another repository",
			{ number: 7, html_url: "https://github.com/acme/other/pull/7" },
		],
		[
			"a number that disagrees with the link",
			{ number: 8, html_url: CREATED.html_url },
		],
		["no number", { html_url: CREATED.html_url }],
		["a script link", { number: 7, html_url: "javascript:alert(1)" }],
	])(
		"does not call it a success when GitHub's 201 has %s",
		async (_name, json) => {
			stub.respond(() => ({ status: 201, json }));
			const error = await attempt();
			expect(error.code).toBe("github_unreachable");
			expect(error.message).toContain("may exist");
		},
	);

	it("says a pull request may or may not exist when GitHub does not answer in time", async () => {
		stub.respond(() => ({ status: 201, json: CREATED, delayMs: 800 }));
		const error = await attempt(() => createPullRequest(api(150), REPO, PR));
		expect(error.code).toBe("github_unreachable");
		expect(error.message).toContain("may or may not exist");
	});

	it("reports a dropped connection and a closed port the same way", async () => {
		stub.respond(() => ({ status: 201, drop: true }));
		expect((await attempt()).code).toBe("github_unreachable");
		const closed = await startGithubStub();
		const url = closed.url;
		await closed.close();
		const error = await attempt(() =>
			createPullRequest({ apiUrl: url, token: TOKEN }, REPO, PR),
		);
		expect(error.code).toBe("github_unreachable");
		expect(`${error.message}\n${error.stack}`).not.toContain(TOKEN);
	});

	it("redacts credentials GitHub's own message happens to echo", async () => {
		stub.respond(() => ({
			status: 422,
			json: {
				message: "Validation Failed",
				errors: [{ message: `see ${TOKEN}` }],
			},
		}));
		const error = await attempt();
		expect(error.message).toContain("[REDACTED:github]");
		expect(error.message).not.toContain(TOKEN);
	});

	it("keeps unusual repository names out of the request path", async () => {
		stub.respond(() => ({ status: 404 }));
		await attempt(() =>
			createPullRequest(api(), { owner: "acme", repo: "a b%2F..c" }, PR),
		);
		expect(stub.calls[0]?.path).toBe("/repos/acme/a%20b%252F..c/pulls");
	});
});

describe("authenticating a push", () => {
	const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

	it.each([
		"https://github.com/acme/widgets.git",
		"https://github.com/acme/widgets",
		"  https://github.com/acme/widgets.git\n",
	])("uses the token alone for %j, through git's environment only", (url) => {
		const auth = pushAuth(url, TOKEN);
		expect(auth?.env).toMatchObject({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
		});
		// The machine's credential helpers and askpass programs are switched off, and redirects are not followed.
		expect(auth?.args).toEqual(
			expect.arrayContaining([
				"credential.helper=",
				"core.askPass=",
				"http.followRedirects=false",
			]),
		);
		const argv = JSON.stringify(auth?.args);
		expect(argv).not.toContain(TOKEN);
		expect(argv).not.toContain(basic);
	});

	it.each([
		["no token is set", "https://github.com/acme/widgets.git", null],
		[
			"the address is ssh, which uses the user's key",
			"git@github.com:acme/widgets.git",
			TOKEN,
		],
		[
			"the address is another host",
			"https://gitlab.com/acme/widgets.git",
			TOKEN,
		],
		["the address is plain http", "http://github.com/acme/widgets.git", TOKEN],
		[
			"the address carries credentials",
			"https://dev:pw@github.com/acme/widgets.git",
			TOKEN,
		],
		["the address is a path", "C:/remotes/widgets.git", TOKEN],
		["the address is empty", "", TOKEN],
	])(
		"leaves git to the user's own credentials when %s",
		(_name, url, token) => {
			expect(pushAuth(url, token)).toBeNull();
		},
	);
});
