import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ImpactSeverity,
	type PatchImpactResult,
	PatchImpactResultSchema,
	type SymbolChange,
	type TestState,
} from "@tracera/contracts";
import { analyzeCommit } from "../apps/server/src/modules/graph.ts";
import { computePatchImpact } from "../apps/server/src/modules/patch-analysis.ts";

// Patch-impact evaluation [deterministic, static analysis, no model, no execution]. Each case is a
// real git repository (a small TypeScript monorepo) with a base commit and a head commit; the
// expected changed symbols, impacted components, and test states are labelled by hand from how the
// fixture was built. The analysis is never shown the reference; nothing here is tuned per case.

type Expectation = {
	/** Every changed symbol, by name. */
	symbols: Record<string, SymbolChange>;
	/** Every component the change truly reaches within the default depth (4), by graph key. */
	impacts: string[];
	tests: Record<string, TestState>;
	/** Findings that may only be reported with low confidence (guessed links). */
	lowConfidence?: string[];
	/** Findings that must be observed broken references. */
	observed?: string[];
	evidenced?: ImpactSeverity | null;
	plausible?: ImpactSeverity | null;
	complete?: boolean;
};
type EvalCase = {
	id: string;
	title: string;
	base?: Record<string, string>;
	change: Record<string, string | null>;
	expect: Expectation;
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const MONEY = (format: string, cents = "Math.round(amount * 100)") =>
	[
		"export function toCents(amount: number): number {",
		`\treturn ${cents};`,
		"}",
		"",
		...(format ? [format] : []),
	].join("\n");
const FORMAT = [
	"export function formatCents(cents: number): string {",
	'\treturn "$" + (cents / 100).toFixed(2);',
	"}",
	"",
].join("\n");
const PRICER = (signature: string, body = "\t\treturn toCents(amount);") =>
	[
		'import { toCents } from "./money.ts";',
		"",
		"export interface Pricer {",
		"\tprice(amount: number): number;",
		"}",
		"",
		"export class FlatPricer implements Pricer {",
		`\t${signature} {`,
		body,
		"\t}",
		"}",
		"",
	].join("\n");

/** A three-package shop: core (money, tax, pricing), api (an Express route), web (a client). */
const BASE: Record<string, string> = {
	"package.json": json({
		name: "evalshop",
		private: true,
		type: "module",
		workspaces: ["packages/*"],
	}),
	"packages/core/package.json": json({ name: "@shop/core", type: "module" }),
	"packages/core/src/money.ts": MONEY(FORMAT),
	"packages/core/src/tax.ts": [
		'import { toCents } from "./money.ts";',
		"",
		"export function taxCents(amount: number, rate: number): number {",
		"\treturn toCents(amount * rate);",
		"}",
		"",
	].join("\n"),
	"packages/core/src/pricer.ts": PRICER("price(amount: number): number"),
	"packages/core/src/index.ts": [
		'export { formatCents, toCents } from "./money.ts";',
		'export { taxCents } from "./tax.ts";',
		'export { FlatPricer } from "./pricer.ts";',
		'export type { Pricer } from "./pricer.ts";',
		"",
	].join("\n"),
	"packages/core/test/money.test.ts": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { toCents } from "../src/money.ts";',
		"",
		'test("converts dollars to cents", () => {',
		"\tassert.equal(toCents(1.5), 150);",
		"});",
		"",
	].join("\n"),
	"packages/api/package.json": json({
		name: "@shop/api",
		type: "module",
		dependencies: { express: "5.0.0" },
	}),
	"packages/api/src/checkout.ts": [
		'import { formatCents, taxCents } from "../../core/src/index.ts";',
		"",
		"export function totalLine(amount: number): string {",
		"\treturn formatCents(taxCents(amount, 0.2));",
		"}",
		"",
	].join("\n"),
	"packages/api/src/quote.ts": [
		'import type { Pricer } from "../../core/src/index.ts";',
		"",
		"export function quote(pricer: Pricer, amount: number): number {",
		"\treturn pricer.price(amount);",
		"}",
		"",
	].join("\n"),
	"packages/api/src/app.ts": [
		'import express, { Router } from "express";',
		'import { totalLine } from "./checkout.ts";',
		"",
		"const app = express();",
		"const router = Router();",
		'app.use("/api", router);',
		'router.get("/total", (req, res) => {',
		"\tres.json({ line: totalLine(Number(req.query.amount)) });",
		"});",
		"export default app;",
		"",
	].join("\n"),
	"packages/web/package.json": json({ name: "@shop/web", type: "module" }),
	"packages/web/src/client.ts": [
		"export async function loadTotal(): Promise<string> {",
		'\tconst response = await fetch("/api/total");',
		"\treturn response.json();",
		"}",
		"",
	].join("\n"),
};

