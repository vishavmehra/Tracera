import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, evidenceAssets } from "../src/db/schema.ts";
import { QUEUES } from "../src/queue.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	csrf,
	login,
	makeGitRepo,
	repositoryBody,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// Screenshot evidence uploads (POST /api/v1/bug-reports/{id}/evidence) and the request sequence the Chrome
// extension sends: the same bug-report and investigation API as the web app, with a bearer token.

let ctx: TestContext;
let cookie: string;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	cookie = await login(ctx);
	session = asSession(ctx, cookie);
});

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("png body"),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP = Buffer.concat([
	Buffer.from("RIFF"),
	Buffer.from([0x10, 0, 0, 0]),
	Buffer.from("WEBPVP8 "),
]);
const META = {
	kind: "screenshot",
	captured_at: "2026-10-25T10:00:00.000Z",
	page_url: "https://shop.example/dashboard?session=abc#top",
	page_title: "Dashboard",
	viewport: { width: 1280, height: 720 },
	device_pixel_ratio: 2,
	client_redactions: [{ x: 10, y: 20, width: 100, height: 30 }],
	client_annotations: [{ x: 200, y: 40, width: 50, height: 50 }],
};

async function multipart(parts: {
	meta?: unknown;
	file?: { bytes: Uint8Array; type: string; name?: string };
	extra?: Record<string, string>;
}) {
	const form = new FormData();
	if (parts.meta !== undefined)
		form.set(
			"meta",
			typeof parts.meta === "string" ? parts.meta : JSON.stringify(parts.meta),
		);
	if (parts.file)
		form.set(
			"file",
			new Blob([new Uint8Array(parts.file.bytes)], { type: parts.file.type }),
			parts.file.name ?? "screenshot.png",
		);
	for (const [key, value] of Object.entries(parts.extra ?? {}))
		form.append(key, value);
	const request = new Request("http://localhost/", {
		method: "POST",
		body: form,
	});
	return {
		payload: Buffer.from(await request.arrayBuffer()),
		contentType: request.headers.get("content-type") ?? "",
	};
}

