import { z } from "zod";

/** Prefixes for Tracera IDs. Every ID is `<prefix>_<26-char ULID>`. */
export const ID_PREFIXES = [
	"usr",
	"wsp",
	"tok",
	"repo",
	"bug",
	"evd",
	"inv",
	"stp",
	"mex",
	"aud",
	"ive",
	"hyp",
	"sbx",
	"pat",
	"ver",
	"rpt",
	"snap",
	"gnd",
	"asm",
	"pia",
	"dep",
	// Meetings: sessions, transcript segments, bug candidates, integration connections.
	"mtg",
	"seg",
	"cand",
	"int",
	"act",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

export const idSchema = (prefix: IdPrefix) =>
	z
		.string()
		.regex(
			new RegExp(`^${prefix}_${ULID_PATTERN}$`),
			`Expected a ${prefix}_ identifier`,
		);

/** A branch, tag, or commit name: no options, ranges, reflog syntax, or whitespace. */
export const RefNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9._/-]{1,200}$/)
	.refine((ref) => !ref.startsWith("-") && !ref.includes(".."), {
		message: "Not a branch, tag, or commit name",
	});

export const SeveritySchema = z.enum([
	"critical",
	"high",
	"medium",
	"low",
	"unknown",
]);
export const PrioritySchema = z.enum(["p0", "p1", "p2", "p3", "unknown"]);
export const ValueSourceSchema = z.enum([
	"user_provided",
	"user_edited",
	"ai_inferred",
	"meeting_extracted",
	"system_default",
]);
export const SourceChannelSchema = z.enum([
	"web",
	"extension",
	"meeting",
	"mcp",
	"api",
]);

export const PaginationQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().max(300).optional(),
});

/** RFC 9457 problem details as returned by every error response. */
export const ProblemSchema = z.object({
	type: z.string(),
	title: z.string(),
	status: z.number().int(),
	detail: z.string(),
	code: z.string(),
	request_id: z.string(),
	errors: z
		.array(z.object({ path: z.string(), message: z.string() }))
		.optional(),
});

export type Severity = z.infer<typeof SeveritySchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type ValueSource = z.infer<typeof ValueSourceSchema>;
export type SourceChannel = z.infer<typeof SourceChannelSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
