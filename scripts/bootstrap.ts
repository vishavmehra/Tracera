// Runs once per boot, at low priority, after the API is healthy. Where the storage is erased whenever
// the instance sleeps, it brings the demo back by itself: it builds the demo repositories, creates the
// shared judge account, and registers and indexes the repositories through the API as the owner.
// A failure is reported in one line and never stops the service.
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type CreateRepositoryRequest,
	LoginRequestSchema,
} from "@tracera/contracts";
import { z } from "zod";
import { type Config, loadConfig } from "../apps/server/src/config.ts";
import { createDb, createPool, type Db } from "../apps/server/src/db/client.ts";
import { defaultWorkspaceId, seedMember } from "../apps/server/src/db/seed.ts";
import { loadManifest, setupBenchShop } from "./bench-setup.ts";
import { SHOP_UI_REPOSITORY, setupShopUi } from "./shop-ui-setup.ts";

const JUDGE_PASSWORD_LENGTH = { min: 12, max: 256 };
const OWNER_WAIT = { attempts: 36, pauseMs: 5_000 };
const INDEX_WATCH = { pauseMs: 10_000, limitMs: 8 * 60_000, requestAgain: 2 };

export type Judge = { email: string; password: string };

/** The judge account to create: null when none is configured, otherwise the account or what is wrong. */
export function judgeFromEnv(
	env: Record<string, string | undefined>,
): { judge: Judge } | { problem: string } | null {
	const email = env.TRACERA_JUDGE_EMAIL?.trim();
	const password = env.TRACERA_JUDGE_PASSWORD;
	if (!email && !password) return null;
	if (!email || !password)
		return {
			problem:
				"TRACERA_JUDGE_EMAIL and TRACERA_JUDGE_PASSWORD must both be set",
		};
	const { min, max } = JUDGE_PASSWORD_LENGTH;
	if (password.length < min || password.length > max)
		return {
			problem: `TRACERA_JUDGE_PASSWORD must be ${min} to ${max} characters`,
		};
	// The sign-in schema decides what can sign in, so the same check keeps the account usable.
	const login = LoginRequestSchema.safeParse({ email, password });
	return login.success
		? { judge: login.data }
		: { problem: "TRACERA_JUDGE_EMAIL is not a valid email address" };
}

/** Where the Lumen Goods shop repository is built: inside the first repository root, or nowhere. */
export function shopUiPath(repoRoots: string[]): string | null {
	const root = repoRoots[0];
	return root ? path.join(root, SHOP_UI_REPOSITORY.name) : null;
}

/** The demo repositories to register: the Bench Shop fixture, and the shop when it has a place to live. */
export function demoRepositories(
	shopUi: string | null,
): CreateRepositoryRequest[] {
	const bench = loadManifest().repository;
	const repositories: CreateRepositoryRequest[] = [
		{
			name: bench.name,
			source: { type: "fixture", fixture: "bench-shop" },
			commands: bench.commands,
		},
	];
	if (shopUi)
		repositories.push({
			name: SHOP_UI_REPOSITORY.name,
			source: { type: "local_path", path: shopUi },
			commands: { ...SHOP_UI_REPOSITORY.commands },
			app: { ...SHOP_UI_REPOSITORY.app },
		});
	return repositories;
}

/** The registrations still to make: a repository whose name is already taken is left as it is. */
export function missingRepositories(
	existingNames: Iterable<string>,
	wanted: CreateRepositoryRequest[],
): CreateRepositoryRequest[] {
	const taken = new Set(existingNames);
	return wanted.filter((repository) => !taken.has(repository.name));
}

/** What a repository's newest snapshot still needs: nothing (usable), time (in progress), or a request. */
export function indexNeeds(
	status: string | null | undefined,
): "nothing" | "time" | "request" {
	if (status === "ready" || status === "partial") return "nothing";
	if (status === "queued" || status === "indexing") return "time";
	return "request";
}

class ApiError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string) {
		super(`HTTP ${status} ${code}`);
		this.status = status;
		this.code = code;
	}
}

const enabled = (value: string | undefined) =>
	["true", "1"].includes(value ?? "");
const log = (message: string) => console.log(`bootstrap: ${message}`);
/** One line saying what went wrong. A failed query's own message repeats its values (a password hash), so its cause is quoted instead. */
export function reasonOf(error: unknown): string {
	const shown =
		error instanceof Error && error.cause instanceof Error
			? error.cause
			: error;
	return (shown instanceof Error ? shown.message : String(shown))
		.replace(/\s+/g, " ")
		.slice(0, 300);
}

/** Runs one part of the bootstrap; a failure is one line, and the next part still runs. */
async function step(what: string, run: () => Promise<void> | void) {
	try {
		await run();
	} catch (error) {
		console.warn(`bootstrap: ${what} failed: ${reasonOf(error)}`);
	}
}

/** Retries what can pass by itself (no answer, a server error, a throttle), never a refusal. */
async function withRetries<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			const transient =
				!(error instanceof ApiError) ||
				error.status >= 500 ||
				error.status === 429;
			if (attempt >= attempts || !transient) throw error;
			await sleep(5_000 * attempt);
		}
	}
}

