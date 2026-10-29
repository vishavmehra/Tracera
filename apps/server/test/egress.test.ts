import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {
	createServer as createHttpServer,
	request as httpRequest,
	type Server,
} from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dependencyMountArgs,
	installEnv,
	summarizeEgress,
} from "../src/sandbox/docker.ts";
import {
	decide,
	isPrivateAddress,
	type ProxyEvent,
	type ProxyPolicy,
	parseOrigins,
	startProxy,
} from "../src/sandbox/egress-proxy.ts";
import { findMounts, sealTree } from "../src/sandbox/seal-tree.ts";

// Dependency preparation building blocks [unit, real sockets on localhost only]: the egress
// proxy's decisions and forwarding, the install environment, the read-only mounts, and the seal. The
// same code runs inside containers in dependencies.docker.test.ts.

describe("egress proxy decisions", () => {
	const origins = parseOrigins([
		"https://registry.npmjs.org",
		"http://registry.internal:4873",
	]);

	it.each([
		[
			"CONNECT",
			"registry.npmjs.org:443",
			{ host: "registry.npmjs.org", port: 443 },
		],
		[
			"CONNECT",
			"REGISTRY.NPMJS.ORG:443",
			{ host: "registry.npmjs.org", port: 443 },
		],
		[
			"GET",
			"http://registry.internal:4873/left-pad/-/left-pad-1.3.0.tgz",
			{
				host: "registry.internal",
				port: 4873,
				path: "/left-pad/-/left-pad-1.3.0.tgz",
			},
		],
		["HEAD", "http://registry.internal:4873/x", { host: "registry.internal" }],
	])("allows %s %s", (method, target, expected) => {
		expect(decide(origins, method, target)).toMatchObject(expected);
	});

	it.each([
		["CONNECT", "evil.example.com:443", "origin_not_allowed"],
		["CONNECT", "registry.npmjs.org:22", "origin_not_allowed"],
		["CONNECT", "registry.internal:4873", "origin_not_allowed"],
		["CONNECT", "not a target", "malformed_target"],
		["GET", "https://registry.npmjs.org/x", "scheme_not_allowed"],
		["GET", "http://registry.npmjs.org/x", "origin_not_allowed"],
		["GET", "http://user:pass@registry.internal:4873/x", "credentials_in_url"],
		["GET", "/relative", "not_absolute_form"],
		["POST", "http://registry.internal:4873/x", "method_not_allowed"],
		["PUT", "http://registry.internal:4873/x", "method_not_allowed"],
	])("refuses %s %s", (method, target, reason) => {
		expect(decide(origins, method, target)).toEqual({ denied: reason });
	});

	it.each([
		["10.1.2.3", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["172.32.0.1", false],
		["192.168.1.1", true],
		["127.0.0.1", true],
		["169.254.169.254", true],
		["100.64.0.1", true],
		["0.0.0.0", true],
		["224.0.0.1", true],
		["8.8.8.8", false],
		["104.16.0.35", false],
		["::1", true],
		["::", true],
		["fd00::1", true],
		["fe80::1", true],
		["::ffff:10.0.0.1", true],
		["::ffff:8.8.8.8", false],
		["2606:4700::1111", false],
		["not-an-ip", true],
	])("treats %s as private: %s", (address, expected) => {
		expect(isPrivateAddress(address)).toBe(expected);
	});
});

describe("egress proxy forwarding [real sockets on localhost]", () => {
	let upstream: Server;
	let upstreamPort = 0;
	let echo: ReturnType<typeof createServer>;
	let echoPort = 0;

	beforeAll(async () => {
		upstream = createHttpServer((request, response) =>
			response.end(`ok ${request.url}`),
		);
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		upstreamPort = (upstream.address() as AddressInfo).port;
		echo = createServer((socket) => socket.pipe(socket));
		await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
		echoPort = (echo.address() as AddressInfo).port;
	});
	afterAll(() => {
		upstream.close();
		echo.close();
	});

	async function withProxy(
		policy: ProxyPolicy,
		use: (port: number, events: ProxyEvent[]) => Promise<void>,
	) {
		const events: ProxyEvent[] = [];
		const server = await startProxy(
			policy,
			0,
			(event) => events.push(event),
			"127.0.0.1",
		);
		try {
			await use((server.address() as AddressInfo).port, events);
		} finally {
			server.close();
		}
	}
	const get = (port: number, url: string) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const request = httpRequest(
				{ host: "127.0.0.1", port, method: "GET", path: url },
				(response) => {
					let body = "";
					response.on("data", (chunk) => {
						body += chunk;
					});
					response.on("end", () =>
						resolve({ status: response.statusCode ?? 0, body }),
					);
				},
			);
			request.on("error", reject);
			request.end();
		});
	/** Opens a CONNECT tunnel; when it is established, sends "ping" and reads what comes back. */
	const tunnel = (port: number, target: string) =>
		new Promise<{ head: string; echoed: string }>((resolve, reject) => {
			let received = "";
			let head = "";
			const socket = connect(port, "127.0.0.1", () =>
				socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
			);
			socket.on("data", (chunk) => {
				received += chunk.toString();
				if (!head && received.includes("\r\n\r\n")) {
					head = received.slice(0, received.indexOf("\r\n\r\n"));
					received = received.slice(received.indexOf("\r\n\r\n") + 4);
					if (head.startsWith("HTTP/1.1 200")) socket.write("ping");
					else socket.end();
				}
				if (received.includes("ping")) socket.end();
			});
			socket.on("close", () => resolve({ head, echoed: received }));
			socket.on("error", reject);
		});

	it("forwards plain-HTTP requests to an allowed private registry and logs them", async () => {
		await withProxy(
			{ origins: [`http://127.0.0.1:${upstreamPort}`], allowPrivate: true },
			async (port, events) => {
				expect(
					await get(
						port,
						`http://127.0.0.1:${upstreamPort}/pkg/-/pkg-1.0.0.tgz`,
					),
				).toEqual({ status: 200, body: "ok /pkg/-/pkg-1.0.0.tgz" });
				expect(events).toContainEqual(
					expect.objectContaining({ event: "allowed", method: "GET" }),
				);
			},
		);
	});

	it("refuses private addresses unless allowed, and origins that are not listed", async () => {
		await withProxy(
			{ origins: [`http://127.0.0.1:${upstreamPort}`], allowPrivate: false },
			async (port, events) => {
				expect(
					(await get(port, `http://127.0.0.1:${upstreamPort}/x`)).status,
				).toBe(403);
				expect(events).toContainEqual(
					expect.objectContaining({
						event: "denied",
						reason: "private_address",
					}),
				);
			},
		);
		await withProxy(
			{ origins: [`http://127.0.0.1:${upstreamPort}`], allowPrivate: true },
			async (port, events) => {
				expect((await get(port, "http://127.0.0.1:1/steal")).status).toBe(403);
				expect(events).toContainEqual(
					expect.objectContaining({
						event: "denied",
						reason: "origin_not_allowed",
					}),
				);
			},
		);
	});

	it("tunnels CONNECT only to an allowed HTTPS origin", async () => {
		await withProxy(
			{ origins: [`https://127.0.0.1:${echoPort}`], allowPrivate: true },
			async (port) => {
				const allowed = await tunnel(port, `127.0.0.1:${echoPort}`);
				expect(allowed.head).toMatch(/^HTTP\/1\.1 200/);
				expect(allowed.echoed).toBe("ping");
				const refused = await tunnel(port, `127.0.0.1:${upstreamPort}`);
				expect(refused.head).toMatch(/^HTTP\/1\.1 403/);
				expect(refused.echoed).toBe("");
			},
		);
	});
});

