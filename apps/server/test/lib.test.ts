import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { idSchema, NormalizationOutputSchema } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	generateToken,
	hashPassword,
	sha256Hex,
	verifyPassword,
} from "../src/lib/crypto.ts";
import { isPathInside, putBlob } from "../src/lib/fs.ts";
import { isGitWorkTree, resolveCommit } from "../src/lib/git.ts";
import {
	createRateLimiter,
	parseCookies,
	serializeCookie,
} from "../src/lib/http.ts";
import { newId } from "../src/lib/ids.ts";
import { redactSecrets } from "../src/lib/redact.ts";
import { toStrictJsonSchema } from "../src/lib/strict-json-schema.ts";

describe("newId", () => {
	it("produces valid, unique, time-ordered prefixed ULIDs", () => {
		const ids = Array.from({ length: 500 }, () => newId("inv"));
		for (const id of ids)
			expect(idSchema("inv").safeParse(id).success).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		const later = newId("inv");
		expect(later.slice(4, 14) >= (ids[0] ?? "").slice(4, 14)).toBe(true);
	});
});

describe("password hashing", () => {
	it("verifies the right password and rejects a wrong one", async () => {
		const hash = await hashPassword("correct horse battery", { costLog2: 10 });
		expect(hash).not.toContain("correct horse battery");
		expect(await verifyPassword("correct horse battery", hash)).toBe(true);
		expect(await verifyPassword("wrong password", hash)).toBe(false);
	});

	it("rejects malformed stored hashes instead of throwing", async () => {
		expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
	});
});

describe("tokens", () => {
	it("generates personal access tokens with a fixed prefix and 256 bits of entropy", () => {
		const token = generateToken();
		expect(token).toMatch(/^trc_pat_[0-9a-f]{64}$/);
		expect(generateToken()).not.toBe(token);
		expect(sha256Hex(token)).toHaveLength(64);
	});
});

describe("cookies", () => {
	it("parses a cookie header", () => {
		expect(parseCookies("a=1; tracera_session=abc%3D; empty=")).toEqual({
			a: "1",
			tracera_session: "abc=",
			empty: "",
		});
	});

	it("serializes session cookies with protective flags", () => {
		const cookie = serializeCookie("tracera_session", "v", {
			maxAgeSeconds: 60,
			secure: true,
		});
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=60");
		expect(cookie).toContain("Secure");
	});
});

describe("rate limiter", () => {
	it("allows up to the limit per window and resets afterwards", () => {
		let now = 0;
		const limiter = createRateLimiter({
			limit: 2,
			windowMs: 1000,
			now: () => now,
		});
		expect(limiter.take("k").allowed).toBe(true);
		expect(limiter.take("k").allowed).toBe(true);
		const blocked = limiter.take("k");
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSeconds).toBe(1);
		expect(limiter.take("other").allowed).toBe(true);
		now = 1000;
		expect(limiter.take("k").allowed).toBe(true);
	});
});

