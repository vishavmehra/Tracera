import type { JsonSchema } from "../lib/strict-json-schema.ts";

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
export type ChatRequest = {
	model: string;
	messages: ChatMessage[];
	schema: { name: string; jsonSchema: JsonSchema };
	reasoningEffort: ReasoningEffort;
	maxOutputTokens: number;
	promptCacheKey?: string;
};
export type ChatUsage = {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cachedTokens: number;
};
export type ChatResult = {
	content: string;
	finishReason: string | null;
	usage: ChatUsage;
};

export type ProviderKind = "meta" | "openai_compatible" | "mock";

/** One adapter per wire protocol. Provider quirks stay inside this module. */
export type ChatProvider = {
	readonly kind: ProviderKind;
	readonly name: string;
	complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
};

export class ProviderError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly retryAfterMs: number | undefined;

	constructor(
		code: string,
		message: string,
		retryable: boolean,
		retryAfterMs?: number,
	) {
		super(message);
		this.code = code;
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * OpenAI-compatible Chat Completions adapter for the Meta Model API and placeholder hosts (Nebius).
 * Differences handled here: Meta takes `max_completion_tokens` and `prompt_cache_key`; Nebius takes
 * `max_tokens`. Both reject or ignore the `developer` role, so callers only ever send `system`.
 */
export function createHttpProvider(profile: {
	kind: "meta" | "openai_compatible";
	name: string;
	baseUrl: string;
	apiKey: string;
}): ChatProvider {
	const url = `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const tokenParam =
		profile.kind === "meta" ? "max_completion_tokens" : "max_tokens";
	return {
		kind: profile.kind,
		name: profile.name,
		async complete(request, signal) {
			const body = {
				model: request.model,
				messages: request.messages,
				response_format: {
					type: "json_schema",
					json_schema: {
						name: request.schema.name,
						strict: true,
						schema: request.schema.jsonSchema,
					},
				},
				reasoning_effort: request.reasoningEffort,
				[tokenParam]: request.maxOutputTokens,
				...(profile.kind === "meta" && request.promptCacheKey
					? { prompt_cache_key: request.promptCacheKey }
					: {}),
			};
			let response: Response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${profile.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal,
				});
			} catch (error) {
				throw transportError(error, signal);
			}
			let text: string;
			try {
				text = await response.text();
			} catch (error) {
				throw transportError(error, signal);
			}
			if (!response.ok)
				throw errorFromStatus(response.status, text, response.headers);
			return parseCompletion(text);
		},
	};
}

function transportError(error: unknown, signal: AbortSignal): ProviderError {
	if (
		signal.aborted &&
		(signal.reason as Error | undefined)?.name === "TimeoutError"
	) {
		return new ProviderError(
			"provider_timeout",
			"The model provider did not respond in time",
			true,
		);
	}
	if (signal.aborted)
		return new ProviderError(
			"cancelled",
			"The model call was cancelled",
			false,
		);
	return new ProviderError(
		"provider_network_error",
		`Network error reaching the model provider (${(error as Error).name})`,
		true,
	);
}

function errorFromStatus(
	status: number,
	text: string,
	headers: Headers,
): ProviderError {
	let providerCode = "";
	try {
		const parsed = JSON.parse(text) as {
			error?: { code?: unknown; type?: unknown };
		};
		const candidate = parsed.error?.code ?? parsed.error?.type;
		if (typeof candidate === "string") providerCode = candidate.slice(0, 60);
	} catch {
		// Body is not JSON; never echo it, it may contain request content.
	}
	const suffix = providerCode ? ` (${providerCode})` : "";
	if (status === 402)
		return new ProviderError(
			"provider_billing_not_configured",
			`Model provider billing is not configured${suffix}`,
			false,
		);
	if (status === 401 || status === 403)
		return new ProviderError(
			"provider_auth_failed",
			`Model provider rejected the API key${suffix}`,
			false,
		);
	if (status === 429)
		return new ProviderError(
			"provider_rate_limited",
			`Model provider rate limit${suffix}`,
			true,
			retryAfterMs(headers),
		);
	if (status >= 500)
		return new ProviderError(
			"provider_unavailable",
			`Model provider error ${status}${suffix}`,
			true,
		);
	return new ProviderError(
		"provider_bad_request",
		`Model provider rejected the request: HTTP ${status}${suffix}`,
		false,
	);
}

function retryAfterMs(headers: Headers): number | undefined {
	const retryAfter = headers.get("retry-after");
	if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter))
		return Number(retryAfter) * 1000;
	const reset =
		headers.get("x-ratelimit-reset-requests") ??
		headers.get("x-ratelimit-reset-tokens");
	const match = reset?.match(/^(\d+(?:\.\d+)?)(ms|s)$/);
	if (match) return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
	return undefined;
}

function parseCompletion(text: string): ChatResult {
	let json: {
		choices?: Array<{
			message?: { content?: unknown };
			finish_reason?: unknown;
		}>;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			completion_tokens_details?: { reasoning_tokens?: number };
			prompt_tokens_details?: { cached_tokens?: number };
		};
	};
	try {
		json = JSON.parse(text);
	} catch {
		throw new ProviderError(
			"provider_invalid_response",
			"Model provider returned a non-JSON response",
			true,
		);
	}
	const choice = json.choices?.[0];
	const content = choice?.message?.content;
	if (typeof content !== "string")
		throw new ProviderError(
			"provider_invalid_response",
			"Model provider returned no message content",
			true,
		);
	return {
		content,
		finishReason:
			typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
		usage: {
			inputTokens: json.usage?.prompt_tokens ?? 0,
			outputTokens: json.usage?.completion_tokens ?? 0,
			reasoningTokens:
				json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
			cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
		},
	};
}

/** USD per 1M tokens. Reasoning tokens are billed inside output tokens. */
const PRICES: Record<
	string,
	{ input: number; cachedInput: number; output: number }
> = {
	"muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
	"muse-spark-1.2": { input: 1.25, cachedInput: 0.15, output: 4.25 },
	"muse-spark-1.1": { input: 1.25, cachedInput: 0.15, output: 4.25 },
	"muse-spark-1.3-contributor": { input: 0.1, cachedInput: 0.002, output: 0.2 },
	"muse-spark-1.2-contributor": { input: 0.1, cachedInput: 0.002, output: 0.2 },
	"muse-wonder-1.0": { input: 4, cachedInput: 0.2, output: 20 },
	// Cached price for Nebius is not published; billed as full input to stay conservative.
	"meta-models/muse-spark-open": {
		input: 1.25,
		cachedInput: 1.25,
		output: 4.25,
	},
	// Nebius Token Factory list prices from GET /v1/models. Cached input is not published,
	// so it is billed as full input.
	"Qwen/Qwen3-235B-A22B-Instruct-2507": {
		input: 0.2,
		cachedInput: 0.2,
		output: 0.6,
	},
	"Qwen/Qwen3-30B-A3B-Instruct-2507": {
		input: 0.1,
		cachedInput: 0.1,
		output: 0.3,
	},
	"openai/gpt-oss-120b": { input: 0.15, cachedInput: 0.15, output: 0.6 },
	"deepseek-ai/DeepSeek-V4-Flash-0731": {
		input: 0.14,
		cachedInput: 0.14,
		output: 0.28,
	},
	"deepseek-ai/DeepSeek-V4-Pro": {
		input: 1.75,
		cachedInput: 1.75,
		output: 3.5,
	},
	"zai-org/GLM-5.1": { input: 1.4, cachedInput: 1.4, output: 4.4 },
	"mock-reasoner": { input: 0, cachedInput: 0, output: 0 },
};
const UNKNOWN_MODEL_PRICE = { input: 4, cachedInput: 4, output: 20 };

export function estimateCostUsd(model: string, usage: ChatUsage): number {
	const price = PRICES[model] ?? UNKNOWN_MODEL_PRICE;
	const cached = Math.min(usage.cachedTokens, usage.inputTokens);
	const cost =
		((usage.inputTokens - cached) * price.input +
			cached * price.cachedInput +
			usage.outputTokens * price.output) /
		1_000_000;
	return Math.round(cost * 1_000_000) / 1_000_000;
}