describe("preparation container inputs", () => {
	it("summarizes the proxy log as hosts, never paths", () => {
		const log = [
			{ event: "ready" },
			{ event: "allowed", method: "CONNECT", target: "registry.npmjs.org:443" },
			{ event: "closed", method: "CONNECT", target: "registry.npmjs.org:443" },
			{
				event: "denied",
				method: "GET",
				target: "http://evil.example.com/steal?token=x",
				reason: "origin_not_allowed",
			},
			{ event: "allowed", method: "CONNECT", target: "registry.npmjs.org:443" },
		]
			.map((event) => JSON.stringify(event))
			.concat("not json")
			.join("\n");
		expect(summarizeEgress(log)).toEqual({
			allowed: 2,
			denied: 1,
			targets: ["registry.npmjs.org:443"],
			denied_targets: ["evil.example.com"],
		});
	});

	it("gives npm only the registry, the proxy, and switched-off scripts and configuration", () => {
		const env = installEnv(
			"https://registry.npmjs.org/",
			"http://tracera-proxy-x:3128",
		);
		expect(env).toEqual(
			expect.arrayContaining([
				"npm_config_ignore_scripts=true",
				"npm_config_registry=https://registry.npmjs.org/",
				"npm_config_https_proxy=http://tracera-proxy-x:3128",
				"npm_config_userconfig=/tmp/.npmrc-none",
				"npm_config_globalconfig=/tmp/.npmrc-global-none",
			]),
		);
		for (const pair of env) {
			expect(pair).toMatch(/^[A-Za-z_]+=/);
			expect(pair.split("=")[0]).not.toMatch(/token|secret|password|auth|key/i);
		}
	});

	it("mounts every node_modules read-only from the artifact, with tmpfs caches", () => {
		expect(
			dependencyMountArgs({
				volume: "tracera-deps-dep_x-1",
				mounts: ["node_modules", "packages/a/node_modules"],
			}),
		).toEqual([
			"--mount",
			"type=volume,source=tracera-deps-dep_x-1,target=/work/node_modules,readonly,volume-subpath=app/node_modules",
			"--tmpfs",
			"/work/node_modules/.cache:rw,noexec,nosuid,nodev,size=32m,mode=1777",
			"--tmpfs",
			"/work/node_modules/.vite:rw,noexec,nosuid,nodev,size=32m,mode=1777",
			"--mount",
			"type=volume,source=tracera-deps-dep_x-1,target=/work/packages/a/node_modules,readonly,volume-subpath=app/packages/a/node_modules",
			"--tmpfs",
			"/work/packages/a/node_modules/.cache:rw,noexec,nosuid,nodev,size=32m,mode=1777",
			"--tmpfs",
			"/work/packages/a/node_modules/.vite:rw,noexec,nosuid,nodev,size=32m,mode=1777",
		]);
	});
});

