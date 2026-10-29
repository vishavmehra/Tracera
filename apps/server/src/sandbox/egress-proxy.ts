import { lookup } from "node:dns/promises";
import {
	createServer,
	request as forward,
	type IncomingHttpHeaders,
	type Server,
} from "node:http";
import { connect, isIPv4, isIPv6, type Socket } from "node:net";

// Egress proxy for dependency preparation. It runs alone in its own
// container, the only one attached both to the preparation network (Docker `--internal`: no route, no
// DNS) and to an outbound network, so it is the preparation's only way out. It forwards only to the
// configured registry origins: HTTPS through CONNECT, plain HTTP (private registries) through
// absolute-form GET or HEAD. Everything else is refused, and every decision is logged as a JSON line.
// It imports only node: modules because the worker strips its types and runs it with `node -e`.

export type ProxyPolicy = {
	/** Allowed origins such as https://registry.npmjs.org; scheme, host, and port must all match. */
	origins: readonly string[];
	/** Private, loopback, and link-local targets are refused unless allowed (private registries, tests). */
	allowPrivate: boolean;
};

export type ProxyEvent = {
	event: "ready" | "allowed" | "denied" | "closed" | "error";
	method?: string;
	target?: string;
	reason?: string;
	bytes_in?: number;
	bytes_out?: number;
};

type Origin = { protocol: "http:" | "https:"; host: string; port: number };
type Decision =
	| { host: string; port: number; path: string }
	| { denied: string };

const MAX_CONNECTIONS = 64;
const IDLE_MS = 120_000;
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export function parseOrigins(origins: readonly string[]): Origin[] {
	return origins.map((value) => {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error(`Unsupported origin ${value}`);
		return {
			protocol: url.protocol,
			host: url.hostname.toLowerCase(),
			port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
		};
	});
}

/** Where a request may go, or why it may not. HTTPS only through CONNECT; plain HTTP only as GET or HEAD. */
export function decide(
	origins: readonly Origin[],
	method: string,
	target: string,
): Decision {
	if (method === "CONNECT") {
		const match = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(target);
		if (!match?.[1] || !match[2]) return { denied: "malformed_target" };
		const host = match[1].toLowerCase();
		const port = Number(match[2]);
		return origins.some(
			(origin) =>
				origin.protocol === "https:" &&
				origin.host === host &&
				origin.port === port,
		)
			? { host, port, path: "" }
			: { denied: "origin_not_allowed" };
	}
	if (method !== "GET" && method !== "HEAD")
		return { denied: "method_not_allowed" };
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return { denied: "not_absolute_form" };
	}
	if (url.protocol !== "http:") return { denied: "scheme_not_allowed" };
	if (url.username || url.password) return { denied: "credentials_in_url" };
	const host = url.hostname.toLowerCase();
	const port = Number(url.port) || 80;
	return origins.some(
		(origin) =>
			origin.protocol === "http:" &&
			origin.host === host &&
			origin.port === port,
	)
		? { host, port, path: `${url.pathname}${url.search}` }
		: { denied: "origin_not_allowed" };
}

/** Private, loopback, link-local, carrier-grade NAT, multicast, reserved, and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
	if (isIPv4(address)) {
		const [a = 0, b = 0] = address.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		);
	}
	if (isIPv6(address)) {
		const lower = address.toLowerCase();
		if (lower === "::" || lower === "::1") return true;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
		if (mapped?.[1]) return isPrivateAddress(mapped[1]);
		return /^(fc|fd|fe[89ab]|ff)/.test(lower);
	}
	return true;
}

const forwardHeaders = (headers: IncomingHttpHeaders, host: string) => {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(headers))
		if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value;
	out.host = host;
	return out;
};

/** Starts the proxy. The address is resolved once and connected to directly, so DNS cannot change it later. */
export function startProxy(
	policy: ProxyPolicy,
	port: number,
	log: (event: ProxyEvent) => void,
	host = "0.0.0.0",
): Promise<Server> {
	const origins = parseOrigins(policy.origins);
	const resolve = async (name: string): Promise<string | null> => {
		const { address } = await lookup(name);
		return !policy.allowPrivate && isPrivateAddress(address) ? null : address;
	};
	const server = createServer((request, response) => {
		const method = request.method ?? "";
		const target = (request.url ?? "").slice(0, 300);
		const decision = decide(origins, method, request.url ?? "");
		const refuse = (reason: string, status = 403) => {
			log({ event: "denied", method, target, reason });
			if (!response.headersSent) response.writeHead(status);
			response.end();
		};
		if ("denied" in decision) return refuse(decision.denied);
		resolve(decision.host)
			.then((address) => {
				if (!address) return refuse("private_address");
				log({ event: "allowed", method, target });
				const upstream = forward(
					{
						host: address,
						port: decision.port,
						method,
						path: decision.path,
						headers: forwardHeaders(
							request.headers,
							`${decision.host}:${decision.port}`,
						),
						timeout: IDLE_MS,
					},
					(reply) => {
						response.writeHead(reply.statusCode ?? 502, reply.headers);
						reply.pipe(response);
					},
				);
				upstream.on("timeout", () => upstream.destroy());
				upstream.on("error", () => refuse("upstream_error", 502));
				request.pipe(upstream);
			})
			.catch(() => refuse("dns_failed", 502));
	});
	server.on("connect", (request, client: Socket, head: Buffer) => {
		const target = (request.url ?? "").slice(0, 300);
		const decision = decide(origins, "CONNECT", request.url ?? "");
		const refuse = (reason: string, status = "403 Forbidden") => {
			log({ event: "denied", method: "CONNECT", target, reason });
			client.end(`HTTP/1.1 ${status}\r\n\r\n`);
		};
		client.on("error", () => client.destroy());
		if ("denied" in decision) return refuse(decision.denied);
		resolve(decision.host)
			.then((address) => {
				if (!address) return refuse("private_address");
				let bytesIn = 0;
				let bytesOut = 0;
				const upstream = connect(decision.port, address, () => {
					log({ event: "allowed", method: "CONNECT", target });
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					if (head.length > 0) upstream.write(head);
					upstream.pipe(client);
					client.pipe(upstream);
				});
				upstream.on("data", (chunk: Buffer) => {
					bytesIn += chunk.length;
				});
				client.on("data", (chunk: Buffer) => {
					bytesOut += chunk.length;
				});
				for (const socket of [client, upstream])
					socket.setTimeout(IDLE_MS, () => socket.destroy());
				upstream.on("error", () => client.destroy());
				client.on("close", () => upstream.destroy());
				upstream.on("close", () => {
					client.destroy();
					log({
						event: "closed",
						method: "CONNECT",
						target,
						bytes_in: bytesIn,
						bytes_out: bytesOut,
					});
				});
			})
			.catch(() => refuse("dns_failed", "502 Bad Gateway"));
	});
	server.maxConnections = MAX_CONNECTIONS;
	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolveServer(server));
	});
}

if (process.env.TRACERA_ROLE === "egress-proxy") {
	const log = (event: ProxyEvent) =>
		process.stdout.write(`${JSON.stringify(event)}\n`);
	startProxy(
		{
			origins: JSON.parse(process.env.TRACERA_PROXY_ORIGINS ?? "[]"),
			allowPrivate: process.env.TRACERA_PROXY_ALLOW_PRIVATE === "1",
		},
		Number(process.env.TRACERA_PROXY_PORT ?? 3128),
		log,
	)
		.then(() => log({ event: "ready" }))
		.catch((error: Error) => {
			log({ event: "error", reason: error.message.slice(0, 200) });
			process.exit(1);
		});
}
