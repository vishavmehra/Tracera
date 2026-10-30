import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_IMAGE_BYTES } from "@tracera/contracts";
import { z } from "zod";

/** Thrown when environment configuration is invalid. Messages name variables, never their values. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

const unset = (value: unknown) =>
	typeof value === "string" && value.trim() === "" ? undefined : value;
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(unset, schema);
const bool = (fallback: boolean) =>
	opt(z.enum(["true", "false", "1", "0"]).optional()).transform((v) =>
		v === undefined ? fallback : v === "true" || v === "1",
	);
const int = (fallback: number, min: number, max: number) =>
	opt(z.coerce.number().int().min(min).max(max).default(fallback));

/** The pinned Node sandbox image, by digest. Update with `npm run sandbox:pull`. */
export const DEFAULT_SANDBOX_IMAGE =
	"node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
/**
 * The pinned Playwright browser image (mcr.microsoft.com/playwright), by digest. Its release must match
 * the `playwright-core` version in apps/server/package.json. Update with `npm run sandbox:pull`.
 */
export const DEFAULT_BROWSER_IMAGE =
	"mcr.microsoft.com/playwright@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea";

/** Model-backed tasks that can be routed to different models. */
export type ModelTask =
	| "normalize_bug_report"
	| "plan_reproduction"
	| "generate_hypotheses"
	| "generate_patch"
	| "assess_feasibility"
	| "answer_question";

