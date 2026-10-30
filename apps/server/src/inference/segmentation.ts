import { sha256Hex } from "../lib/crypto.ts";
import { redactSecrets } from "../lib/redact.ts";
import {
	type GatewayDeps,
	InferenceError,
	type ModelExecutionStatus,
} from "./gateway.ts";
import {
	DEFAULT_MAX_IMAGE_BYTES,
	ImageError,
	type ImageInput,
	type ImagePart,
	prepareImage,
} from "./images.ts";
import {
	estimateImageCostUsd,
	ProviderError,
	type SegmentBox,
} from "./providers.ts";

export const LOCATE_TASK = {
	name: "locate_ui_element",
	promptVersion: "locate_ui_element.v1",
} as const;

const MAX_TRANSPORT_ATTEMPTS = 3;

/**
 * The segmentation counterpart of the chat gateway: the same budget, limits, redaction, retries, and
 * ModelExecution record around one call to the provider's segmentation model. A provider without one
 * answers `capability_unavailable`; there is no stand-in.
 */
export function createSegmenter(deps: GatewayDeps) {
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	async function locate(input: {
		phrase: string;
		image: ImageInput;
		signal?: AbortSignal;
	}): Promise<{
		boxes: SegmentBox[];
		modelExecutionId: string;
		/** The phrase as sent, after redaction. */
		phrase: string;
	}> {
		const started = Date.now();
		const phrase = redactSecrets(input.phrase, {
			redactEmails: deps.redactEmails,
		});
		let image: ImagePart | null = null;
		let imageError: ImageError | null = null;
		try {
			image = prepareImage(
				input.image,
				deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
			);
		} catch (error) {
			if (!(error instanceof ImageError)) throw error;
			imageError = error;
		}
		const requestHash = sha256Hex(
			JSON.stringify({
				model: deps.model,
				task: LOCATE_TASK.promptVersion,
				phrase: phrase.text,
				image: image ? sha256Hex(image.data) : null,
			}),
		);
		let attempts = 0;
		let billedImages = 0;
		const finish = (
			status: ModelExecutionStatus,
			error: { code: string; message: string } | null,
		) =>
			deps.record({
				task: LOCATE_TASK.name,
				promptVersion: LOCATE_TASK.promptVersion,
				provider: deps.provider.name,
				model: deps.model,
				requestHash,
				status,
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					cachedTokens: 0,
				},
				latencyMs: Date.now() - started,
				estimatedCostUsd: estimateImageCostUsd(deps.model, billedImages),
				redactionCount: phrase.count,
				attempts,
				error,
			});
		const fail = async (
			status: ModelExecutionStatus,
			code: string,
			message: string,
			retryable = false,
		): Promise<never> => {
			const id = await finish(status, { code, message });
			throw new InferenceError(code, message, retryable, id);
		};

		if (imageError || !image)
			return fail(
				"failed",
				imageError?.code ?? "image_empty",
				imageError?.message ?? "The image is empty",
			);
		const segment = deps.provider.locate?.bind(deps.provider);
		if (!segment)
			return fail(
				"failed",
				"capability_unavailable",
				"The configured provider has no segmentation model",
			);
		if ((await deps.spentTodayUsd()) >= deps.dailyBudgetUsd)
			return fail(
				"budget_exceeded",
				"inference_budget_exceeded",
				"The daily inference budget for this workspace is spent",
			);
		const limit = await deps.checkLimits?.();
		if (limit) return fail("budget_exceeded", limit.code, limit.message);

		for (;;) {
			attempts += 1;
			const signals = [
				AbortSignal.timeout(deps.timeoutMs),
				...(input.signal ? [input.signal] : []),
			];
			try {
				const result = await segment(
					{ model: deps.model, phrase: phrase.text, image },
					AbortSignal.any(signals),
				);
				billedImages = result.imagesProcessed;
				return {
					boxes: result.boxes,
					modelExecutionId: await finish("succeeded", null),
					phrase: phrase.text,
				};
			} catch (error) {
				const failure =
					error instanceof ProviderError
						? error
						: new ProviderError(
								"provider_error",
								"Unexpected model provider failure",
								false,
							);
				if (failure.retryable && attempts < MAX_TRANSPORT_ATTEMPTS) {
					await sleep(
						Math.min(failure.retryAfterMs ?? 500 * 2 ** (attempts - 1), 10_000),
					);
					continue;
				}
				return fail(
					failure.code === "cancelled" ? "cancelled" : "failed",
					failure.code,
					failure.message,
					failure.retryable,
				);
			}
		}
	}

	return {
		locate,
		providerName: deps.provider.name,
		providerKind: deps.provider.kind,
		model: deps.model,
	};
}
