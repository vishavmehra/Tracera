import type { JsonSchema } from "../lib/strict-json-schema.ts";
import type { ChatProvider, ChatRequest } from "./providers.ts";

/**
 * Deterministic offline provider (TRACERA_INFERENCE_PROVIDER=mock). It derives a minimal schema-valid
 * value from the task's JSON Schema and copies the report title when present. It never claims to have
 * analysed anything: callers label every mock result.
 */
export function createMockProvider(): ChatProvider {
	return {
		kind: "mock",
		name: "mock",
		async complete(request: ChatRequest) {
			const value = minimalValue(request.schema.jsonSchema) as Record<
				string,
				unknown
			>;
			const user =
				request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
			const title = user.match(/^Title: (.+)$/m)?.[1]?.slice(0, 200);
			if (title && typeof value === "object" && value && "title" in value)
				value.title = title;
			if (typeof value === "object" && value && "summary" in value)
				value.summary = "Mock inference: no model analysed this report.";
			const content = JSON.stringify(value);
			const inputChars = request.messages.reduce(
				(sum, m) => sum + m.content.length,
				0,
			);
			return {
				content,
				finishReason: "stop",
				usage: {
					inputTokens: Math.ceil(inputChars / 4),
					outputTokens: Math.ceil(content.length / 4),
					reasoningTokens: 0,
					cachedTokens: 0,
				},
			};
		},
	};
}

function minimalValue(schema: JsonSchema): unknown {
	if (Array.isArray(schema.anyOf)) {
		const nullable = (schema.anyOf as JsonSchema[]).some(
			(option) => option.type === "null",
		);
		return nullable
			? null
			: minimalValue((schema.anyOf as JsonSchema[])[0] ?? {});
	}
	if (Array.isArray(schema.enum))
		return schema.enum.includes("unknown") ? "unknown" : schema.enum[0];
	switch (schema.type) {
		case "object": {
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(
				(schema.properties as Record<string, JsonSchema>) ?? {},
			))
				out[key] = minimalValue(child);
			return out;
		}
		case "array":
			return [];
		case "string":
			return "";
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		default:
			return null;
	}
}