const EnvSchema = z
	.object({
		NODE_ENV: opt(
			z.enum(["development", "test", "production"]).default("development"),
		),
		LOG_LEVEL: opt(
			z
				.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
				.default("info"),
		),
		TRACERA_API_HOST: opt(z.string().default("127.0.0.1")),
		TRACERA_API_PORT: int(8787, 1, 65_535),
		TRACERA_PUBLIC_URL: opt(
			z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8787"),
		),
		DATABASE_URL: opt(z.url({ protocol: /^postgres(ql)?$/ })),
		TRACERA_AUTO_MIGRATE: bool(false),
		TRACERA_DATA_DIR: opt(z.string().optional()),
		TRACERA_REPO_ROOTS: opt(z.string().optional()),
		TRACERA_INFERENCE_PROVIDER: opt(
			z.enum(["mock", "openai_compatible", "meta"]).default("mock"),
		),
		TRACERA_META_API_KEY: opt(z.string().optional()),
		TRACERA_META_BASE_URL: opt(
			z.url({ protocol: /^https$/ }).default("https://api.meta.ai/v1"),
		),
		TRACERA_OPENAI_COMPAT_BASE_URL: opt(
			z.url({ protocol: /^https?$/ }).optional(),
		),
		TRACERA_OPENAI_COMPAT_API_KEY: opt(z.string().optional()),
		TRACERA_OPENAI_COMPAT_PROVIDER_NAME: opt(
			z
				.string()
				.regex(/^[a-z0-9_-]{1,40}$/)
				.default("openai_compatible"),
		),
		TRACERA_MODEL_REASONING: opt(z.string().max(200).optional()),
		TRACERA_MODEL_NORMALIZE: opt(z.string().max(200).optional()),
		TRACERA_MODEL_REPRODUCTION: opt(z.string().max(200).optional()),
		TRACERA_MODEL_HYPOTHESES: opt(z.string().max(200).optional()),
		TRACERA_MODEL_PATCH: opt(z.string().max(200).optional()),
		TRACERA_MODEL_ASSESSMENT: opt(z.string().max(200).optional()),
		TRACERA_MODEL_QUESTION: opt(z.string().max(200).optional()),
		TRACERA_MODEL_ESCALATION: opt(z.string().max(200).optional()),
		TRACERA_ESCALATION_ENABLED: bool(false),
		TRACERA_INVESTIGATION_MAX_MODEL_CALLS: int(16, 1, 200),
		TRACERA_INVESTIGATION_BUDGET_USD: opt(
			z.coerce.number().min(0).max(100).default(1),
		),
		TRACERA_LLM_DAILY_BUDGET_USD: opt(
			z.coerce.number().min(0).max(10_000).default(5),
		),
		TRACERA_LLM_MAX_CONCURRENCY: int(4, 1, 32),
		TRACERA_LLM_TIMEOUT_MS: int(120_000, 1_000, 600_000),
		TRACERA_REDACT_EMAILS: bool(true),
		TRACERA_SANDBOX_MODE: opt(
			z.enum(["docker", "disabled", "fake"]).default("docker"),
		),
		/** Must be pinned by digest; Tracera never pulls or builds images at run time. */
		TRACERA_SANDBOX_IMAGE: opt(
			z
				.string()
				.regex(
					/^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/,
					"Use an image pinned by digest (name@sha256:...)",
				)
				.default(DEFAULT_SANDBOX_IMAGE),
		),
		/** The browser reproduction image; pinned by digest like the sandbox image. */
		TRACERA_BROWSER_IMAGE: opt(
			z
				.string()
				.regex(
					/^[a-z0-9][a-z0-9./_-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/,
					"Use an image pinned by digest (name@sha256:...)",
				)
				.default(DEFAULT_BROWSER_IMAGE),
		),
		TRACERA_SANDBOX_TIMEOUT_MS: int(120_000, 5_000, 600_000),
		/** The one registry dependency preparation may reach; lockfiles must resolve only from it. */
		TRACERA_DEPS_REGISTRY: opt(
			z
				.string()
				.refine((value) => {
					try {
						const url = new URL(value);
						return (
							(url.protocol === "https:" || url.protocol === "http:") &&
							!url.username &&
							!url.password &&
							!url.search &&
							!url.hash
						);
					} catch {
						return false;
					}
				}, "Use a plain http(s) registry URL without credentials, query, or fragment")
				.default("https://registry.npmjs.org/"),
		),
		TRACERA_DEPS_TIMEOUT_MS: int(600_000, 30_000, 840_000),
		/** Prepared dependency snapshots kept per repository (least recently used ones are removed). */
		TRACERA_DEPS_KEEP: int(3, 1, 20),
		/** Docker network the egress proxy uses to reach the registry. */
		TRACERA_DEPS_EGRESS_NETWORK: opt(
			z
				.string()
				.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/)
				.default("bridge"),
		),
		/** Behind a reverse proxy the client address is only in X-Forwarded-For; without it every login is throttled as one address. */
		TRACERA_TRUST_PROXY: bool(false),
		/** Model for observe_screenshot; the default depends on the provider (see visionModel). */
		TRACERA_MODEL_VISION: opt(z.string().max(200).optional()),
		/** Largest image a model call may carry. Meta accepts up to 50 MB inline. */
		TRACERA_MAX_IMAGE_BYTES: int(
			DEFAULT_MAX_IMAGE_BYTES,
			1_024,
			50 * 1024 * 1024,
		),
		/** Segmentation model used to locate a named UI element in a screenshot; only Meta hosts one. */
		TRACERA_MODEL_SEGMENT: opt(z.string().max(200).default("sam-3.1")),
	})
	.superRefine((env, ctx) => {
		const require = (key: keyof typeof env, reason: string) => {
			if (!env[key])
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: `Required when ${reason}`,
				});
		};
		if (env.TRACERA_INFERENCE_PROVIDER === "openai_compatible") {
			require("TRACERA_OPENAI_COMPAT_BASE_URL", "TRACERA_INFERENCE_PROVIDER=openai_compatible");
			require("TRACERA_OPENAI_COMPAT_API_KEY", "TRACERA_INFERENCE_PROVIDER=openai_compatible");
			require("TRACERA_MODEL_REASONING", "TRACERA_INFERENCE_PROVIDER=openai_compatible");
		}
		if (env.TRACERA_INFERENCE_PROVIDER === "meta")
			require("TRACERA_META_API_KEY", "TRACERA_INFERENCE_PROVIDER=meta");
		if (env.TRACERA_SANDBOX_MODE === "fake" && env.NODE_ENV !== "test") {
			ctx.addIssue({
				code: "custom",
				path: ["TRACERA_SANDBOX_MODE"],
				message: "fake is only allowed when NODE_ENV=test",
			});
		}
	});

/** TRACERA_DATA_DIR or ~/.tracera. Shared with scripts that need the data directory without a database. */
export const resolveDataDir = (env: {
	TRACERA_DATA_DIR?: string | undefined;
}) =>
	path.resolve(
		env.TRACERA_DATA_DIR?.trim() || path.join(os.homedir(), ".tracera"),
	);

export type InferenceProviderKind = "mock" | "openai_compatible" | "meta";