describe("redactSecrets", () => {
	const cases: Array<[string, string]> = [
		["meta_key", "key LLM_1234567890123456_FakeTestKey-notreal00 end"],
		["tracera_pat", `token trc_pat_${"a".repeat(64)}`],
		["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
		["openai_style", "sk-abcdefghijklmnopqrstuvwxyz0123"],
		["github", `ghp_${"A".repeat(36)}`],
		["aws_access_key", "AKIAABCDEFGHIJKLMNOP"],
		["google_api_key", `AIza${"B".repeat(35)}`],
		[
			"jwt",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		],
		[
			"private_key",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
		],
		["url_credentials", "postgres://admin:hunter2@db.internal:5432/app"],
		["assignment", 'password = "hunter2hunter2"'],
	];

	for (const [type, input] of cases) {
		it(`redacts ${type}`, () => {
			const result = redactSecrets(input, { redactEmails: false });
			expect(result.count).toBeGreaterThan(0);
			expect(result.text).toContain("[REDACTED:");
			expect(result.text).not.toMatch(
				/hunter2|FakeTestKey|aaaaaaaaaaaaaaaa|AKIAABCDEFGHIJKLMNOP/,
			);
		});
	}

	it("leaves ordinary bug text unchanged", () => {
		const text =
			"Clicking Remove on the second cart item removes the first one. Total: $12.40";
		expect(redactSecrets(text, { redactEmails: true })).toEqual({
			text,
			count: 0,
		});
	});

	it("redacts email addresses only when enabled", () => {
		expect(
			redactSecrets("mail jane@example.com", { redactEmails: false }).count,
		).toBe(0);
		expect(
			redactSecrets("mail jane@example.com", { redactEmails: true }).text,
		).toBe("mail [REDACTED:email]");
	});
});

describe("toStrictJsonSchema", () => {
	const schema = toStrictJsonSchema(NormalizationOutputSchema);

	it("produces an object root without composition keywords", () => {
		expect(schema.type).toBe("object");
		expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|allOf|not|\$schema)"/);
	});

	it("closes every object and requires every property", () => {
		const visit = (node: unknown, depth: number): void => {
			expect(depth).toBeLessThanOrEqual(10);
			if (Array.isArray(node)) {
				for (const child of node) visit(child, depth);
				return;
			}
			if (!node || typeof node !== "object") return;
			const record = node as Record<string, unknown>;
			if (record.type === "object") {
				expect(record.additionalProperties).toBe(false);
				expect(new Set(record.required as string[])).toEqual(
					new Set(Object.keys(record.properties as object)),
				);
			}
			for (const value of Object.values(record)) visit(value, depth + 1);
		};
		visit(schema, 0);
	});

	it("drops length and size keywords that providers may reject", () => {
		expect(JSON.stringify(schema)).not.toMatch(
			/"(maxLength|minLength|maxItems|minItems|pattern|format)"/,
		);
	});
});

describe("paths and blobs", () => {
	it("detects containment, including case-insensitive Windows paths", () => {
		expect(isPathInside("C:/repos", "C:/repos/app")).toBe(true);
		expect(isPathInside("C:/repos", "C:/repos")).toBe(true);
		expect(isPathInside("C:/repos", "C:/repos-evil/app")).toBe(false);
		expect(isPathInside("C:/repos", "C:/repos/../secrets")).toBe(false);
		if (process.platform === "win32")
			expect(isPathInside("C:/Repos", "c:/repos/app")).toBe(true);
	});

	it("stores content-addressed blobs idempotently", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "tracera-blob-"));
		const first = await putBlob(dir, Buffer.from("stack trace"));
		const second = await putBlob(dir, Buffer.from("stack trace"));
		expect(first.sha256).toBe(sha256Hex("stack trace"));
		expect(second.path).toBe(first.path);
		expect(readFileSync(first.path, "utf8")).toBe("stack trace");
		expect(first.path.replaceAll("\\", "/")).toContain(
			`/sha256/${first.sha256.slice(0, 2)}/`,
		);
	});

	it("replaces an existing blob whose bytes no longer match its name", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "tracera-blob-"));
		const stored = await putBlob(dir, Buffer.from("reviewed diff"));
		writeFileSync(stored.path, "tampered diff");
		await putBlob(dir, Buffer.from("reviewed diff"));
		expect(readFileSync(stored.path, "utf8")).toBe("reviewed diff");
	});
});

describe("hardened git", () => {
	const repo = mkdtempSync(path.join(tmpdir(), "tracera-git-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-b", "main");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"--allow-empty",
		"-m",
		"init",
	);
	writeFileSync(path.join(repo, "a.txt"), "a");

	it("recognizes a work tree", async () => {
		expect(await isGitWorkTree(repo)).toBe(true);
		expect(await isGitWorkTree(tmpdir())).toBe(false);
	});

	it("resolves branches to full SHAs and returns null for unknown refs", async () => {
		expect(await resolveCommit(repo, "main")).toMatch(/^[0-9a-f]{40}$/);
		expect(await resolveCommit(repo, "does-not-exist")).toBeNull();
	});
});