async function upload(
	bugId: string,
	headers: Record<string, string>,
	parts: Parameters<typeof multipart>[0] = {
		meta: META,
		file: { bytes: PNG, type: "image/png" },
	},
) {
	const { payload, contentType } = await multipart(parts);
	return ctx.app.inject({
		method: "POST",
		url: `/api/v1/bug-reports/${bugId}/evidence`,
		headers: { "content-type": contentType, ...headers },
		payload,
	});
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createReport(): Promise<string> {
	const response = await session("POST", "/api/v1/bug-reports", {
		title: "Average order value is wrong",
		description: "Dashboard shows $12.40, expected $24.80.",
		normalize: false,
	});
	return response.json().bug_report.id;
}

describe("screenshot evidence upload", () => {
	it("stores an extension screenshot with client-reported provenance and audits it", async () => {
		const bugId = await createReport();
		const token = await createToken(ctx, cookie, {
			name: "ext",
			client_kind: "extension",
		});
		const response = await upload(bugId, {
			...bearer(token),
			origin: EXTENSION_ORIGIN,
		});
		expect(response.statusCode).toBe(201);
		const evidence = response.json().evidence;
		expect(evidence).toMatchObject({
			kind: "screenshot",
			origin: "captured_by_extension",
			mime_type: "image/png",
			size_bytes: PNG.length,
			captured_at: META.captured_at,
			captured_at_client_reported: true,
			content_url: `/api/v1/evidence/${evidence.id}/content`,
		});
		// The upload schedules the read of the screenshot.
		const queued = await ctx.pool.query(
			"SELECT 1 FROM pgboss.job WHERE name = $1 AND data->>'evidenceId' = $2",
			[QUEUES.observe, evidence.id],
		);
		expect(queued.rowCount).toBe(1);
		// The query string and fragment never reach storage.
		expect(evidence.provenance).toMatchObject({
			channel: "extension",
			page_url: "https://shop.example/dashboard",
			page_title: "Dashboard",
			viewport: META.viewport,
			device_pixel_ratio: 2,
			client_annotations: META.client_annotations,
		});
		const [row] = await ctx.db
			.select()
			.from(evidenceAssets)
			.where(eq(evidenceAssets.id, evidence.id));
		expect(row?.redactions).toEqual({
			applied_by: "client",
			regions: META.client_redactions,
		});
		const sha = row?.blobSha256 ?? "";
		const stored = readFileSync(
			path.join(
				ctx.config.dataDir,
				"blobs",
				"sha256",
				sha.slice(0, 2),
				sha.slice(2, 4),
				sha,
			),
		);
		expect(stored.equals(PNG)).toBe(true);
		const report = (await session("GET", `/api/v1/bug-reports/${bugId}`)).json()
			.bug_report;
		expect(report.evidence.map((e: { id: string }) => e.id)).toEqual([
			evidence.id,
		]);
		const [event] = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.targetId, evidence.id));
		expect(event).toMatchObject({
			action: "evidence.uploaded",
			actorType: "api_token",
		});
		expect(JSON.stringify(event?.metadata)).not.toContain("shop.example");
	});

	it("decides the type from magic bytes and rejects SVG, HTML, mislabeled, and oversized files", async () => {
		const bugId = await createReport();
		const token = await createToken(ctx, cookie, {
			name: "ext",
			client_kind: "extension",
		});
		const send = (bytes: Uint8Array, type: string) =>
			upload(bugId, bearer(token), { meta: META, file: { bytes, type } });

		expect((await send(JPEG, "image/jpeg")).json().evidence.mime_type).toBe(
			"image/jpeg",
		);
		expect((await send(WEBP, "image/webp")).json().evidence.mime_type).toBe(
			"image/webp",
		);
		// A missing or generic declared type is fine; the stored type is the detected one.
		expect(
			(await send(PNG, "application/octet-stream")).json().evidence.mime_type,
		).toBe("image/png");

		for (const [bytes, type] of [
			[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png"],
			[Buffer.from("<!doctype html><script>alert(1)</script>"), "image/png"],
			[Buffer.from("MZ\x90\x00executable"), "image/png"],
			[PNG, "image/jpeg"],
			[PNG, "image/svg+xml"],
		] as const) {
			const response = await send(bytes, type);
			expect(response.statusCode).toBe(415);
			expect(response.json().code).toBe("unsupported_media_type");
		}

		// Above what a model call may carry but below the hard upload limit: refused now, not stored and
		// then unreadable.
		const aboveImageLimit = await send(
			Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]),
			"image/png",
		);
		expect(aboveImageLimit.statusCode).toBe(413);
		expect(aboveImageLimit.json().code).toBe("payload_too_large");
		expect(aboveImageLimit.json().detail).toContain("8 MB");

		const oversized = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
		const tooLarge = await send(oversized, "image/png");
		expect(tooLarge.statusCode).toBe(413);
		expect(tooLarge.json().code).toBe("payload_too_large");
		expect(
			await ctx.db
				.select()
				.from(evidenceAssets)
				.where(eq(evidenceAssets.bugReportId, bugId)),
		).toHaveLength(3);
	});

	it("validates the multipart parts and the meta schema", async () => {
		const bugId = await createReport();
		const token = await createToken(ctx, cookie, {
			name: "ext",
			client_kind: "extension",
		});
		const file = { bytes: PNG, type: "image/png" };
		const missingMeta = await upload(bugId, bearer(token), { file });
		expect(missingMeta.json().code).toBe("validation_failed");
		const extraPart = await upload(bugId, bearer(token), {
			meta: META,
			file,
			extra: { cookies: "session=1" },
		});
		expect(extraPart.json().code).toBe("validation_failed");
		const notJson = await upload(bugId, bearer(token), { meta: "{", file });
		expect(notJson.json().code).toBe("validation_failed");
		const badMeta = await upload(bugId, bearer(token), {
			meta: { ...META, page_url: "javascript:alert(1)", cookies: "x" },
			file,
		});
		expect(badMeta.statusCode).toBe(400);
		expect(
			badMeta.json().errors.map((e: { path: string }) => e.path),
		).toContain("meta.page_url");
		const json = await asToken(ctx, token)(
			"POST",
			`/api/v1/bug-reports/${bugId}/evidence`,
			{ meta: META },
		);
		expect(json.statusCode).toBe(415);
	});

	it("replays an idempotent retry and refuses a reused key with another file", async () => {
		const bugId = await createReport();
		const token = await createToken(ctx, cookie, {
			name: "ext",
			client_kind: "extension",
		});
		const headers = { ...bearer(token), "idempotency-key": "upload-1" };
		const first = await upload(bugId, headers);
		const retry = await upload(bugId, headers);
		expect(retry.statusCode).toBe(201);
		expect(retry.json().evidence.id).toBe(first.json().evidence.id);
		const other = await upload(bugId, headers, {
			meta: META,
			file: { bytes: JPEG, type: "image/jpeg" },
		});
		expect(other.json().code).toBe("idempotency_key_reused");
	});

	it("authenticates and checks scopes before reading the body, and hides other workspaces", async () => {
		const bugId = await createReport();
		const huge = {
			meta: META,
			file: { bytes: Buffer.alloc(11 * 1024 * 1024), type: "image/png" },
		};
		// Rejected before parsing: the answer is 401/403, not 413.
		expect((await upload(bugId, {}, huge)).json().code).toBe("unauthenticated");
		const readOnly = await createToken(ctx, cookie, {
			name: "reader",
			client_kind: "script",
			scopes: ["reports:read"],
		});
		const unscoped = await upload(bugId, bearer(readOnly), huge);
		expect(unscoped.statusCode).toBe(403);
		expect(unscoped.json().code).toBe("insufficient_scope");

		await createOwner(ctx.db, "other@example.com");
		const otherToken = await createToken(
			ctx,
			await login(ctx, "other@example.com"),
			{ name: "ext", client_kind: "extension" },
		);
		const foreign = await upload(bugId, bearer(otherToken));
		expect(foreign.statusCode).toBe(404);
		expect(foreign.json().code).toBe("not_found");
		expect((await upload("bug_nonsense", bearer(otherToken))).statusCode).toBe(
			404,
		);
	});
});

