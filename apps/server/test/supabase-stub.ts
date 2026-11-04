import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// TEST DOUBLE ONLY. A local HTTP server standing in for a Supabase Auth project, so the sign-in code
// is exercised over a real connection: headers, redirects, timeouts, and refused connections included.

export const PUBLISHABLE_KEY = "sb_publishable_stub_0123456789abcdef";

/** What the stub answers for one access token. */
export type StubAnswer = {
	status: number;
	body?: unknown;
	/** Never answer: the caller has to give up by itself. */
	hang?: boolean;
	/** Answer with a redirect to this path. */
	redirectTo?: string;
};

export type StubCall = {
	method: string;
	path: string;
	apikey: string | undefined;
	authorization: string | undefined;
};

const header = (request: IncomingMessage, name: string) => {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
};

export const googleUser = (
	email = "ada@example.com",
	patch: Record<string, unknown> = {},
) => ({
	id: "5d1f6a7e-0000-4000-8000-000000000001",
	aud: "authenticated",
	role: "authenticated",
	email,
	email_confirmed_at: new Date(0).toISOString(),
	app_metadata: { provider: "google", providers: ["google"] },
	user_metadata: { email, full_name: "Ada Lovelace" },
	identities: [
		{
			provider: "google",
			identity_data: {
				email,
				email_verified: true,
				full_name: "Ada Lovelace",
				name: "Ada Lovelace",
				iss: "https://accounts.google.com",
			},
		},
	],
	...patch,
});

/** Answers by access token; any other token is refused the way the provider refuses a bad one. */
export async function startSupabaseStub() {
	const answers = new Map<string, StubAnswer>();
	const calls: StubCall[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://stub");
		const authorization = header(request, "authorization");
		const apikey = header(request, "apikey");
		calls.push({
			method: request.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			apikey,
			authorization,
		});
		const send = (status: number, body?: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(body === undefined ? undefined : JSON.stringify(body));
		};
		if (url.pathname === "/elsewhere") return send(200, {});
		if (apikey !== PUBLISHABLE_KEY)
			return send(401, { message: "Invalid API key" });
		const answer = answers.get(authorization?.replace(/^Bearer /, "") ?? "");
		if (url.pathname === "/auth/v1/logout")
			return answer ? send(204) : send(401, { error_code: "bad_jwt" });
		if (url.pathname !== "/auth/v1/user") return send(404, {});
		if (!answer)
			return send(401, {
				code: 401,
				error_code: "bad_jwt",
				msg: "invalid JWT",
			});
		if (answer.hang) return;
		if (answer.redirectTo) {
			response.writeHead(302, { location: answer.redirectTo });
			return response.end();
		}
		return send(answer.status, answer.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		calls,
		/** Makes `token` belong to `user`. */
		accept(token: string, user: object) {
			answers.set(token, { status: 200, body: user });
		},
		/** Makes the provider answer `token` in some other way: an error status, a redirect, silence. */
		answer(token: string, answer: StubAnswer) {
			answers.set(token, answer);
		},
		forget(token: string) {
			answers.delete(token);
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** An address on which nothing listens: the connection is refused at once. */
export async function closedPortUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
}

/** A token-shaped value for tests; the stub knows it only when `accept` was called for it. */
export const fakeToken = (label: string) =>
	`stub.${Buffer.from(label).toString("base64url")}.${"s".repeat(24)}`;
