import http from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for the GitHub API on a loopback port: tests point TRACERA_GITHUB_API_URL at it, so no
// request leaves the machine. It records every request and answers with whatever the test chose.

export type StubCall = {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: unknown;
};

export type StubReply = {
	status: number;
	json?: unknown;
	headers?: Record<string, string>;
	/** Wait this long before answering. */
	delayMs?: number;
	/** Close the connection without answering. */
	drop?: boolean;
};

export type GithubStub = {
	url: string;
	calls: StubCall[];
	/** Replaces how the next requests are answered. */
	respond(handler: (call: StubCall) => StubReply): void;
	close(): Promise<void>;
};

export async function startGithubStub(
	initial: (call: StubCall) => StubReply = () => ({ status: 500 }),
): Promise<GithubStub> {
	const calls: StubCall[] = [];
	let handler = initial;
	const server = http.createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			let body: unknown = null;
			try {
				body = text ? JSON.parse(text) : null;
			} catch {
				body = text;
			}
			const call: StubCall = {
				method: request.method ?? "",
				path: request.url ?? "",
				headers: request.headers,
				body,
			};
			calls.push(call);
			const reply = handler(call);
			if (reply.drop) {
				request.socket.destroy();
				return;
			}
			setTimeout(() => {
				response.writeHead(reply.status, {
					"content-type": "application/json",
					...reply.headers,
				});
				response.end(
					reply.json === undefined ? "" : JSON.stringify(reply.json),
				);
			}, reply.delayMs ?? 0);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		respond(next) {
			handler = next;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