const CORE = "packages/core/src";
const key = {
	flatPrice: `sym:${CORE}/pricer.ts#FlatPricer.price`,
	taxCents: `sym:${CORE}/tax.ts#taxCents`,
	barrel: `file:${CORE}/index.ts`,
	totalLine: "sym:packages/api/src/checkout.ts#totalLine",
	quote: "sym:packages/api/src/quote.ts#quote",
	handler: "sym:packages/api/src/app.ts#GET /total handler",
	route: "route:GET /api/total",
	loadTotal: "sym:packages/web/src/client.ts#loadTotal",
};

export const CASES: EvalCase[] = [
	{
		id: "distant-caller",
		title:
			"A changed function reaches a route four links away and a guessed implementation call",
		change: {
			[`${CORE}/money.ts`]: MONEY(
				FORMAT,
				"Math.round(amount * 100 + Number.EPSILON)",
			),
		},
		expect: {
			symbols: { toCents: "modified" },
			impacts: [
				key.taxCents,
				key.flatPrice,
				key.barrel,
				key.totalLine,
				key.quote,
				key.handler,
				key.route,
			],
			tests: { toCents: "relevant" },
			lowConfidence: [key.quote],
		},
	},
	{
		id: "re-export",
		title:
			"A change reaches its callers through a barrel re-export; a test of the module does not cover it",
		change: {
			[`${CORE}/money.ts`]: MONEY(FORMAT.replace('"$" +', '"USD " +')),
		},
		expect: {
			symbols: { formatCents: "modified" },
			impacts: [
				key.barrel,
				key.totalLine,
				key.handler,
				key.route,
				key.loadTotal,
			],
			tests: { formatCents: "none_identified" },
		},
	},
	{
		id: "public-interface",
		title:
			"An exported function's signature changes; direct callers in another package are high severity",
		change: {
			[`${CORE}/tax.ts`]: (BASE[`${CORE}/tax.ts`] ?? "").replace(
				"rate: number): number",
				"rate: number, region: string): number",
			),
		},
		expect: {
			symbols: { taxCents: "signature_changed" },
			impacts: [
				key.barrel,
				key.totalLine,
				key.handler,
				key.route,
				key.loadTotal,
			],
			tests: { taxCents: "none_identified" },
			evidenced: "high",
			plausible: "high",
		},
	},
	{
		id: "removed-still-referenced",
		title:
			"A removed function is still called through the barrel: an observed broken reference",
		change: { [`${CORE}/money.ts`]: MONEY("") },
		expect: {
			symbols: { formatCents: "removed" },
			impacts: [
				key.barrel,
				key.totalLine,
				key.handler,
				key.route,
				key.loadTotal,
			],
			tests: { formatCents: "none_identified" },
			observed: [key.totalLine],
			evidenced: "high",
		},
	},
	{
		id: "parse-failure",
		title:
			"A test file in the package fails to parse, so coverage is unknown rather than missing",
		base: {
			"packages/core/test/broken.test.ts":
				'import { test } from "node:test";\ntest("formats", () => { formatCents( });\n',
		},
		change: {
			[`${CORE}/money.ts`]: MONEY(FORMAT.replace('"$" +', '"USD " +')),
		},
		expect: {
			symbols: { formatCents: "modified" },
			impacts: [
				key.barrel,
				key.totalLine,
				key.handler,
				key.route,
				key.loadTotal,
			],
			tests: { formatCents: "unknown" },
			complete: false,
		},
	},
	{
		id: "guessed-link",
		title:
			"An implementation reached only through interface dispatch (a guessed link)",
		change: {
			[`${CORE}/pricer.ts`]: PRICER(
				"price(amount: number): number",
				"\t\treturn toCents(amount) + 1;",
			),
		},
		expect: {
			symbols: { "FlatPricer.price": "modified" },
			impacts: [key.quote],
			tests: { "FlatPricer.price": "none_identified" },
			lowConfidence: [key.quote],
		},
	},
	{
		id: "plausible-not-confirmed",
		title:
			"A contract change whose only caller is a guessed link: plausible high severity, not evidenced",
		change: {
			[`${CORE}/pricer.ts`]: PRICER(
				"price(amount: number, currency: string): number",
			),
		},
		expect: {
			symbols: { "FlatPricer.price": "signature_changed" },
			impacts: [key.quote],
			tests: { "FlatPricer.price": "none_identified" },
			lowConfidence: [key.quote],
			evidenced: null,
			plausible: "high",
		},
	},
	{
		id: "unsupported-language",
		title:
			"A change in a language Tracera does not parse falls back to file level with unknown tests",
		base: {
			"packages/core/scripts/report.py": "def report():\n    return 1\n",
		},
		change: {
			"packages/core/scripts/report.py": "def report():\n    return 2\n",
		},
		expect: { symbols: {}, impacts: [], tests: {}, complete: false },
	},
];

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
const write = (dir: string, files: Record<string, string | null>) => {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(dir, file);
		if (content === null) rmSync(target, { force: true });
		else {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
};
const commit = (dir: string, message: string) => {
	git(dir, "add", "-A");
	git(
		dir,
		"-c",
		"user.email=eval@example.com",
		"-c",
		"user.name=eval",
		"commit",
		"-q",
		"-m",
		message,
	);
	return git(dir, "rev-parse", "HEAD");
};

/** A chain is valid when every link is an edge of the graph it came from and the links connect. */
function chainValid(
	finding: PatchImpactResult["findings"][number],
	edges: ReadonlySet<string>,
): boolean {
	if (finding.observed)
		return (
			finding.chain.length === 1 &&
			finding.chain[0]?.from === finding.target.key &&
			(finding.chain[0]?.to.startsWith("unresolved:") ?? false)
		);
	let current = finding.origin.key;
	for (const link of finding.chain) {
		if (!edges.has(`${link.from}\0${link.kind}\0${link.to}`)) return false;
		if (link.to === current) current = link.from;
		else if (link.from === current) current = link.to;
		else return false;
	}
	return current === finding.target.key;
}

type CaseResult = {
	id: string;
	title: string;
	ms: number;
	symbols: { expected: number; found: number; correct: number };
	impacts: {
		expected: number;
		found: number;
		correct: number;
		missed: string[];
		extra: string[];
	};
	invalid_chains: string[];
	confidence_violations: string[];
	tests: { expected: number; correct: number; wrong: string[] };
	false_missing_coverage: number;
	observed_missing: string[];
	risk_ok: boolean;
	complete_ok: boolean;
	stable: boolean;
};

async function runCase(spec: EvalCase): Promise<CaseResult> {
	const dir = mkdtempSync(path.join(tmpdir(), `tracera-impact-${spec.id}-`));
	try {
		git(dir, "init", "-q", "-b", "main");
		write(dir, { ...BASE, ...(spec.base ?? {}) });
		const base = commit(dir, "base");
		write(dir, spec.change);
		const head = commit(dir, "change");
		const input = {
			repositoryId: `eval-${spec.id}`,
			repositoryName: spec.id,
			dir,
			base: { ref: "base", sha: base },
			head: { ref: "head", sha: head, kind: "commit" as const },
			mergeBase: false,
			depth: 4,
			limit: 100,
			deadline: Date.now() + 120_000,
		};
		const started = performance.now();
		const result = PatchImpactResultSchema.parse(
			await computePatchImpact({}, input),
		);
		const ms = Math.round(performance.now() - started);
		const again = await computePatchImpact({}, input);
		const graphs = await Promise.all(
			[base, head].map((sha) =>
				analyzeCommit(
					{},
					{
						repositoryId: "eval",
						repositoryName: spec.id,
						dir,
						commitSha: sha,
						deadline: Date.now() + 60_000,
						skipHistory: true,
					},
				),
			),
		);
		const edgeSet = (index: number) =>
			new Set(
				graphs[index]?.edges.map((e) => `${e.from}\0${e.kind}\0${e.to ?? ""}`),
			);
		const edges = { base: edgeSet(0), head: edgeSet(1) };
		const want = spec.expect;
		const foundSymbols = new Map(result.symbols.map((s) => [s.name, s.change]));
		const correctSymbols = Object.entries(want.symbols).filter(
			([name, change]) => foundSymbols.get(name) === change,
		).length;
		const foundImpacts = new Set(result.findings.map((f) => f.target.key));
		const expected = new Set(want.impacts);
		const byName = new Map(result.symbols.map((s) => [s.name, s]));
		const testsWrong = Object.entries(want.tests)
			.filter(([name, state]) => byName.get(name)?.tests !== state)
			.map(
				([name, state]) =>
					`${name}: expected ${state}, got ${byName.get(name)?.tests ?? "missing"}`,
			);
		const findingByKey = new Map(result.findings.map((f) => [f.target.key, f]));
		return {
			id: spec.id,
			title: spec.title,
			ms,
			symbols: {
				expected: Object.keys(want.symbols).length,
				found: result.symbols.length,
				correct: correctSymbols,
			},
			impacts: {
				expected: expected.size,
				found: foundImpacts.size,
				correct: [...expected].filter((k) => foundImpacts.has(k)).length,
				missed: [...expected].filter((k) => !foundImpacts.has(k)),
				extra: [...foundImpacts].filter((k) => !expected.has(k)),
			},
			invalid_chains: result.findings
				.filter((f) => !chainValid(f, edges[f.graph]))
				.map((f) => f.id),
			confidence_violations: [
				...result.findings
					.filter(
						(f) =>
							f.chain.some((l) => l.certainty === "heuristic") &&
							(f.confidence !== "low" || f.certainty !== "heuristic"),
					)
					.map(
						(f) => `${f.id} has a guessed link but ${f.confidence} confidence`,
					),
				...(want.lowConfidence ?? [])
					.filter(
						(k) =>
							findingByKey.has(k) && findingByKey.get(k)?.confidence !== "low",
					)
					.map((k) => `${k} should be low confidence`),
			],
			tests: {
				expected: Object.keys(want.tests).length,
				correct: Object.keys(want.tests).length - testsWrong.length,
				wrong: testsWrong,
			},
			false_missing_coverage: Object.entries(want.tests).filter(
				([name, state]) =>
					state === "relevant" &&
					["none_identified", "unknown", "possible"].includes(
						byName.get(name)?.tests ?? "",
					),
			).length,
			observed_missing: (want.observed ?? []).filter(
				(k) => findingByKey.get(k)?.observed !== true,
			),
			risk_ok:
				(want.evidenced === undefined ||
					result.risk.evidenced.severity === want.evidenced) &&
				(want.plausible === undefined ||
					result.risk.plausible.severity === want.plausible),
			complete_ok:
				want.complete === undefined || result.complete === want.complete,
			stable: JSON.stringify(again) === JSON.stringify(result),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function runPatchImpactEval() {
	const cases: CaseResult[] = [];
	for (const spec of CASES) cases.push(await runCase(spec));
	const sum = (pick: (c: CaseResult) => number) =>
		cases.reduce((total, c) => total + pick(c), 0);
	const ratio = (a: number, b: number) =>
		b === 0 ? 1 : Math.round((a / b) * 1000) / 1000;
	const metrics = {
		symbol_precision: ratio(
			sum((c) => c.symbols.correct),
			sum((c) => c.symbols.found),
		),
		symbol_recall: ratio(
			sum((c) => c.symbols.correct),
			sum((c) => c.symbols.expected),
		),
		impact_precision: ratio(
			sum((c) => c.impacts.correct),
			sum((c) => c.impacts.found),
		),
		impact_recall: ratio(
			sum((c) => c.impacts.correct),
			sum((c) => c.impacts.expected),
		),
		chain_validity: ratio(
			cases.length - cases.filter((c) => c.invalid_chains.length > 0).length,
			cases.length,
		),
		confidence_violations: sum((c) => c.confidence_violations.length),
		test_state_accuracy: ratio(
			sum((c) => c.tests.correct),
			sum((c) => c.tests.expected),
		),
		false_missing_coverage: sum((c) => c.false_missing_coverage),
		observed_missing: sum((c) => c.observed_missing.length),
		risk_consistency: ratio(
			cases.filter((c) => c.risk_ok).length,
			cases.length,
		),
		completeness_honesty: ratio(
			cases.filter((c) => c.complete_ok).length,
			cases.length,
		),
		stability: ratio(cases.filter((c) => c.stable).length, cases.length),
		median_ms:
			[...cases.map((c) => c.ms)].sort((a, b) => a - b)[
				Math.floor(cases.length / 2)
			] ?? 0,
	};
	// Thresholds are fixed before results are seen and are never lowered to make a run pass.
	const pass =
		metrics.symbol_precision === 1 &&
		metrics.symbol_recall === 1 &&
		metrics.impact_recall >= 0.9 &&
		metrics.impact_precision >= 0.8 &&
		metrics.chain_validity === 1 &&
		metrics.confidence_violations === 0 &&
		metrics.test_state_accuracy === 1 &&
		metrics.false_missing_coverage === 0 &&
		metrics.observed_missing === 0 &&
		metrics.risk_consistency === 1 &&
		metrics.completeness_honesty === 1 &&
		metrics.stability === 1;
	return { pass, metrics, cases };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const report = await runPatchImpactEval();
	const out = path.resolve(import.meta.dirname, "../eval/results");
	mkdirSync(out, { recursive: true });
	const file = path.join(
		out,
		`patch-impact-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	writeFileSync(
		file,
		json({ kind: "patch-impact [static, deterministic]", ...report }),
	);
	console.log(JSON.stringify(report.metrics, null, 2));
	for (const c of report.cases)
		if (
			c.impacts.missed.length +
				c.impacts.extra.length +
				c.invalid_chains.length +
				c.confidence_violations.length +
				c.tests.wrong.length >
				0 ||
			!c.risk_ok ||
			!c.complete_ok ||
			!c.stable
		)
			console.log(
				`${c.id}: ${JSON.stringify({
					missed: c.impacts.missed,
					extra: c.impacts.extra,
					invalid_chains: c.invalid_chains,
					confidence: c.confidence_violations,
					tests: c.tests.wrong,
					risk_ok: c.risk_ok,
					complete_ok: c.complete_ok,
					stable: c.stable,
				})}`,
			);
	console.log(
		`${report.pass ? "PASS" : "FAIL"}: results in ${path.relative(process.cwd(), file)}`,
	);
	process.exitCode = report.pass ? 0 : 1;
}
