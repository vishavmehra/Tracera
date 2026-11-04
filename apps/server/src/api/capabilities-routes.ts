import type { FastifyInstance } from "fastify";
import { describeCapabilities } from "../modules/capabilities.ts";
import { type AppDeps, authOf } from "./app.ts";

/** What this server can do, for any signed-in session or token. The answer is the same for every workspace. */
export function registerCapabilitiesRoutes(
	app: FastifyInstance,
	deps: AppDeps,
) {
	const { db, config } = deps;

	app.get("/api/v1/capabilities", async (request) => {
		authOf(request);
		return describeCapabilities({ db, config });
	});
}