/** The API on this machine, signed in as one user. Password hashing is slow, so sign-in gets a long timeout. */
function localApi(config: Config) {
	let cookie = "";
	async function call(
		method: "GET" | "POST",
		pathname: string,
		body?: unknown,
		timeoutMs = 30_000,
	) {
		const response = await fetch(
			`http://127.0.0.1:${config.api.port}${pathname}`,
			{
				method,
				headers: {
					// The server refuses a JSON content type without a body.
					...(body === undefined ? {} : { "content-type": "application/json" }),
					"x-tracera-csrf": "1",
					origin: config.api.publicOrigin,
					...(cookie ? { cookie } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const data: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const problem = z.object({ code: z.string() }).safeParse(data);
			throw new ApiError(
				response.status,
				problem.success ? problem.data.code : "error",
			);
		}
		return { data, response };
	}
	return {
		call,
		async signIn(email: string, password: string) {
			const { response } = await call(
				"POST",
				"/api/v1/auth/login",
				{ email, password },
				90_000,
			);
			cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
			if (!cookie) throw new Error("the sign-in response had no session");
		},
	};
}

const RepositoryListSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			index: z.object({ status: z.string() }).nullable(),
		}),
	),
});

/**
 * Registers what is missing, asks for indexing of every demo repository, and watches until each one is
 * usable. A snapshot that ends failed (for example a job lost while the instance slept) is requested
 * again a couple of times.
 */
async function registerAndIndex(
	config: Config,
	wanted: CreateRepositoryRequest[],
) {
	const email = process.env.TRACERA_SEED_OWNER_EMAIL?.trim();
	const password = process.env.TRACERA_SEED_OWNER_PASSWORD;
	if (!email || !password) {
		log(
			"the owner credentials are not set, so the demo repositories are not registered",
		);
		return;
	}
	const api = localApi(config);
	await withRetries(() => api.signIn(email, password));
	const list = async () =>
		RepositoryListSchema.parse(
			(await withRetries(() => api.call("GET", "/api/v1/repositories"))).data,
		).items;
	try {
		let items = await list();
		for (const request of missingRepositories(
			items.map((item) => item.name),
			wanted,
		))
			await step(`registering ${request.name}`, async () => {
				await api.call("POST", "/api/v1/repositories", request);
				log(`registered ${request.name}`);
			});

		const requested = new Map<string, number>();
		const deadline = Date.now() + INDEX_WATCH.limitMs;
		for (let first = true; ; first = false) {
			items = await list();
			let waiting = false;
			for (const { name } of wanted) {
				const item = items.find((candidate) => candidate.name === name);
				if (!item) continue;
				const needs = indexNeeds(item.index?.status);
				const again = requested.get(name) ?? 0;
				if (
					first ||
					(needs === "request" && again < INDEX_WATCH.requestAgain)
				) {
					if (!first) requested.set(name, again + 1);
					waiting = true;
					await step(`indexing ${name}`, async () => {
						await api.call("POST", `/api/v1/repositories/${item.id}/index`, {});
					});
				} else if (needs === "time") waiting = true;
			}
			if (!waiting || Date.now() > deadline) break;
			await sleep(INDEX_WATCH.pauseMs);
		}
		log(
			`index state: ${wanted
				.map(
					({ name }) =>
						`${name} ${items.find((item) => item.name === name)?.index?.status ?? "not registered"}`,
				)
				.join(", ")}`,
		);
	} finally {
		await api.call("POST", "/api/v1/auth/logout").catch(() => undefined);
	}
}

/** Waits for the first owner, which the seed creates in parallel on the very first boot. */
async function waitForOwner(db: Db): Promise<boolean> {
	for (let attempt = 1; attempt <= OWNER_WAIT.attempts; attempt++) {
		if (await defaultWorkspaceId(db)) return true;
		await sleep(OWNER_WAIT.pauseMs);
	}
	return false;
}

async function main() {
	const config = loadConfig();
	const shopUi = shopUiPath(config.repoRoots);
	const wanted = enabled(process.env.TRACERA_DEMO_REPOS)
		? demoRepositories(shopUi)
		: [];
	const configured = judgeFromEnv(process.env);
	if (configured && "problem" in configured)
		console.warn(`bootstrap: judge account skipped: ${configured.problem}`);
	const judge = configured && "judge" in configured ? configured.judge : null;
	if (wanted.length === 0 && !judge) return;

	if (wanted.length > 0) {
		if (!shopUi)
			log("TRACERA_REPO_ROOTS is empty, so the Lumen Goods shop is skipped");
		await step("building the Bench Shop repository", () => {
			const built = path.join(
				config.dataDir,
				"fixtures",
				loadManifest().fixture,
				".git",
			);
			if (!existsSync(built)) setupBenchShop(config.dataDir);
		});
		if (shopUi)
			await step("building the Lumen Goods shop repository", () => {
				if (!existsSync(path.join(shopUi, ".git"))) setupShopUi(shopUi);
			});
	}

	const pool = createPool(config.databaseUrl, "tracera-bootstrap");
	try {
		const db = createDb(pool);
		if (!(await waitForOwner(db))) {
			log("no owner account exists yet, so there is nothing to attach to");
			return;
		}
		if (judge)
			await step("creating the judge account", async () => {
				const seeded = await seedMember(db, { ...judge, displayName: "Judge" });
				log(
					seeded?.created
						? "created the judge account"
						: "judge account present",
				);
			});
	} finally {
		await pool.end();
	}
	if (wanted.length > 0)
		await step("registering the demo repositories", () =>
			registerAndIndex(config, wanted),
		);
}

if (import.meta.main)
	await main().catch((error: unknown) =>
		console.warn(`bootstrap: stopped: ${reasonOf(error)}`),
	);
