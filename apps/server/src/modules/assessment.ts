import path from "node:path";
import type {
	AnswerStatus,
	AskQuestionRequest,
	AssessmentStatus,
	ChangeSize,
	Citation,
	Confidence,
	CreateAssessmentRequest,
	EvidenceRef,
	SpecialistRole,
} from "@tracera/contracts";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import {
	assessments,
	graphEdges,
	graphNodes,
	repositories,
	repositorySnapshots,
} from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	answerQuestionTask,
	assessFeasibilityTask,
	buildAssessmentInput,
	buildQuestionInput,
	type PromptEvidence,
} from "../inference/tasks.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueAssess } from "../queue.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { ContextError, extractSearchTerms } from "./context.ts";
import { type SnapshotRow, toSnapshotView } from "./graph.ts";
import type { GraphCoverage, RepositoryProfile } from "./graph-build.ts";
import {
	grepSnapshot,
	IMPACT_EDGES,
	impactFrom,
	readSnapshotExcerpt,
	SYMBOL_KINDS,
	snapshotFor,
	snapshotFreshness,
} from "./graph-queries.ts";
import { workspaceGateway } from "./normalization.ts";
import { getRepositoryRow } from "./repositories.ts";

// Feasibility assessments and engineering questions. Evidence is gathered
// deterministically from a stored snapshot; the model only interprets it; citations are checked,
// and the final status, confidence, and size class are set by rules in this file.

type NodeRow = typeof graphNodes.$inferSelect;
type AssessmentRow = typeof assessments.$inferSelect;

const MAX_CANDIDATES = 8;
const MAX_SYMBOL_TERMS = 12;
const MAX_GREP_TERMS = 6;
const MAX_FILES_PER_TERM = 10;

// ---- Rules (pure; table-tested) ---------------------------------------------------------------

export type PackRanges = ReadonlyMap<
	string,
	{ start: number; end: number } | null
>;

/** A citation counts only if its handle is in the pack and, for an excerpt, its lines are inside it. */
export function citationValid(citation: Citation, pack: PackRanges): boolean {
	if (!pack.has(citation.handle)) return false;
	const range = pack.get(citation.handle);
	if (!range || citation.start_line === null || citation.end_line === null)
		return true;
	return (
		citation.start_line <= citation.end_line &&
		citation.start_line >= range.start &&
		citation.end_line <= range.end
	);
}

/** Shared confidence rules: invalid citations lower it; partial or stale evidence caps it. */
function settleConfidence(
	confidence: Confidence,
	input: {
		invalidCitations: number;
		totalCitations: number;
		coverageComplete: boolean;
		stale: boolean | null;
	},
	downgrades: string[],
): Confidence {
	if (
		input.invalidCitations > 0 &&
		input.invalidCitations * 2 >= input.totalCitations &&
		confidence !== "low"
	) {
		downgrades.push("many_invalid_citations");
		return "low";
	}
	let settled = confidence;
	const cap = (reason: string) => {
		if (settled !== "high") return;
		settled = "medium";
		downgrades.push(reason);
	};
	if (!input.coverageComplete) cap("partial_graph_coverage");
	if (input.stale === true) cap("stale_snapshot");
	else if (input.stale === null) cap("freshness_unknown");
	return settled;
}

/** Downgrades the model's status and confidence when the evidence does not carry them. */
export function settleAssessment(input: {
	status: AssessmentStatus;
	confidence: Confidence;
	validComponents: number;
	validRiskCitations: number;
	invalidCitations: number;
	totalCitations: number;
	coverageComplete: boolean;
	stale: boolean | null;
}): { status: AssessmentStatus; confidence: Confidence; downgrades: string[] } {
	const downgrades: string[] = [];
	let status = input.status;
	if (
		(status === "SUPPORTED" || status === "SUPPORTED_WITH_CHANGES") &&
		input.validComponents === 0
	) {
		status = "INSUFFICIENT_EVIDENCE";
		downgrades.push("no_cited_components");
	}
	if (
		status === "BLOCKED" &&
		input.validComponents + input.validRiskCitations === 0
	) {
		status = "INSUFFICIENT_EVIDENCE";
		downgrades.push("blocker_not_evidenced");
	}
	const confidence = settleConfidence(input.confidence, input, downgrades);
	return { status, confidence, downgrades };
}

/** An answer's status and confidence from what its validated citations actually support. */
export function settleAnswer(input: {
	status: AnswerStatus;
	confidence: Confidence;
	supportedClaims: number;
	unsupportedClaims: number;
	invalidCitations: number;
	totalCitations: number;
	coverageComplete: boolean;
	stale: boolean | null;
}): { status: AnswerStatus; confidence: Confidence; downgrades: string[] } {
	const downgrades: string[] = [];
	let status = input.status;
	if (status !== "INSUFFICIENT_EVIDENCE" && input.supportedClaims === 0) {
		status = "INSUFFICIENT_EVIDENCE";
		downgrades.push("no_supported_claims");
	} else if (status === "ANSWERED" && input.unsupportedClaims > 0) {
		status = "PARTIALLY_ANSWERED";
		downgrades.push("unsupported_claims");
	}
	const confidence = settleConfidence(input.confidence, input, downgrades);
	return { status, confidence, downgrades };
}

