import { sha256Hex } from "../lib/crypto.ts";
import { redactSecrets } from "../lib/redact.ts";
import {
	DEFAULT_MAX_IMAGE_BYTES,
	ImageError,
	type ImageInput,
	type ImagePart,
	prepareImage,
} from "./images.ts";
import {
	type ChatMessage,
	type ChatProvider,
	type ChatUsage,
	estimateCostUsd,
	ProviderError,
} from "./providers.ts";
import type { TaskDefinition } from "./tasks.ts";

export type ModelExecutionStatus =
	| "succeeded"
	| "failed"
	| "invalid_output"
	| "cancelled"
	| "budget_exceeded";

export type ModelExecutionRecord = {
	task: string;
	promptVersion: string;
	provider: string;
	model: string;
	requestHash: string;
	status: ModelExecutionStatus;
	usage: ChatUsage;
	latencyMs: number;
	estimatedCostUsd: number;
	redactionCount: number;
	attempts: number;
	error: { code: string; message: string } | null;
};

export class InferenceError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly modelExecutionId: string | null;

	constructor(
		code: string,
		message: string,
		retryable: boolean,
		modelExecutionId: string | null,
	) {
		super(message);
		this.code = code;
		this.retryable = retryable;
		this.modelExecutionId = modelExecutionId;
	}
}

export type GatewayDeps = {
	provider: ChatProvider;
	model: string;
	timeoutMs: number;
	redactEmails: boolean;
	maxConcurrency: number;
	dailyBudgetUsd: number;
	/** Largest image a call may carry; defaults to 8 MiB. */
	maxImageBytes?: number;
	spentTodayUsd(): Promise<number>;
	/** Optional scope limits, such as an investigation's call and cost budget. Null means allowed. */
	checkLimits?: () => Promise<{ code: string; message: string } | null>;
	/** Persists one ModelExecution row and returns its id. Called exactly once per run. */
	record(execution: ModelExecutionRecord): Promise<string>;
	sleep?: (ms: number) => Promise<void>;
};

export type Gateway = ReturnType<typeof createGateway>;

const MAX_TRANSPORT_ATTEMPTS = 3;
const MAX_IMAGES_PER_CALL = 4;

/**
 * The only path to a model: budget check, secret redaction, bounded retries with
 * per-call timeouts, strict-schema output, Zod validation with one repair attempt, and a ModelExecution
 * record for every run, successful or not.
 */
