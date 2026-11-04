import {
	CAPABILITY_IDS,
	type CapabilitiesResponse,
	type CapabilityId,
	type CapabilityStatus,
} from "@tracera/contracts";
import { desc, gt } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { workerHeartbeats } from "../db/schema.ts";

// What this server can really do. The listing comes from the configuration and from the sandbox
// state its worker reports (the API never calls Docker), not from a fixed claim, so a client can
// state the truth about the environment it talks to.

/** The parts of the configuration the listing depends on. */
export type CapabilityConfig = Pick<Config, "environment" | "sandboxMode"> & {
	inference: Pick<Config["inference"], "provider" | "providerName">;
	meetings: Pick<Config["meetings"], "google" | "googleMissing">;
};

/** The sandbox state in the newest worker report; null when no worker has reported recently. */
export type WorkerSandbox = {
	available: boolean;
	detail: string | null;
} | null;

/** A hosted server has no user working tree to change; the refusal and the listing say the same. */
export const HOSTED_ACTIONS =
	"Applying, committing, and pushing run in the local app, where Tracera can reach your working tree; download the patch to apply it yourself.";

type Verdict = readonly [status: CapabilityStatus, reason: string];

function sandboxVerdict(
	{ environment, sandboxMode }: CapabilityConfig,
	worker: WorkerSandbox,
): Verdict {
	const needs = "Reproduction and verification need the Docker sandbox";
	if (environment === "hosted")
		return ["unavailable", `${needs}, and this hosted environment has none.`];
	if (sandboxMode === "disabled")
		return [
			"needs_configuration",
			`${needs}; set TRACERA_SANDBOX_MODE=docker.`,
		];
	if (sandboxMode === "fake")
		return ["unavailable", `${needs}, but only a test double is configured.`];
	if (!worker)
		return [
			"needs_configuration",
			`${needs}, but no worker is reporting; start the worker.`,
		];
	if (worker.available)
		return [
			"available",
			"Reproduction and verification run in an isolated Docker sandbox on this machine.",
		];
	const why =
		worker.detail === "docker_unavailable"
			? "Docker is not reachable"
			: worker.detail?.startsWith("image_missing")
				? "the pinned sandbox image is missing; run npm run sandbox:pull"
				: "the worker reports it unavailable";
	return ["needs_configuration", `${needs}, but ${why}.`];
}

/** The pure derivation: the same configuration and worker report always give the same listing. */
export function deriveCapabilities(
	config: CapabilityConfig,
	worker: WorkerSandbox,
): CapabilitiesResponse {
	const mock = config.inference.provider === "mock";
	const model = mock
		? "the mock adapter, so model results are [mock] placeholders"
		: `${config.inference.providerName} [live]`;
	const { google, googleMissing } = config.meetings;
	const entries: Record<CapabilityId, { label: string; verdict: Verdict }> = {
		investigation_analysis: {
			label: "Investigation analysis",
			verdict: [
				"available",
				`Bug reports are analyzed against the indexed code with ${model}.`,
			],
		},
		screenshot_understanding: {
			label: "Screenshot understanding",
			verdict: ["available", `Screenshots are read with ${model}.`],
		},
		sandbox_verification: {
			label: "Sandbox reproduction and verification",
			verdict: sandboxVerdict(config, worker),
		},
		patch_download: {
			label: "Patch download",
			verdict: [
				"available",
				"An approved patch can be downloaded as a file to apply yourself.",
			],
		},
		authorized_actions: {
			label: "Apply, commit, and push",
			verdict:
				config.environment === "hosted"
					? ["unavailable", HOSTED_ACTIONS]
					: [
							"available",
							"An approved patch can be applied, committed, and pushed, each as a separate step you authorize from your signed-in session.",
						],
		},
		google_meet: {
			label: "Google Meet transcript import",
			verdict: google
				? [
						"available",
						"Meeting transcripts can be imported from a connected Google account.",
					]
				: [
						"needs_configuration",
						`Google Meet import needs ${googleMissing.join(", ")}.`,
					],
		},
		mcp_client: {
			label: "MCP clients",
			verdict: [
				"available",
				"MCP clients run on your machine and connect to this server with a personal access token; they can never apply, commit, or push a patch.",
			],
		},
		browser_extension: {
			label: "Browser extension",
			verdict: [
				"available",
				"The browser extension runs in your browser and files bug reports to this server with a personal access token.",
			],
		},
	};
	return {
		environment: config.environment,
		inference: {
			mode: mock ? "mock" : "live",
			provider: config.inference.providerName,
		},
		items: CAPABILITY_IDS.map((id) => {
			const { label, verdict } = entries[id];
			return { id, label, status: verdict[0], reason: verdict[1] };
		}),
	};
}

/** The heartbeat `/readyz` reads: a worker writes one every 15 s, so an older one is a stopped worker. */
export async function readWorkerSandbox(db: Db): Promise<WorkerSandbox> {
	const [beat] = await db
		.select({ sandbox: workerHeartbeats.sandbox })
		.from(workerHeartbeats)
		.where(gt(workerHeartbeats.updatedAt, new Date(Date.now() - 60_000)))
		.orderBy(desc(workerHeartbeats.updatedAt))
		.limit(1);
	return beat
		? { available: beat.sandbox.available, detail: beat.sandbox.detail }
		: null;
}

export async function describeCapabilities(deps: { db: Db; config: Config }) {
	return deriveCapabilities(deps.config, await readWorkerSandbox(deps.db));
}
