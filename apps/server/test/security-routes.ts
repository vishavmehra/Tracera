import { type IdPrefix, type Scope, ScopeSchema } from "@tracera/contracts";
import type { FastifyInstance } from "fastify";
import { newId } from "../src/lib/ids.ts";

// The access rule of every registered route, shared by the security
// matrix and the workspace isolation tests. Both tests compare this table with the routes Fastify
// actually registered, so a new route fails them until its rule is written down here.

/**
 * `public`: no credentials. `login`: none, but the CSRF header and origin. `any`: any valid session
 * or token. `session`: a signed-in user, never a token. `owner`: an owner's session. A scope: a
 * session, or a token holding that scope.
 */
export type Access = "public" | "login" | "any" | "session" | "owner" | Scope;
export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type RouteRule = { method: Method; path: string; access: Access };

const rules = (access: Access, ...routes: `${Method} /${string}`[]) =>
	routes.map((route): RouteRule => {
		const [method, path] = route.split(" ") as [Method, string];
		return { method, path, access };
	});

export const ROUTE_RULES: RouteRule[] = [
	...rules("public", "GET /healthz", "GET /readyz"),
	...rules("login", "POST /api/v1/auth/login"),
	...rules("any", "GET /api/v1/auth/me"),
	...rules(
		"session",
		"POST /api/v1/auth/logout",
		"POST /api/v1/tokens",
		"GET /api/v1/tokens",
		"DELETE /api/v1/tokens/:id",
		"POST /api/v1/patches/:id/approval",
		"POST /api/v1/meetings",
		"PATCH /api/v1/meetings/:id",
		"DELETE /api/v1/meetings/:id",
		"POST /api/v1/meetings/:id/extract",
		"PATCH /api/v1/meetings/:id/candidates/:candidateId",
		"POST /api/v1/meetings/:id/candidates/:candidateId/confirm",
		"POST /api/v1/meetings/:id/candidates/:candidateId/dismiss",
		"GET /api/v1/integrations",
		"GET /api/v1/integrations/google/connect",
		"GET /api/v1/integrations/google/callback",
		"GET /api/v1/integrations/:id/meetings",
		"POST /api/v1/integrations/:id/import",
		"DELETE /api/v1/integrations/:id",
		"POST /api/v1/evidence/:id/locate",
	),
	...rules(
		"owner",
		"POST /api/v1/repositories",
		"PATCH /api/v1/repositories/:id",
		"DELETE /api/v1/repositories/:id",
		"POST /api/v1/patches/:id/actions",
	),
	...rules(
		"repositories:read",
		"GET /api/v1/repositories",
		"GET /api/v1/repositories/:id",
		"GET /api/v1/repositories/:id/snapshots",
		"GET /api/v1/repositories/:id/profile",
		"GET /api/v1/repositories/:id/graph/nodes",
		"GET /api/v1/repositories/:id/search",
		"POST /api/v1/repositories/:id/impact",
		"POST /api/v1/repositories/:id/stack-traces/map",
		"GET /api/v1/graph/nodes/:id",
		"GET /api/v1/graph/nodes/:id/trace",
		"GET /api/v1/graph/nodes/:id/history",
		"GET /api/v1/graph/nodes/:id/neighbors",
		"GET /api/v1/graph/nodes/:id/impact",
		"GET /api/v1/graph/snapshots/:id/edges/:edgeId",
		"GET /api/v1/repositories/:id/patch-impact",
		"GET /api/v1/patch-impact/:id",
		"GET /api/v1/patch-impact/:id/report",
		"GET /api/v1/repositories/:id/dependency-snapshots",
		"GET /api/v1/dependency-snapshots/:id",
	),
	...rules(
		"investigations:write",
		"POST /api/v1/repositories/:id/index",
		"POST /api/v1/snapshots/:id/cancel",
		"POST /api/v1/repositories/:id/assessments",
		"POST /api/v1/repositories/:id/questions",
		"POST /api/v1/repositories/:id/patch-impact",
		"POST /api/v1/patch-impact/:id/cancel",
		"POST /api/v1/repositories/:id/dependency-snapshots",
		"POST /api/v1/dependency-snapshots/:id/cancel",
		"POST /api/v1/investigations",
		"POST /api/v1/investigations/:id/cancel",
		"POST /api/v1/investigations/:id/retry",
	),
	...rules(
		"investigations:read",
		// Assessments are read with investigations:read, not repositories:read.
		"GET /api/v1/assessments/:id",
		"GET /api/v1/investigations",
		"GET /api/v1/investigations/:id",
		"GET /api/v1/investigations/:id/model-executions",
		"GET /api/v1/investigations/:id/findings",
		"GET /api/v1/investigations/:id/reproductions",
		"GET /api/v1/investigations/:id/patches",
		"GET /api/v1/investigations/:id/report",
		"GET /api/v1/patches/:id",
		"GET /api/v1/patches/:id/diff",
		"GET /api/v1/patches/:id/runtime-evidence",
		"GET /api/v1/verifications/:id",
		"GET /api/v1/verifications/:id/runtime-evidence",
		"GET /api/v1/repro-screenshots/:id",
		"GET /api/v1/patches/:id/actions",
		"GET /api/v1/actions/:id",
		"GET /api/v1/patches/:id/download",
	),
	...rules(
		"reports:write",
		"POST /api/v1/bug-reports",
		"POST /api/v1/bug-reports/:id/evidence",
		"POST /api/v1/evidence/:id/observations",
	),
	...rules(
		"reports:read",
		"GET /api/v1/bug-reports",
		"GET /api/v1/bug-reports/:id",
		"GET /api/v1/meetings",
		"GET /api/v1/meetings/:id",
		"GET /api/v1/meetings/:id/segments",
		"GET /api/v1/meetings/:id/candidates",
		"GET /api/v1/meetings/:id/summary",
		"GET /api/v1/evidence/:id/content",
		"GET /api/v1/evidence/:id/observations",
		"GET /api/v1/evidence/:id/locations",
	),
];