/** Transparent size class from cited files, graph-supported dependents, and what must be added. */
export function classifyChangeSize(input: {
	status: AssessmentStatus;
	likelyFiles: readonly string[];
	dependents: number;
	tests: number;
	missingKinds: readonly string[];
	coverageComplete: boolean;
	impactTruncated: boolean;
}): { size: ChangeSize; reasons: string[] } {
	if (input.status === "INSUFFICIENT_EVIDENCE")
		return {
			size: "UNKNOWN",
			reasons: ["The evidence was insufficient to locate the change."],
		};
	if (input.likelyFiles.length === 0)
		return {
			size: "UNKNOWN",
			reasons: ["No existing code was cited as the place to change."],
		};
	const heavy = input.missingKinds.filter(
		(kind) =>
			kind === "data_model" ||
			kind === "infrastructure" ||
			kind === "dependency",
	).length;
	const reasons = [
		`${input.likelyFiles.length} existing file(s) cited as touched`,
		`${input.dependents} graph-supported dependent(s) of the cited code and ${input.tests} linked test(s)`,
		`${input.missingKinds.length} missing piece(s) to add, ${heavy} of them a data model, infrastructure, or dependency`,
	];
	const size: ChangeSize =
		input.likelyFiles.length <= 2 &&
		input.dependents <= 5 &&
		heavy === 0 &&
		input.missingKinds.length <= 2
			? "SMALL"
			: input.likelyFiles.length <= 6 && input.dependents <= 25 && heavy <= 1
				? "MEDIUM"
				: "LARGE";
	if (!input.coverageComplete || input.impactTruncated)
		reasons.push(
			"The dependent count may be low: graph coverage is partial or the walk hit its limit.",
		);
	return { size, reasons };
}

/** Files grouped by the package whose manifest directory most closely encloses them. */
export function packagesOf(
	files: readonly string[],
	packages: ReadonlyArray<{ path: string; name: string | null }>,
): Array<{ path: string; name: string | null; files: number }> {
	const owners = packages
		.map((pkg) => ({ ...pkg, dir: path.posix.dirname(pkg.path) }))
		.sort((a, b) => b.dir.length - a.dir.length);
	const counts = new Map<
		string,
		{ path: string; name: string | null; files: number }
	>();
	for (const file of new Set(files)) {
		const owner = owners.find(
			(pkg) => pkg.dir === "." || file.startsWith(`${pkg.dir}/`),
		);
		if (!owner) continue;
		const entry = counts.get(owner.path) ?? {
			path: owner.path,
			name: owner.name,
			files: 0,
		};
		entry.files += 1;
		counts.set(owner.path, entry);
	}
	return [...counts.values()].sort(
		(a, b) => b.files - a.files || a.path.localeCompare(b.path),
	);
}

// ---- Evidence gathering -----------------------------------------------------------------------

type Gathered = {
	prompt: PromptEvidence[];
	refs: Map<string, EvidenceRef>;
	ranges: Map<string, { start: number; end: number } | null>;
	keysByHandle: Map<string, string>;
	candidates: Array<{
		key: string;
		path: string | null;
		score: number;
		reasons: string[];
	}>;
	limitations: string[];
};

const numbered = (text: string, start: number) =>
	text
		.split("\n")
		.map(
			(line, i) =>
				`${String(start + i).padStart(4)}| ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`,
		)
		.join("\n");

function profileFacts(
	profile: RepositoryProfile | null,
	coverage: GraphCoverage | null,
): Array<[string, string]> {
	if (!profile) return [];
	const facts: Array<[string, string]> = [
		[
			"Repository size and languages",
			`Tracked files: ${profile.tracked_files}; indexed: ${profile.indexed_files}; directories: ${profile.directories}; files by language: ${JSON.stringify(profile.files_by_language)}; symbols by kind: ${JSON.stringify(profile.symbols)}`,
		],
		[
			"Packages and declared frameworks",
			[
				...profile.packages.map(
					(pkg) =>
						`${pkg.path}: ${pkg.name ?? "(unnamed)"}, ${pkg.dependencies} dependencies, ${pkg.dev_dependencies} dev dependencies, scripts: ${pkg.scripts.join(", ") || "none"}`,
				),
				`Declared frameworks and libraries: ${profile.frameworks.map((f) => f.name).join(", ") || "none detected"}`,
			].join("\n"),
		],
		[
			"Tests and commands",
			`Test files: ${profile.test_files}; test cases: ${profile.test_cases}\nTest commands: ${profile.test_commands.join("; ") || "none"}\nBuild commands: ${profile.build_commands.join("; ") || "none"}\nEntry points: ${profile.entry_points.join(", ") || "none detected"}`,
		],
	];
	if (coverage)
		facts.push([
			"Index coverage",
			`Complete: ${coverage.complete}; parsed files: ${coverage.parsed_files}; parse failures: ${coverage.parse_failures.length}; unparsed languages: ${JSON.stringify(coverage.unsupported_code_files)}; unresolved imports: ${coverage.unresolved.imports}; relationship kinds not extracted: ${coverage.unsupported_edge_kinds.join(", ")}\n${coverage.notes.join("\n")}`,
		]);
	return facts;
}

