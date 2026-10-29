import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// A local npm registry for the Docker suites: real tarballs served over plain HTTP from a container on
// a test network, so dependency preparation runs exactly as in production without the internet.

// stderr is piped so expected failures (polling for a container that does not exist yet) stay quiet;
// it is still attached to the thrown error.
export const docker = (...args: string[]) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
export const quiet = (...args: string[]) => {
	try {
		return docker(...args);
	} catch {
		return "";
	}
};

/** A minimal npm tarball: gzip(ustar) with package/ entries and fixed metadata (deterministic bytes). */
export function tarball(files: Record<string, string>): Buffer {
	const blocks: Buffer[] = [];
	const octal = (value: number, length: number) =>
		`${value.toString(8).padStart(length - 1, "0")}\0`;
	for (const [name, content] of Object.entries(files)) {
		const body = Buffer.from(content, "utf8");
		const header = Buffer.alloc(512, 0);
		header.write(name, 0, 100, "utf8");
		header.write(octal(0o644, 8), 100, 8, "ascii");
		header.write(octal(0, 8), 108, 8, "ascii");
		header.write(octal(0, 8), 116, 8, "ascii");
		header.write(octal(body.length, 12), 124, 12, "ascii");
		header.write(octal(0, 12), 136, 12, "ascii");
		header.write("        ", 148, 8, "ascii");
		header.write("0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** A CommonJS package whose index.js is `source`. */
export const pkg = (name: string, version: string, source: string) =>
	tarball({
		"package/package.json": JSON.stringify({ name, version, main: "index.js" }),
		"package/index.js": source,
	});

export const sri = (bytes: Buffer) =>
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** Serves fixed files; `/slow/` never answers, so a test can hold an install open. */
const SERVER = `const http = require("node:http");
const files = JSON.parse(Buffer.from(process.env.FILES, "base64").toString("utf8"));
http.createServer((req, res) => {
  if (req.url.startsWith("/slow/")) return;
  const body = files[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(Buffer.from(body, "base64"));
}).listen(4873, () => console.log("ready"));`;

/** Starts a registry container named `name` (port 4873) on `network` and waits until it listens. */
export async function serveRegistry(options: {
	name: string;
	network: string;
	label: string;
	image: string;
	files: Record<string, Buffer>;
}) {
	const encoded = Buffer.from(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(options.files).map(([url, body]) => [
					url,
					body.toString("base64"),
				]),
			),
		),
	).toString("base64");
	docker(
		"run",
		"--detach",
		"--rm",
		"--name",
		options.name,
		"--network",
		options.network,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--user",
		"1000:1000",
		"--label",
		options.label,
		"--env",
		`FILES=${encoded}`,
		options.image,
		"node",
		"-e",
		SERVER,
	);
	for (let i = 0; i < 40 && !quiet("logs", options.name).includes("ready"); i++)
		await new Promise((resolve) => setTimeout(resolve, 250));
}