export const routeKey = (rule: { method: string; path: string }) =>
	`${rule.method} ${rule.path}`;

export const isScope = (access: Access): access is Scope =>
	ScopeSchema.safeParse(access).success;

export const isMutating = (rule: RouteRule) => rule.method !== "GET";

/**
 * The routes Fastify registered, as "METHOD /path" (the HEAD twins of GET routes are left out).
 * Read from `printRoutes`, whose tree prints each child's path relative to its parent.
 */
export function registeredRoutes(app: FastifyInstance): string[] {
	const stack: string[] = [];
	const routes: string[] = [];
	for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
		const match = /^((?:[│ ] {3})*)[├└]── (\S+)(?: \(([A-Z, ]+)\))?$/.exec(
			line,
		);
		if (!match) continue;
		stack.length = (match[1] ?? "").length / 4;
		stack.push(match[2] ?? "");
		for (const method of (match[3] ?? "").split(", "))
			if (method && method !== "HEAD")
				routes.push(`${method} ${stack.join("")}`);
	}
	return routes.sort();
}

/** The ID prefix of each collection a route addresses by `:id`. */
export const COLLECTION_PREFIX: Record<string, IdPrefix> = {
	repositories: "repo",
	snapshots: "snap",
	nodes: "gnd",
	assessments: "asm",
	"patch-impact": "pia",
	"dependency-snapshots": "dep",
	"bug-reports": "bug",
	investigations: "inv",
	patches: "pat",
	verifications: "ver",
	"repro-screenshots": "evd",
	tokens: "tok",
	meetings: "mtg",
	integrations: "int",
	actions: "act",
	evidence: "evd",
};

/** The collection segment before `:id`, or null for routes without one. */
export function collectionOf(path: string): string | null {
	const segments = path.split("/");
	const index = segments.indexOf(":id");
	return index > 0 ? (segments[index - 1] ?? null) : null;
}

/** Fills `:id`, `:edgeId` and `:candidateId` in a route path. */
export function fillPath(
	path: string,
	id: (collection: string) => string,
	edgeId = "1",
	candidateId = newId("cand"),
): string {
	const collection = collectionOf(path);
	return path
		.replace(":edgeId", edgeId)
		.replace(":candidateId", candidateId)
		.replace(":id", collection === null ? ":id" : id(collection));
}
