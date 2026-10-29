import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApi, loadConfig, VERSION } from "./api.ts";
import { buildServer } from "./server.ts";

// The local stdio entry: a coding agent spawns `node apps/mcp/src/index.ts`
// with TRACERA_API_URL and TRACERA_TOKEN in its environment. stdout carries the protocol (both the
// legacy and newer protocol revisions, chosen by the client's opening); logs go to stderr only.
const config = loadConfig(process.env);
serveStdio(() => buildServer(createApi(config)), {
	onerror: (error) => console.error(`tracera-mcp: ${error.message}`),
});
console.error(
	`tracera-mcp ${VERSION} on stdio for ${config.problem ? "an invalid TRACERA_API_URL" : config.baseUrl}${config.token ? "" : " (TRACERA_TOKEN is not set)"}`,
);