export type Config = {
	env: "development" | "test" | "production";
	logLevel: string;
	api: {
		host: string;
		port: number;
		publicUrl: string;
		publicOrigin: string;
		trustProxy: boolean;
	};
	databaseUrl: string;
	autoMigrate: boolean;
	dataDir: string;
	repoRoots: string[];
	/** Root of the Tracera source tree; repositories inside it can never be registered. */
	sourceRoot: string;
	inference: {
		provider: InferenceProviderKind;
		providerName: string;
		baseUrl: string | null;
		apiKey: string | null;
		reasoningModel: string;
		/** Per-task model IDs; each defaults to reasoningModel. */
		taskModels: Record<ModelTask, string>;
		/** Used only for a final patch attempt, and only when escalation is enabled. */
		escalationModel: string | null;
		escalationEnabled: boolean;
		dailyBudgetUsd: number;
		maxConcurrency: number;
		timeoutMs: number;
		redactEmails: boolean;
		investigationMaxModelCalls: number;
		investigationBudgetUsd: number;
		/** Model for observe_screenshot: Muse Spark on Meta, a Gemma vision model on the Nebius profile. */
		visionModel: string;
		maxImageBytes: number;
		segmentModel: string;
	};
	sandboxMode: "docker" | "disabled" | "fake";
	sandboxImage: string;
	browserImage: string;
	sandboxTimeoutMs: number;
	dependencies: {
		registry: string;
		timeoutMs: number;
		keep: number;
		egressNetwork: string;
	};
	meetings: MeetingsConfig;
};

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const parsed = EnvSchema.safeParse(env);
	if (!parsed.success) {
		const lines = parsed.error.issues.map(
			(issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`,
		);
		throw new ConfigError(
			`Invalid configuration:\n${lines.join("\n")}\nSee .env.example.`,
		);
	}
	const e = parsed.data;
	if (!e.DATABASE_URL)
		throw new ConfigError(
			"Invalid configuration:\n- DATABASE_URL: Required\nSee .env.example.",
		);
	const provider = e.TRACERA_INFERENCE_PROVIDER;
	const reasoningModel =
		e.TRACERA_MODEL_REASONING ??
		(provider === "meta" ? "muse-spark-1.3" : "mock-reasoner");
	return {
		env: e.NODE_ENV,
		logLevel: e.LOG_LEVEL,
		api: {
			host: e.TRACERA_API_HOST,
			port: e.TRACERA_API_PORT,
			publicUrl: e.TRACERA_PUBLIC_URL,
			publicOrigin: new URL(e.TRACERA_PUBLIC_URL).origin,
			trustProxy: e.TRACERA_TRUST_PROXY,
		},
		databaseUrl: e.DATABASE_URL,
		autoMigrate: e.TRACERA_AUTO_MIGRATE,
		dataDir: resolveDataDir(e),
		repoRoots: (e.TRACERA_REPO_ROOTS ?? "")
			.split(";")
			.map((root) => root.trim())
			.filter(Boolean),
		sourceRoot: path.resolve(import.meta.dirname, "../../.."),
		inference: {
			provider,
			providerName:
				provider === "openai_compatible"
					? e.TRACERA_OPENAI_COMPAT_PROVIDER_NAME
					: provider === "meta"
						? "meta"
						: "mock",
			baseUrl:
				provider === "meta"
					? e.TRACERA_META_BASE_URL
					: provider === "openai_compatible"
						? (e.TRACERA_OPENAI_COMPAT_BASE_URL ?? null)
						: null,
			apiKey:
				provider === "meta"
					? (e.TRACERA_META_API_KEY ?? null)
					: provider === "openai_compatible"
						? (e.TRACERA_OPENAI_COMPAT_API_KEY ?? null)
						: null,
			reasoningModel,
			taskModels: {
				normalize_bug_report: e.TRACERA_MODEL_NORMALIZE ?? reasoningModel,
				plan_reproduction: e.TRACERA_MODEL_REPRODUCTION ?? reasoningModel,
				generate_hypotheses: e.TRACERA_MODEL_HYPOTHESES ?? reasoningModel,
				generate_patch: e.TRACERA_MODEL_PATCH ?? reasoningModel,
				assess_feasibility: e.TRACERA_MODEL_ASSESSMENT ?? reasoningModel,
				answer_question: e.TRACERA_MODEL_QUESTION ?? reasoningModel,
			},
			escalationModel: e.TRACERA_MODEL_ESCALATION ?? null,
			escalationEnabled: e.TRACERA_ESCALATION_ENABLED,
			dailyBudgetUsd: e.TRACERA_LLM_DAILY_BUDGET_USD,
			maxConcurrency: e.TRACERA_LLM_MAX_CONCURRENCY,
			timeoutMs: e.TRACERA_LLM_TIMEOUT_MS,
			redactEmails: e.TRACERA_REDACT_EMAILS,
			investigationMaxModelCalls: e.TRACERA_INVESTIGATION_MAX_MODEL_CALLS,
			investigationBudgetUsd: e.TRACERA_INVESTIGATION_BUDGET_USD,
			visionModel:
				e.TRACERA_MODEL_VISION ??
				(provider === "meta"
					? "muse-spark-1.3"
					: provider === "openai_compatible"
						? "google/gemma-3-27b-it"
						: "mock-vision"),
			maxImageBytes: e.TRACERA_MAX_IMAGE_BYTES,
			segmentModel: e.TRACERA_MODEL_SEGMENT,
		},
		sandboxMode: e.TRACERA_SANDBOX_MODE,
		sandboxImage: e.TRACERA_SANDBOX_IMAGE,
		browserImage: e.TRACERA_BROWSER_IMAGE,
		sandboxTimeoutMs: e.TRACERA_SANDBOX_TIMEOUT_MS,
		dependencies: {
			registry: e.TRACERA_DEPS_REGISTRY,
			timeoutMs: e.TRACERA_DEPS_TIMEOUT_MS,
			keep: e.TRACERA_DEPS_KEEP,
			egressNetwork: e.TRACERA_DEPS_EGRESS_NETWORK,
		},
		meetings: loadMeetingsConfig(env, reasoningModel),
	};
}

/** Configuration summary that is safe to log (no keys, no database credentials). */
export function describeConfig(config: Config) {
	return {
		env: config.env,
		api: `${config.api.host}:${config.api.port}`,
		database: new URL(config.databaseUrl).host,
		dataDir: config.dataDir,
		repoRoots: config.repoRoots.length,
		inference: {
			provider: config.inference.provider,
			name: config.inference.providerName,
			model: config.inference.reasoningModel,
			task_models: config.inference.taskModels,
			vision_model: config.inference.visionModel,
			escalation:
				config.inference.escalationEnabled && config.inference.escalationModel
					? config.inference.escalationModel
					: null,
		},
		sandboxMode: config.sandboxMode,
		sandboxImage: config.sandboxImage,
		dependencyRegistry: new URL(config.dependencies.registry).origin,
	};
}

// ---- Meetings and integrations ----

const MeetingEnvSchema = z.object({
	TRACERA_MODEL_MEETING: opt(z.string().max(200).optional()),
	TRACERA_ENCRYPTION_KEY: opt(z.string().optional()),
	GOOGLE_CLIENT_ID: opt(z.string().max(300).optional()),
	GOOGLE_CLIENT_SECRET: opt(z.string().max(500).optional()),
	GOOGLE_REDIRECT_URI: opt(z.url({ protocol: /^https?$/ }).optional()),
});

export const GOOGLE_CALLBACK_PATH = "/api/v1/integrations/google/callback";

export type MeetingsConfig = {
	/** Model for extract_meeting_bugs: TRACERA_MODEL_MEETING, else TRACERA_MODEL_REASONING. */
	model: string;
	/** AES-256-GCM key for OAuth tokens at rest; null when unset. */
	encryptionKey: Buffer | null;
	/** Set only when every Google variable and the encryption key are present. */
	google: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
	} | null;
	/** Names of the variables the Google integration still needs (never their values). */
	googleMissing: string[];
};

/** A partly configured integration is reported as not configured; malformed values fail startup. */
function loadMeetingsConfig(
	env: Record<string, string | undefined>,
	reasoningModel: string,
): MeetingsConfig {
	const parsed = MeetingEnvSchema.safeParse(env);
	const invalid = (path: string, message: string) =>
		new ConfigError(
			`Invalid configuration:\n- ${path}: ${message}\nSee .env.example.`,
		);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw invalid(
			String(issue?.path[0] ?? "(root)"),
			issue?.message ?? "invalid",
		);
	}
	const e = parsed.data;
	let encryptionKey: Buffer | null = null;
	if (e.TRACERA_ENCRYPTION_KEY) {
		const value = e.TRACERA_ENCRYPTION_KEY.trim();
		encryptionKey = Buffer.from(value, "base64");
		if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || encryptionKey.length !== 32)
			throw invalid(
				"TRACERA_ENCRYPTION_KEY",
				"must be 32 random bytes encoded as base64",
			);
	}
	if (
		e.GOOGLE_REDIRECT_URI &&
		new URL(e.GOOGLE_REDIRECT_URI).pathname !== GOOGLE_CALLBACK_PATH
	)
		throw invalid(
			"GOOGLE_REDIRECT_URI",
			`must end with ${GOOGLE_CALLBACK_PATH}`,
		);
	const missing = (
		[
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"GOOGLE_REDIRECT_URI",
			"TRACERA_ENCRYPTION_KEY",
		] as const
	).filter((name) => !e[name]);
	return {
		model: e.TRACERA_MODEL_MEETING ?? reasoningModel,
		encryptionKey,
		google:
			e.GOOGLE_CLIENT_ID &&
			e.GOOGLE_CLIENT_SECRET &&
			e.GOOGLE_REDIRECT_URI &&
			encryptionKey
				? {
						clientId: e.GOOGLE_CLIENT_ID,
						clientSecret: e.GOOGLE_CLIENT_SECRET,
						redirectUri: e.GOOGLE_REDIRECT_URI,
					}
				: null,
		googleMissing: missing,
	};
}

// ---- end of the meetings section ----
