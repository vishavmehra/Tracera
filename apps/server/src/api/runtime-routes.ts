import { type IdPrefix, idSchema } from "@tracera/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../lib/http.ts";
import { requireScope } from "../modules/auth.ts";
import {
	getRuntimeEvidence,
	getRuntimeScreenshot,
} from "../modules/runtime-evidence.ts";
import { type AppDeps, authOf } from "./app.ts";

/** A path parameter of the expected ID type; anything else is a 404, as for an unknown ID. */
function idParam(
	request: FastifyRequest,
	name: string,
	prefix: IdPrefix,
	label: string,
) {
	const id = (request.params as Record<string, string | undefined>)[name] ?? "";
	if (!idSchema(prefix).safeParse(id).success)
		throw new AppError(404, "not_found", `${label} ${id} was not found`);
	return id;
}

/** Runtime evidence of a patch: sandboxed browser runs before and after it, and their screenshots. */
export function registerRuntimeRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db, config } = deps;

	app.get("/api/v1/patches/:id/runtime-evidence", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return getRuntimeEvidence(db, config, auth.workspaceId, {
			patchId: idParam(request, "id", "pat", "Patch"),
		});
	});

	app.get("/api/v1/verifications/:id/runtime-evidence", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return getRuntimeEvidence(db, config, auth.workspaceId, {
			verificationId: idParam(request, "id", "ver", "Verification"),
		});
	});

	// Image bytes: always served as a PNG that cannot be sniffed into anything else or run as a page.
	app.get("/api/v1/repro-screenshots/:id", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		const id = idParam(request, "id", "evd", "Screenshot");
		const bytes = await getRuntimeScreenshot(db, config, auth.workspaceId, id);
		return reply
			.header("content-type", "image/png")
			.header("x-content-type-options", "nosniff")
			.header("content-security-policy", "default-src 'none'; sandbox")
			.header("cache-control", "private, max-age=300")
			.header("content-disposition", `inline; filename="${id}.png"`)
			.send(bytes);
	});
}