/**
 * Deterministic evidence for one request: index facts, the code it names or whose names and text
 * match its terms (`searchText`, the request by default), and those candidates' direct relationships.
 */
async function gatherEvidence(
	deps: { db: Db; config: Config },
	snapshot: SnapshotRow,
	request: string,
	targets: readonly string[],
	searchText = request,
): Promise<Gathered> {
	const limitations: string[] = [];
	const collected = (snapshot.finishedAt ?? snapshot.createdAt).toISOString();
	const base = {
		repository_id: snapshot.repositoryId,
		commit_sha: snapshot.commitSha,
		snapshot_id: snapshot.id,
		collected_at: collected,
		limitations: [] as string[],
	};
	const prompt: PromptEvidence[] = [];
	const refs = new Map<string, EvidenceRef>();
	const ranges = new Map<string, { start: number; end: number } | null>();
	const keysByHandle = new Map<string, string>();
	refs.set("REQ", {
		...base,
		type: "report_claim",
		classification: "reported",
		handle: "REQ",
		path: null,
		start_line: null,
		end_line: null,
		symbol: null,
		excerpt: request.slice(0, 500),
		method: "user_request",
		certainty: null,
	});
	ranges.set("REQ", null);

	profileFacts(
		snapshot.profile as RepositoryProfile | null,
		snapshot.coverage as GraphCoverage | null,
	).forEach(([label, content], i) => {
		const handle = `FACT-${i + 1}`;
		prompt.push({
			handle,
			kind: "repository_fact",
			label,
			content,
			locator: {},
		});
		refs.set(handle, {
			...base,
			type: "repository_fact",
			classification: "observed",
			handle,
			path: null,
			start_line: null,
			end_line: null,
			symbol: null,
			excerpt: content.slice(0, 500),
			method: "graph_index_profile",
			certainty: "exact",
		});
		ranges.set(handle, null);
	});

	// Candidate code: named areas first, then symbol-name and text matches of the request's terms.
	const scored = new Map<
		string,
		{ node: NodeRow; score: number; reasons: Set<string>; lines: number[] }
	>();
	const bump = (
		node: NodeRow,
		score: number,
		reason: string,
		line?: number,
	) => {
		const entry = scored.get(node.key) ?? {
			node,
			score: 0,
			reasons: new Set<string>(),
			lines: [],
		};
		entry.score += score;
		entry.reasons.add(reason);
		if (line !== undefined) entry.lines.push(line);
		scored.set(node.key, entry);
	};
	const inSnapshot = eq(graphNodes.snapshotId, snapshot.id);
	for (const target of targets) {
		const rows = await deps.db
			.select()
			.from(graphNodes)
			.where(
				and(
					inSnapshot,
					or(
						and(
							inArray(graphNodes.kind, ["file", "test_file"]),
							eq(graphNodes.path, target),
						),
						and(
							inArray(graphNodes.kind, [...SYMBOL_KINDS]),
							eq(graphNodes.name, target),
						),
					),
				),
			)
			.limit(5);
		if (rows.length === 0)
			limitations.push(
				`The requested area "${target.slice(0, 100)}" was not found in the snapshot.`,
			);
		for (const row of rows) bump(row, 10, "named by the requester");
	}
	const firstLine = searchText.split("\n")[0]?.slice(0, 200) ?? "";
	const terms = extractSearchTerms(
		{
			title: firstLine,
			description: searchText,
			expectedBehavior: null,
			actualBehavior: null,
			steps: [],
		},
		null,
	);
	for (const term of terms
		.filter((t) => t.term.length >= 4)
		.slice(0, MAX_SYMBOL_TERMS)) {
		const rows = await deps.db
			.select()
			.from(graphNodes)
			.where(
				and(
					inSnapshot,
					inArray(graphNodes.kind, [...SYMBOL_KINDS]),
					ilike(
						graphNodes.name,
						`%${term.term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
					),
				),
			)
			.orderBy(asc(graphNodes.path))
			.limit(20);
		for (const row of rows)
			bump(
				row,
				(row.name.toLowerCase() === term.term.toLowerCase() ? 4 : 2) +
					term.weight -
					1,
				`name matches "${term.term}"`,
			);
	}
	for (const term of terms.slice(0, MAX_GREP_TERMS)) {
		const { hits, limitations: grepLimits } = await grepSnapshot(
			deps,
			snapshot,
			term.term,
			5000,
		);
		limitations.push(...grepLimits);
		const byFile = new Map<string, number[]>();
		for (const hit of hits) {
			const lines = byFile.get(hit.path) ?? [];
			lines.push(hit.line);
			byFile.set(hit.path, lines);
		}
		const files = [...byFile.keys()].slice(0, MAX_FILES_PER_TERM);
		if (files.length === 0) continue;
		const nodes = await deps.db
			.select()
			.from(graphNodes)
			.where(
				and(
					inSnapshot,
					inArray(graphNodes.path, files),
					inArray(graphNodes.kind, ["file", "test_file", ...SYMBOL_KINDS]),
				),
			);
		const isSymbol = (node: NodeRow) =>
			(SYMBOL_KINDS as readonly string[]).includes(node.kind);
		const span = (node: NodeRow) => (node.endLine ?? 0) - (node.startLine ?? 0);
		for (const file of files) {
			const fileNode = nodes.find((n) => n.path === file && !isSymbol(n));
			for (const line of (byFile.get(file) ?? []).slice(0, 3)) {
				// Credit the innermost symbol around the hit; fall back to the file.
				const owner = nodes
					.filter(
						(n) =>
							n.path === file &&
							isSymbol(n) &&
							(n.startLine ?? Number.POSITIVE_INFINITY) <= line &&
							(n.endLine ?? 0) >= line,
					)
					.sort((a, b) => span(a) - span(b))[0];
				const target = owner ?? fileNode;
				if (target) bump(target, term.weight, `text "${term.term}"`, line);
			}
		}
	}
	const candidates = [...scored.values()]
		.sort(
			(a, b) =>
				b.score - a.score ||
				(a.node.path ?? "").localeCompare(b.node.path ?? ""),
		)
		.slice(0, MAX_CANDIDATES);
	if (candidates.length === 0)
		limitations.push(
			"No code in the snapshot matched the request's terms or named areas.",
		);

	let codeIndex = 0;
	for (const candidate of candidates) {
		const node = candidate.node;
		if (!node.path) continue;
		const [start, end] =
			node.startLine !== null && node.endLine !== null
				? [node.startLine - 2, node.endLine + 2]
				: candidate.lines.length > 0
					? [
							Math.min(...candidate.lines) - 10,
							Math.max(...candidate.lines) + 10,
						]
					: [1, 60];
		const read = await readSnapshotExcerpt(
			deps.config,
			snapshot,
			node.path,
			Math.max(1, start),
			end,
		);
		if (read.excerpt === null) {
			if (read.limitation) limitations.push(`${node.path}: ${read.limitation}`);
			continue;
		}
		codeIndex += 1;
		const handle = `CODE-${codeIndex}`;
		prompt.push({
			handle,
			kind: "code_excerpt",
			label: `${node.kind} ${node.name} (${[...candidate.reasons].slice(0, 3).join("; ")})`,
			content: numbered(read.excerpt, read.start_line),
			locator: {
				path: node.path,
				start_line: read.start_line,
				end_line: read.end_line,
				line_count: read.line_count,
			},
		});
		refs.set(handle, {
			...base,
			type: "code_excerpt",
			classification: "observed",
			handle,
			path: node.path,
			start_line: read.start_line,
			end_line: read.end_line,
			symbol: (SYMBOL_KINDS as readonly string[]).includes(node.kind)
				? node.name
				: null,
			excerpt: read.excerpt,
			method: "git_cat_file",
			certainty: "exact",
			limitations: read.limitation ? [read.limitation] : [],
		});
		ranges.set(handle, { start: read.start_line, end: read.end_line });
		keysByHandle.set(handle, node.key);
	}

	// Direct graph relationships of the candidates, both directions.
	const keys = candidates.map((c) => c.node.key);
	if (keys.length > 0) {
		const edges = await deps.db
			.select()
			.from(graphEdges)
			.where(
				and(
					eq(graphEdges.snapshotId, snapshot.id),
					or(
						inArray(graphEdges.toKey, keys),
						inArray(graphEdges.fromKey, keys),
					),
					inArray(graphEdges.kind, [...IMPACT_EDGES]),
					inArray(graphEdges.certainty, ["exact", "resolved"]),
				),
			)
			.limit(400);
		let graphIndex = 0;
		for (const key of keys) {
			const incoming = edges.filter((e) => e.toKey === key).slice(0, 25);
			const outgoing = edges
				.filter((e) => e.fromKey === key && e.toKey)
				.slice(0, 25);
			if (incoming.length + outgoing.length === 0) continue;
			graphIndex += 1;
			const handle = `GRAPH-${graphIndex}`;
			const content = [
				...incoming.map((e) => `${e.fromKey} ${e.kind} ${key}`),
				...outgoing.map((e) => `${key} ${e.kind} ${e.toKey}`),
			].join("\n");
			prompt.push({
				handle,
				kind: "graph_relationships",
				label: `Static relationships of ${key}`,
				content,
				locator: {},
			});
			refs.set(handle, {
				...base,
				type: "graph_edge",
				classification: "observed",
				handle,
				path: null,
				start_line: null,
				end_line: null,
				symbol: key,
				excerpt: content.slice(0, 500),
				method: "graph_query",
				certainty: "resolved",
			});
			ranges.set(handle, null);
			keysByHandle.set(handle, key);
		}
	}
	return {
		prompt,
		refs,
		ranges,
		keysByHandle,
		candidates: candidates.map((c) => ({
			key: c.node.key,
			path: c.node.path,
			score: c.score,
			reasons: [...c.reasons],
		})),
		limitations,
	};
}

// ---- API and job ------------------------------------------------------------------------------

function toAssessmentView(row: AssessmentRow) {
	return {
		id: row.id,
		kind: row.kind,
		repository_id: row.repositoryId,
		snapshot_id: row.snapshotId,
		commit_sha: row.commitSha,
		follow_up_of: row.parentId,
		request: row.request,
		targets: row.targets,
		status: row.status,
		result: row.result ?? null,
		error: row.error ?? null,
		created_at: row.createdAt.toISOString(),
		finished_at: row.finishedAt?.toISOString() ?? null,
	};
}

type CreateDeps = { db: Db; pool: pg.Pool; boss: PgBoss };

async function createAnalysis(
	deps: CreateDeps,
	ctx: AuthContext,
	repositoryId: string,
	input: {
		kind: AssessmentRow["kind"];
		request: string;
		targets: string[];
		snapshotId: string | undefined;
		parentId: string | null;
	},
	requestId: string,
) {
	const snapshot = await snapshotFor(
		deps.db,
		ctx.workspaceId,
		repositoryId,
		input.snapshotId,
	);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const id = newId("asm");
		await db.insert(assessments).values({
			id,
			workspaceId: ctx.workspaceId,
			repositoryId,
			snapshotId: snapshot.id,
			kind: input.kind,
			parentId: input.parentId,
			commitSha: snapshot.commitSha,
			request: input.request,
			targets: input.targets,
			status: "queued",
			createdBy: ctx.userId,
		});
		await enqueueAssess(deps.boss, queueDb, { assessmentId: id });
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action:
				input.kind === "question" ? "question.asked" : "assessment.created",
			targetType: "assessment",
			targetId: id,
			metadata: {
				repository_id: repositoryId,
				snapshot_id: snapshot.id,
				...(input.parentId ? { follow_up_of: input.parentId } : {}),
			},
			requestId,
		});
		const [row] = await db
			.select()
			.from(assessments)
			.where(eq(assessments.id, id))
			.limit(1);
		if (!row) throw new Error("assessment vanished during creation");
		return toAssessmentView(row);
	});
}

export function createAssessment(
	deps: CreateDeps,
	ctx: AuthContext,
	repositoryId: string,
	input: CreateAssessmentRequest,
	requestId: string,
) {
	return createAnalysis(
		deps,
		ctx,
		repositoryId,
		{
			kind: "feasibility",
			request: input.request,
			targets: input.targets ?? [],
			snapshotId: input.snapshot_id,
			parentId: null,
		},
		requestId,
	);
}

/**
 * Queues a cited answer to an engineering question. A follow-up continues a completed question about
 * the same repository: the earlier question, answer, and cited files become context for this one.
 */
export async function askQuestion(
	deps: CreateDeps,
	ctx: AuthContext,
	repositoryId: string,
	input: AskQuestionRequest,
	requestId: string,
) {
	if (input.follow_up_of) {
		await getRepositoryRow(deps.db, ctx.workspaceId, repositoryId);
		const [parent] = await deps.db
			.select({
				kind: assessments.kind,
				repositoryId: assessments.repositoryId,
				status: assessments.status,
			})
			.from(assessments)
			.where(
				and(
					eq(assessments.id, input.follow_up_of),
					eq(assessments.workspaceId, ctx.workspaceId),
				),
			)
			.limit(1);
		if (!parent)
			throw new AppError(
				404,
				"not_found",
				`Assessment ${input.follow_up_of} was not found`,
			);
		if (parent.kind !== "question" || parent.repositoryId !== repositoryId)
			throw new AppError(
				422,
				"invalid_follow_up",
				"A follow-up must continue a question about the same repository",
			);
		if (parent.status !== "completed")
			throw new AppError(
				409,
				"invalid_state",
				`Question ${input.follow_up_of} is ${parent.status}; only a completed question can be followed up`,
			);
	}
	return createAnalysis(
		deps,
		ctx,
		repositoryId,
		{
			kind: "question",
			request: input.question,
			targets: input.targets ?? [],
			snapshotId: input.snapshot_id,
			parentId: input.follow_up_of ?? null,
		},
		requestId,
	);
}

export async function getAssessment(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(assessments)
		.where(
			and(eq(assessments.id, id), eq(assessments.workspaceId, workspaceId)),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Assessment ${id} was not found`);
	return toAssessmentView(row);
}

/** Worker-loss recovery: queued or running assessments whose queue job is gone are marked failed. */
export async function recoverLostAssessments(db: Db): Promise<number> {
	const result = await db.execute<{ id: string; workspace_id: string }>(sql`
		UPDATE ${assessments} a
		   SET status = 'failed',
		       error = jsonb_build_object('code', 'job_lost',
		         'message', 'The assessment job was lost (worker crash or queue expiry); create it again'),
		       finished_at = now(), updated_at = now()
		 WHERE a.status IN ('queued', 'running')
		   AND a.updated_at < now() - interval '2 minutes'
		   AND NOT EXISTS (
		     SELECT 1 FROM pgboss.job j
		      WHERE j.name = 'repository.assess' AND j.data->>'assessmentId' = a.id
		        AND j.state IN ('created', 'retry', 'active'))
		RETURNING a.id, a.workspace_id`);
	for (const row of result.rows)
		await audit(db, {
			workspaceId: row.workspace_id,
			actor: WORKER_ACTOR,
			action: "assessment.recovered",
			targetType: "assessment",
			targetId: row.id,
			metadata: { code: "job_lost" },
		});
	return result.rows.length;
}

const PRELIMINARY =
	"Preliminary estimate from static evidence: not a guaranteed effort and not an exhaustive impact analysis. Nothing was built, run, or tested.";
const STATIC_ANSWER =
	"Answered from static evidence at one snapshot: nothing was built, run, or tested, and runtime behavior was not observed. The summary is the model's wording; rely on the cited claims.";

type JobDeps = {
	db: Db;
	config: Config;
	provider: ChatProvider;
	log?: (message: string, fields: Record<string, unknown>) => void;
};
type Quality = { coverageComplete: boolean; stale: boolean | null };
type Outcome = {
	result: Record<string, unknown>;
	metadata: Record<string, unknown>;
};

/**
 * Checks citations against the pack, counting them, and turns valid ones into evidence references
 * (an excerpt narrowed to the cited lines). `citable` excludes handles that cannot support a claim.
 */
function citationChecker(
	gathered: Pick<Gathered, "refs" | "ranges">,
	citable: (handle: string) => boolean = () => true,
) {
	let total = 0;
	let invalid = 0;
	const valid = (citation: Citation) => {
		total += 1;
		const ok =
			citable(citation.handle) && citationValid(citation, gathered.ranges);
		if (!ok) invalid += 1;
		return ok;
	};
	const refOf = (citation: Citation): EvidenceRef[] => {
		const ref = gathered.refs.get(citation.handle);
		if (!ref) return [];
		if (
			ref.type !== "code_excerpt" ||
			citation.start_line === null ||
			citation.end_line === null ||
			ref.start_line === null
		)
			return [ref];
		const lines = (ref.excerpt ?? "").split("\n");
		return [
			{
				...ref,
				start_line: citation.start_line,
				end_line: citation.end_line,
				excerpt: lines
					.slice(
						citation.start_line - ref.start_line,
						citation.end_line - ref.start_line + 1,
					)
					.join("\n"),
			},
		];
	};
	return { valid, refOf, counts: () => ({ total, invalid }) };
}

/** Files that a completed answer's supported claims cited (carried into a follow-up's evidence). */
function citedFiles(result: Record<string, unknown> | null): string[] {
	const files = new Set<string>();
	const claims = result?.claims;
	for (const claim of Array.isArray(claims) ? claims : []) {
		const { supported, evidence } = claim as {
			supported?: unknown;
			evidence?: unknown;
		};
		if (supported !== true || !Array.isArray(evidence)) continue;
		for (const ref of evidence as Array<{ path?: unknown }>)
			if (typeof ref.path === "string") files.add(ref.path);
	}
	return [...files].slice(0, 8);
}

/**
 * The `repository.assess` job, for feasibility assessments and questions alike. Finished ones are
 * ignored (idempotent redelivery).
 */
export async function runAssessJob(
	deps: JobDeps,
	assessmentId: string,
): Promise<void> {
	const [row] = await deps.db
		.select()
		.from(assessments)
		.where(eq(assessments.id, assessmentId))
		.limit(1);
	if (!row || (row.status !== "queued" && row.status !== "running")) return;
	await deps.db
		.update(assessments)
		.set({ status: "running", updatedAt: new Date() })
		.where(eq(assessments.id, row.id));
	let partial: Record<string, unknown> | null = null;
	try {
		const [snapshot] = row.snapshotId
			? await deps.db
					.select()
					.from(repositorySnapshots)
					.where(eq(repositorySnapshots.id, row.snapshotId))
					.limit(1)
			: [];
		if (
			!snapshot ||
			(snapshot.status !== "ready" && snapshot.status !== "partial")
		)
			throw new ContextError(
				"graph_not_indexed",
				"The assessment's snapshot is no longer available",
			);
		const [repo] = await deps.db
			.select()
			.from(repositories)
			.where(eq(repositories.id, row.repositoryId))
			.limit(1);
		if (!repo) return;
		const freshness = await snapshotFreshness(deps.config, repo, snapshot);
		const coverageComplete = snapshot.coverage?.complete === true;
		const question = row.kind === "question";
		const [parent] =
			question && row.parentId
				? await deps.db
						.select()
						.from(assessments)
						.where(
							and(
								eq(assessments.id, row.parentId),
								eq(assessments.workspaceId, row.workspaceId),
							),
						)
						.limit(1)
				: [];
		// A follow-up searches with its parent's words too and keeps the files its answer cited.
		const gathered = await gatherEvidence(
			deps,
			snapshot,
			row.request,
			[...new Set([...row.targets, ...citedFiles(parent?.result ?? null)])],
			parent ? `${parent.request}\n${row.request}` : row.request,
		);
		const inferenceMode =
			deps.config.inference.provider === "mock" ? "mock" : "live";
		const limitations = [
			question ? STATIC_ANSWER : PRELIMINARY,
			...gathered.limitations,
		];
		if (freshness.stale === true)
			limitations.push(
				`The snapshot is stale (${freshness.reasons.join(", ")}); the code may have changed since it was indexed.`,
			);
		if (!coverageComplete)
			limitations.push("The snapshot's graph coverage is partial.");
		// Roles served here: snapshot and search, then model + rules.
		const specialists: SpecialistRole[] = question
			? ["repository_mapping", "code_exploration"]
			: [
					"repository_mapping",
					"code_exploration",
					"feasibility_planning",
					"impact_analysis",
				];
		partial = {
			inference_mode: inferenceMode,
			specialists,
			evidence: [...gathered.refs.values()],
			candidates: gathered.candidates,
			snapshot: { ...toSnapshotView(snapshot), freshness },
			limitations,
		};
		const quality = { coverageComplete, stale: freshness.stale };
		const { result, metadata } = question
			? await answerQuestion(
					deps,
					row,
					parent ?? null,
					gathered,
					partial,
					quality,
				)
			: await assessFeasibility(
					deps,
					row,
					snapshot,
					gathered,
					partial,
					quality,
				);
		await deps.db
			.update(assessments)
			.set({
				status: "completed",
				result,
				error: null,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(assessments.id, row.id));
		await audit(deps.db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: question ? "question.answered" : "assessment.completed",
			targetType: "assessment",
			targetId: row.id,
			metadata: { ...metadata, inference_mode: inferenceMode },
		});
	} catch (error) {
		const failure =
			error instanceof InferenceError ||
			error instanceof ContextError ||
			error instanceof AppError
				? { code: error.code, message: error.message }
				: {
						code: "assessment_failed",
						message: "The assessment failed unexpectedly",
					};
		await deps.db
			.update(assessments)
			.set({
				status: "failed",
				error: failure,
				result: partial,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(assessments.id, row.id));
		deps.log?.("assessment failed", {
			assessment_id: row.id,
			code: failure.code,
			...(failure.code === "assessment_failed"
				? { error: (error as Error).message }
				: {}),
		});
	}
}

async function assessFeasibility(
	deps: JobDeps,
	row: AssessmentRow,
	snapshot: SnapshotRow,
	gathered: Gathered,
	partial: Record<string, unknown>,
	quality: Quality,
): Promise<Outcome> {
	const gateway = workspaceGateway(
		deps,
		{ workspaceId: row.workspaceId, assessmentId: row.id },
		{ model: deps.config.inference.taskModels.assess_feasibility },
	);
	const { output, modelExecutionId } = await gateway.run(
		assessFeasibilityTask,
		{
			user: buildAssessmentInput({
				request: row.request,
				targets: row.targets,
				evidence: gathered.prompt,
			}),
		},
	);
	const check = citationChecker(gathered);
	const components = output.relevant_components
		.filter((item) => check.valid(item.citation))
		.map((item) => ({
			role: item.role,
			basis: "inferred",
			evidence: check.refOf(item.citation),
		}));
	const reusable = output.reusable_capabilities
		.filter((item) => check.valid(item.citation))
		.map((item) => ({
			description: item.description,
			basis: "inferred",
			evidence: check.refOf(item.citation),
		}));
	const risks = output.risks.map((risk) => {
		const evidence = risk.citations.filter(check.valid).flatMap(check.refOf);
		return {
			category: risk.category,
			description: risk.description,
			basis: "inferred",
			evidence,
			supported: evidence.length > 0,
		};
	});
	const { total, invalid } = check.counts();
	const settled = settleAssessment({
		status: output.status,
		confidence: output.confidence,
		validComponents: components.length,
		validRiskCitations: risks.reduce(
			(sum, risk) => sum + risk.evidence.length,
			0,
		),
		invalidCitations: invalid,
		totalCitations: total,
		...quality,
	});

	const citedKeys = [
		...new Set(
			output.relevant_components
				.filter((item) => citationValid(item.citation, gathered.ranges))
				.flatMap(
					(item) => gathered.keysByHandle.get(item.citation.handle) ?? [],
				),
		),
	];
	const impact =
		citedKeys.length > 0
			? await impactFrom(deps.db, snapshot, citedKeys, {
					depth: 3,
					limit: 100,
				})
			: null;
	const likelyFiles = [
		...new Set(
			components.flatMap((c) =>
				c.evidence.flatMap((e) => (e.path ? [e.path] : [])),
			),
		),
	].sort();
	const dependents =
		impact?.affected.filter(
			(a) => a.node.kind !== "test_case" && a.node.kind !== "test_file",
		).length ?? 0;
	const size = classifyChangeSize({
		status: settled.status,
		likelyFiles,
		dependents,
		tests: impact?.tests.length ?? 0,
		missingKinds: output.missing.map((item) => item.kind),
		coverageComplete: quality.coverageComplete,
		impactTruncated: impact?.truncated ?? false,
	});
	const result = {
		...partial,
		status: settled.status,
		model_status: output.status,
		downgrades: settled.downgrades,
		understanding: output.understanding,
		status_rationale: output.status_rationale,
		confidence: settled.confidence,
		model_confidence: output.confidence,
		confidence_rationale: output.confidence_rationale,
		relevant_components: components,
		reusable_capabilities: reusable,
		missing: output.missing.map((item) => ({ ...item, basis: "inferred" })),
		external_assumptions: output.external_assumptions,
		unknowns: output.unknowns,
		next_steps: output.next_steps,
		risks,
		change_size: {
			class: size.size,
			reasons: size.reasons,
			likely_files: likelyFiles,
			dependents,
			tests: impact?.tests.length ?? 0,
		},
		impact: {
			graph_supported: impact
				? {
						files: impact.files,
						affected: impact.affected.map((a) => ({
							key: a.node.key,
							kind: a.node.kind,
							name: a.node.name,
							path: a.node.path,
							distance: a.distance,
							via: a.via,
							certainty: a.certainty,
						})),
						tests: impact.tests.map((t) => ({
							key: t.node.key,
							name: t.node.name,
							path: t.node.path,
						})),
						truncated: impact.truncated,
						limitations: impact.limitations,
					}
				: null,
			// The packages owning the cited files and their graph-supported dependents.
			packages: packagesOf(
				[...likelyFiles, ...(impact?.files ?? [])],
				(snapshot.profile as RepositoryProfile | null)?.packages ?? [],
			),
			inferred: output.missing.map((item) => ({
				kind: item.kind,
				description: item.description,
				basis: "inferred",
			})),
		},
		citations: { total, invalid },
		model: {
			provider: gateway.providerName,
			model: gateway.model,
			model_execution_id: modelExecutionId,
			prompt_version: assessFeasibilityTask.promptVersion,
		},
	};
	return {
		result,
		metadata: {
			status: settled.status,
			change_size: size.size,
			invalid_citations: invalid,
			model: gateway.model,
		},
	};
}

async function answerQuestion(
	deps: JobDeps,
	row: AssessmentRow,
	parent: AssessmentRow | null,
	gathered: Gathered,
	partial: Record<string, unknown>,
	quality: Quality,
): Promise<Outcome> {
	const gateway = workspaceGateway(
		deps,
		{ workspaceId: row.workspaceId, assessmentId: row.id },
		{ model: deps.config.inference.taskModels.answer_question },
	);
	const prior = (parent?.result?.summary ?? null) as { text?: unknown } | null;
	const { output, modelExecutionId } = await gateway.run(answerQuestionTask, {
		user: buildQuestionInput({
			question: row.request,
			targets: row.targets,
			prior: parent
				? {
						question: parent.request,
						answer: typeof prior?.text === "string" ? prior.text : "",
						commit_sha: parent.commitSha,
					}
				: null,
			evidence: gathered.prompt,
		}),
	});
	// The question itself is not evidence about the code.
	const check = citationChecker(gathered, (handle) => handle !== "REQ");
	const claims = output.claims.map((claim) => {
		const evidence = claim.citations.filter(check.valid).flatMap(check.refOf);
		return {
			statement: claim.statement,
			basis: "inferred",
			supported: evidence.length > 0,
			evidence,
		};
	});
	const { total, invalid } = check.counts();
	const supported = claims.filter((claim) => claim.supported).length;
	const settled = settleAnswer({
		status: output.status,
		confidence: output.confidence,
		supportedClaims: supported,
		unsupportedClaims: claims.length - supported,
		invalidCitations: invalid,
		totalCitations: total,
		...quality,
	});
	return {
		result: {
			...partial,
			status: settled.status,
			model_status: output.status,
			downgrades: settled.downgrades,
			summary: { text: output.answer, basis: "inferred" },
			claims,
			unknowns: output.unknowns,
			follow_up_questions: output.follow_up_questions,
			confidence: settled.confidence,
			model_confidence: output.confidence,
			confidence_rationale: output.confidence_rationale,
			citations: { total, invalid },
			model: {
				provider: gateway.providerName,
				model: gateway.model,
				model_execution_id: modelExecutionId,
				prompt_version: answerQuestionTask.promptVersion,
			},
		},
		metadata: {
			status: settled.status,
			invalid_citations: invalid,
			model: gateway.model,
		},
	};
}