describe("cookie-authenticated requests from an extension origin", () => {
	it("are rejected by the CSRF rule; the same session works from the app origin", async () => {
		const bugId = await createReport();
		const crossOrigin = {
			cookie,
			"x-tracera-csrf": "1",
			origin: EXTENSION_ORIGIN,
		};
		const uploadResponse = await upload(bugId, crossOrigin);
		expect(uploadResponse.statusCode).toBe(403);
		expect(uploadResponse.json().code).toBe("csrf_failed");
		for (const [url, payload] of [
			["/api/v1/bug-reports", { title: "t", description: "d" }],
			["/api/v1/investigations", { bug_report_id: bugId }],
		] as const) {
			const response = await ctx.app.inject({
				method: "POST",
				url,
				headers: crossOrigin,
				payload,
			});
			expect(response.json().code).toBe("csrf_failed");
		}
		expect(
			await ctx.db
				.select()
				.from(evidenceAssets)
				.where(eq(evidenceAssets.bugReportId, bugId)),
		).toHaveLength(0);
		const sameOrigin = await upload(bugId, { cookie, ...csrf(ctx.config) });
		expect(sameOrigin.statusCode).toBe(201);
		expect(sameOrigin.json().evidence.origin).toBe("user_provided");
	});
});

describe("extension submission sequence", () => {
	it("uses the shared bug-report and investigation API and needs explicit scopes beyond the preset", async () => {
		const repo = makeGitRepo(ctx.repoRoot);
		const repository = (
			await session("POST", "/api/v1/repositories", repositoryBody(repo))
		).json().repository;

		// The extension preset (reports:write) can report but cannot list repositories or investigate.
		const preset = asToken(
			ctx,
			await createToken(ctx, cookie, { name: "ext", client_kind: "extension" }),
		);
		expect((await preset("GET", "/api/v1/repositories")).json().code).toBe(
			"insufficient_scope",
		);

		const token = await createToken(ctx, cookie, {
			name: "Chrome extension",
			client_kind: "extension",
			scopes: [
				"reports:write",
				"repositories:read",
				"investigations:write",
				"investigations:read",
			],
		});
		const ext = (
			method: "GET" | "POST",
			url: string,
			payload?: unknown,
			key?: string,
		) =>
			asToken(ctx, token)(method, url, payload, {
				origin: EXTENSION_ORIGIN,
				...(key ? { "idempotency-key": key } : {}),
			});

		expect((await ext("GET", "/api/v1/auth/me")).json().auth.scopes).toContain(
			"investigations:write",
		);
		const repositories = (await ext("GET", "/api/v1/repositories")).json();
		expect(repositories.items.map((r: { id: string }) => r.id)).toEqual([
			repository.id,
		]);
		const reportBody = {
			title: "Average order value is wrong",
			description: "The dashboard shows $12.40.",
			expected_behavior: "$24.80",
			actual_behavior: "$12.40",
			steps: ["Open /dashboard", "Read Average order value"],
			severity: "high",
			environment: {
				browser: "Chrome 141.0.7390.55",
				os: "Windows",
				viewport: { width: 1280, height: 720 },
			},
			affected_url: "https://shop.example/dashboard",
			repository_id: repository.id,
			logs: [
				{
					kind: "log_file",
					content:
						"Console diagnostics (page-reported)\n[error] TypeError: x is undefined",
				},
			],
		};
		const created = await ext(
			"POST",
			"/api/v1/bug-reports",
			reportBody,
			"report-1",
		);
		expect(created.statusCode).toBe(201);
		const bug = created.json().bug_report;
		expect(bug.source_channel).toBe("extension");
		// A retried submission replays the stored report instead of creating a second one.
		expect(
			(await ext("POST", "/api/v1/bug-reports", reportBody, "report-1")).json()
				.bug_report.id,
		).toBe(bug.id);

		const screenshot = await upload(bug.id, {
			...bearer(token),
			origin: EXTENSION_ORIGIN,
			"idempotency-key": "screenshot-1",
		});
		expect(screenshot.statusCode).toBe(201);

		const started = await ext(
			"POST",
			"/api/v1/investigations",
			{ bug_report_id: bug.id, repository_id: repository.id },
			"investigation-1",
		);
		expect(started.statusCode).toBe(202);
		const investigation = started.json().investigation;
		expect(investigation).toMatchObject({
			status: "queued",
			bug_report_id: bug.id,
		});
		const polled = (
			await ext("GET", `/api/v1/investigations/${investigation.id}`)
		).json().investigation;
		expect(polled).toMatchObject({ id: investigation.id, status: "queued" });

		const stored = (
			await session("GET", `/api/v1/bug-reports/${bug.id}`)
		).json().bug_report;
		expect(stored.status).toBe("investigating");
		expect(stored.latest_investigation.id).toBe(investigation.id);
		expect(
			stored.evidence.map((e: { kind: string; origin: string }) => [
				e.kind,
				e.origin,
			]),
		).toEqual([
			["log_file", "user_provided"],
			["screenshot", "captured_by_extension"],
		]);
	});
});