export function createGateway(deps: GatewayDeps) {
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let active = 0;
	const waiting: Array<() => void> = [];
	const acquire = async () => {
		if (active >= deps.maxConcurrency)
			await new Promise<void>((resolve) => waiting.push(resolve));
		active += 1;
	};
	const release = () => {
		active -= 1;
		waiting.shift()?.();
	};

	async function run<T>(
		task: TaskDefinition<T>,
		input: {
			user: string;
			cacheKey?: string;
			signal?: AbortSignal;
			/** Redaction applies to `user`; pixels are sent as they are. */
			images?: ImageInput[];
		},
	): Promise<{ output: T; modelExecutionId: string; usage: ChatUsage }> {
		const started = Date.now();
		const redacted = redactSecrets(input.user, {
			redactEmails: deps.redactEmails,
		});
		let images: ImagePart[] = [];
		let imageError: ImageError | null = null;
		try {
			if ((input.images?.length ?? 0) > MAX_IMAGES_PER_CALL)
				throw new ImageError(
					"image_too_large",
					`A call carries at most ${MAX_IMAGES_PER_CALL} images`,
				);
			images = (input.images ?? []).map((image) =>
				prepareImage(image, deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES),
			);
		} catch (error) {
			if (!(error instanceof ImageError)) throw error;
			imageError = error;
		}
		const requestHash = sha256Hex(
			JSON.stringify({
				model: deps.model,
				task: task.promptVersion,
				user: redacted.text,
				...(images.length > 0
					? { images: images.map((image) => sha256Hex(image.data)) }
					: {}),
			}),
		);
		const usage: ChatUsage = {
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cachedTokens: 0,
		};
		let attempts = 0;

		const finish = async (
			status: ModelExecutionStatus,
			error: { code: string; message: string } | null,
		) =>
			deps.record({
				task: task.name,
				promptVersion: task.promptVersion,
				provider: deps.provider.name,
				model: deps.model,
				requestHash,
				status,
				usage,
				latencyMs: Date.now() - started,
				estimatedCostUsd: estimateCostUsd(deps.model, usage),
				redactionCount: redacted.count,
				attempts,
				error,
			});

		if (imageError) {
			const id = await finish("failed", {
				code: imageError.code,
				message: imageError.message,
			});
			throw new InferenceError(imageError.code, imageError.message, false, id);
		}

		if ((await deps.spentTodayUsd()) >= deps.dailyBudgetUsd) {
			const id = await finish("budget_exceeded", {
				code: "inference_budget_exceeded",
				message: "Daily inference budget reached",
			});
			throw new InferenceError(
				"inference_budget_exceeded",
				"The daily inference budget for this workspace is spent",
				false,
				id,
			);
		}

		const limit = await deps.checkLimits?.();
		if (limit) {
			const id = await finish("budget_exceeded", limit);
			throw new InferenceError(limit.code, limit.message, false, id);
		}

		const call = async (messages: ChatMessage[]) => {
			for (;;) {
				attempts += 1;
				const signals = [
					AbortSignal.timeout(deps.timeoutMs),
					...(input.signal ? [input.signal] : []),
				];
				try {
					const result = await deps.provider.complete(
						{
							model: deps.model,
							messages,
							schema: { name: task.name, jsonSchema: task.jsonSchema },
							reasoningEffort: task.reasoningEffort,
							maxOutputTokens: task.maxOutputTokens,
							promptCacheKey: input.cacheKey,
						},
						AbortSignal.any(signals),
					);
					usage.inputTokens += result.usage.inputTokens;
					usage.outputTokens += result.usage.outputTokens;
					usage.reasoningTokens += result.usage.reasoningTokens;
					usage.cachedTokens += result.usage.cachedTokens;
					return result;
				} catch (error) {
					const providerError =
						error instanceof ProviderError
							? error
							: new ProviderError(
									"provider_error",
									"Unexpected model provider failure",
									false,
								);
					if (!providerError.retryable || attempts >= MAX_TRANSPORT_ATTEMPTS)
						throw providerError;
					const backoff =
						providerError.retryAfterMs ??
						500 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250);
					await sleep(Math.min(backoff, 10_000));
				}
			}
		};

		await acquire();
		try {
			const messages: ChatMessage[] = [
				{ role: "system", content: task.systemPrompt },
				{
					role: "user",
					content: redacted.text,
					...(images.length > 0 ? { images } : {}),
				},
			];
			let result = await call(messages);
			let parsed = validate(task, result.content, result.finishReason);
			if (!parsed.ok) {
				result = await call([
					...messages,
					{ role: "assistant", content: result.content.slice(0, 20_000) },
					{
						role: "user",
						content: `Your previous reply did not match the required schema: ${parsed.problem}. Reply again with corrected JSON only.`,
					},
				]);
				parsed = validate(task, result.content, result.finishReason);
			}
			if (!parsed.ok) {
				const id = await finish("invalid_output", {
					code: "model_output_invalid",
					message: parsed.problem,
				});
				throw new InferenceError(
					"model_output_invalid",
					"The model output did not match the required schema",
					false,
					id,
				);
			}
			const id = await finish("succeeded", null);
			return {
				output: parsed.value,
				modelExecutionId: id,
				usage: { ...usage },
			};
		} catch (error) {
			if (error instanceof InferenceError) throw error;
			const providerError = error as ProviderError;
			const status =
				providerError.code === "cancelled" ? "cancelled" : "failed";
			const id = await finish(status, {
				code: providerError.code,
				message: providerError.message,
			});
			throw new InferenceError(
				providerError.code,
				providerError.message,
				providerError.retryable,
				id,
			);
		} finally {
			release();
		}
	}

	return {
		run,
		providerName: deps.provider.name,
		providerKind: deps.provider.kind,
		model: deps.model,
	};
}

function validate<T>(
	task: TaskDefinition<T>,
	content: string,
	finishReason: string | null,
): { ok: true; value: T } | { ok: false; problem: string } {
	if (finishReason === "length")
		return {
			ok: false,
			problem: "the output was truncated (finish_reason=length)",
		};
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		return { ok: false, problem: "the output was not valid JSON" };
	}
	const result = task.outputSchema.safeParse(json);
	if (result.success) return { ok: true, value: result.data };
	const issues = result.error.issues
		.slice(0, 10)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
	return { ok: false, problem: issues.join("; ").slice(0, 1000) };
}