describe("sealTree", () => {
	const project = () => {
		const root = mkdtempSync(path.join(tmpdir(), "tracera-seal-"));
		const write = (file: string, content: string) => {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), content);
		};
		write("package.json", "{}");
		write("node_modules/a/package.json", '{"name":"a"}');
		write("node_modules/a/index.js", "module.exports = 'a';");
		write("packages/x/package.json", "{}");
		write("packages/x/node_modules/b/index.js", "module.exports = 'b';");
		return { root, write };
	};

	it("finds the outermost node_modules directories as mount points", async () => {
		const { root } = project();
		expect(await findMounts(root)).toEqual([
			"node_modules",
			"packages/x/node_modules",
		]);
	});

	it("is deterministic and changes with any byte or file, but not with files it does not mount", async () => {
		const { root, write } = project();
		const sealed = await sealTree(root);
		expect(sealed).toMatchObject({
			files: 3,
			links: 0,
			mounts: ["node_modules", "packages/x/node_modules"],
		});
		expect((await sealTree(root)).digest).toBe(sealed.digest);
		write("package.json", '{"changed":true}');
		expect((await sealTree(root)).digest).toBe(sealed.digest);
		write("node_modules/a/index.js", "module.exports = 'A';");
		expect((await sealTree(root)).digest).not.toBe(sealed.digest);
		write("node_modules/a/index.js", "module.exports = 'a';");
		expect((await sealTree(root)).digest).toBe(sealed.digest);
		write("node_modules/a/extra.js", "");
		expect((await sealTree(root)).digest).not.toBe(sealed.digest);
	});

	it("records links without following them", async () => {
		const { root } = project();
		const outside = mkdtempSync(path.join(tmpdir(), "tracera-outside-"));
		writeFileSync(path.join(outside, "secret.txt"), "one");
		symlinkSync(outside, path.join(root, "node_modules", "escape"), "junction");
		const first = await sealTree(root);
		expect(first.links).toBe(1);
		expect(first.files).toBe(3);
		writeFileSync(path.join(outside, "secret.txt"), "two");
		expect((await sealTree(root)).digest).toBe(first.digest);
	});

	it("finalizes the cache mount points into the seal", async () => {
		const { root } = project();
		const finalized = await sealTree(root, { finalize: true });
		expect(existsSync(path.join(root, "node_modules", ".vite"))).toBe(true);
		expect(existsSync(path.join(root, "packages/x/node_modules/.cache"))).toBe(
			true,
		);
		expect((await sealTree(root)).digest).toBe(finalized.digest);
	});

	it("refuses more node_modules directories than it mounts", async () => {
		const { root } = project();
		for (let i = 0; i < 32; i++)
			mkdirSync(path.join(root, `extra${i}`, "node_modules"), {
				recursive: true,
			});
		await expect(sealTree(root)).rejects.toThrow("too_many_mounts");
	});
});
