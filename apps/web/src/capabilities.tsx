import { useQuery } from "@tanstack/react-query";
import type { CapabilityId } from "@tracera/contracts";
import type { ReactNode } from "react";
import { getCapabilities, patchDownloadPath } from "./api.ts";
import { PublicationPanel } from "./publication.tsx";
import type { Patch } from "./schemas.ts";
import { InferenceLabel, linkClass, Notice, Section } from "./ui.tsx";

// What this environment can really do, as the server states it. A feature is offered only when the
// server says it is available: while the answer is loading or could not be read, nothing is offered
// and nothing is claimed.

/** Fetched once and shared by every consumer through the query cache. */
export const useCapabilities = () =>
	useQuery({
		queryKey: ["capabilities"],
		queryFn: getCapabilities,
		staleTime: Number.POSITIVE_INFINITY,
	});

/** The server's entry for one capability; undefined while loading, when unreadable, or when unlisted. */
const useCapability = (id: CapabilityId) =>
	useCapabilities().data?.items.find((item) => item.id === id);

/** Where this server runs, and whether its model results are live or mock. */
export function EnvironmentChip() {
	const { data } = useCapabilities();
	if (!data) return null;
	const unusable = data.items
		.filter((item) => item.status !== "available")
		.map((item) => item.label);
	return (
		<span
			title={
				unusable.length > 0
					? `Not usable here: ${unusable.join(", ")}`
					: "Everything listed is usable here"
			}
			className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-ink-2 text-xs"
		>
			<span className="truncate">
				{data.environment === "hosted" ? "Hosted demo" : "Local"}
			</span>
			<span className="max-sm:hidden">
				<InferenceLabel mock={data.inference.mode === "mock"} />
			</span>
		</span>
	);
}

/** Outcomes and statuses that mean nothing was run. Anything else was run somewhere. */
const NOT_RUN = new Set(["blocked", "not_attempted"]);
const didRun = (status: string | undefined) =>
	status !== undefined && !NOT_RUN.has(status);

/** The statement about a missing sandbox, shown only where the stored record shows nothing ran. */
function SandboxNote({ children }: { children: ReactNode }) {
	const sandbox = useCapability("sandbox_verification");
	if (!sandbox || sandbox.status === "available") return null;
	return (
		<div className="mb-4">
			<Notice tone="warn" title={children}>
				{sandbox.reason}
			</Notice>
		</div>
	);
}

export function VerificationNotice({ patch }: { patch: Patch }) {
	if (didRun(patch.verification?.outcome)) return null;
	return (
		<SandboxNote>
			No sandbox in this environment: the fix was not run here.
		</SandboxNote>
	);
}

export function ReproductionNotice({
	baseline,
}: {
	baseline: { status: string } | null;
}) {
	if (didRun(baseline?.status)) return null;
	return (
		<SandboxNote>
			No sandbox in this environment: nothing was reproduced here.
		</SandboxNote>
	);
}

/**
 * The "Apply and publish" panel where the server says patches can be applied; elsewhere an
 * explanation, with the download still offered. It shows only for an approved patch.
 */
export function PublicationGate({ patch }: { patch: Patch }) {
	const { data, isPending } = useCapabilities();
	if (isPending) return null;
	if (
		data?.items.find((item) => item.id === "authorized_actions")?.status ===
		"available"
	)
		return <PublicationPanel patch={patch} />;
	if (patch.status !== "approved" || patch.approval?.decision !== "approved")
		return null;
	return (
		<Section title="Apply and publish" id="publication-heading">
			<div className="space-y-3 text-sm">
				<p>
					{data?.environment === "hosted"
						? "Applying, committing, and pushing run in the local app, where Tracera can reach your working tree. This hosted demo generates and reviews patches. Download the patch to apply it yourself."
						: "Tracera could not confirm that this environment can apply patches, so applying, committing, and pushing are not offered. Download the patch to apply it yourself."}
				</p>
				<p>
					<a className={linkClass} href={patchDownloadPath(patch.id)} download>
						Download patch
					</a>
				</p>
			</div>
		</Section>
	);
}
