import { z } from "zod";

export type JsonSchema = { type?: unknown; [key: string]: unknown };

/** Keywords some providers reject in strict mode. Zod still enforces them after parsing. */
const DROPPED_KEYWORDS = new Set([
	"$schema",
	"default",
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
]);

/**
 * Converts a Zod schema to the strict JSON Schema subset accepted by Meta's API (and Nebius):
 * every object closed (`additionalProperties: false`) and every property required. Optional values
 * must be modeled as nullable in the Zod schema.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
	return strictify(
		z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }),
	) as JsonSchema;
}

function strictify(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(strictify);
	if (!node || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node))
		if (!DROPPED_KEYWORDS.has(key)) out[key] = strictify(value);
	if (
		out.type === "object" &&
		out.properties &&
		typeof out.properties === "object"
	) {
		out.additionalProperties = false;
		out.required = Object.keys(out.properties);
	}
	return out;
}
