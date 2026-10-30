import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EvidenceLocation } from "@tracera/contracts";
import { useEffect, useId, useState } from "react";
import {
	getEvidenceLocations,
	getReadiness,
	requestEvidenceLocation,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import {
	buttonClass,
	ErrorNotice,
	hintClass,
	InferenceLabel,
	inputClass,
	Loading,
} from "./ui.tsx";

// Regions a segmentation model located in a screenshot. They show where a model says a named element
// is; they are a display aid and never evidence that anything is wrong.

const locationsKey = (evidenceId: string) => [
	"evidence",
	evidenceId,
	"locations",
];

/** How long to keep polling for a result before giving up on showing it live. */
const WAIT_MS = 90_000;

/** The locating state of one screenshot: its results, which ones are drawn, and a pending request. */
export function useLocator(evidenceId: string, version: number | undefined) {
	const queryClient = useQueryClient();
	const ready = useQuery({
		queryKey: ["readyz"],
		queryFn: getReadiness,
		staleTime: 60_000,
	});
	// Only Meta hosts a segmentation model. The server refuses the rest; this keeps the control away.
	const available = ready.data?.inference_mode === "meta";
	const [asked, setAsked] = useState<{ baseline: number } | null>(null);
	const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
	const results = useQuery({
		queryKey: [...locationsKey(evidenceId), version],
		queryFn: () => getEvidenceLocations(evidenceId),
		enabled: available,
		refetchInterval: (query) =>
			asked !== null &&
			(query.state.data?.locations.length ?? 0) <= asked.baseline
				? POLL_MS
				: false,
	});
	const locations = results.data?.locations ?? [];
	const request = useMutation({
		mutationFn: (phrase: string) => requestEvidenceLocation(evidenceId, phrase),
		onSuccess: () => {
			setAsked({ baseline: locations.length });
			void queryClient.invalidateQueries({
				queryKey: locationsKey(evidenceId),
			});
		},
	});
	useEffect(() => {
		if (!asked) return;
		const timer = setTimeout(() => setAsked(null), WAIT_MS);
		return () => clearTimeout(timer);
	}, [asked]);
	return {
		available,
		locations,
		hidden,
		/** Results drawn on the image: found something, and not switched off. */
		drawn: locations.filter(
			(item) =>
				item.status === "succeeded" &&
				item.boxes.length > 0 &&
				!hidden.has(item.id),
		),
		toggle: (id: string) =>
			setHidden((current) => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			}),
		ask: (phrase: string) => request.mutate(phrase),
		pending: request.isPending,
		error: request.error,
		waiting: asked !== null && locations.length <= asked.baseline,
	};
}

/** Boxes over the screenshot, placed in percent of the image so they follow it at any size. */
export function RegionOverlay({
	locations,
}: {
	locations: EvidenceLocation[];
}) {
	return (
		<>
			{locations.flatMap((location) =>
				location.boxes.map((box) => (
					<span
						key={`${location.id}:${box.x1}:${box.y1}`}
						aria-hidden="true"
						data-region={location.phrase}
						className="pointer-events-none absolute border-2 border-uncertain bg-uncertain/10"
						style={{
							left: `${(box.x1 / box.width) * 100}%`,
							top: `${(box.y1 / box.height) * 100}%`,
							width: `${((box.x2 - box.x1 + 1) / box.width) * 100}%`,
							height: `${((box.y2 - box.y1 + 1) / box.height) * 100}%`,
						}}
					>
						<span
							className={`absolute left-0 whitespace-nowrap bg-canvas/90 px-1 text-[10px] text-uncertain leading-4 ${
								box.y1 / box.height > 0.06 ? "bottom-full" : "top-full"
							}`}
						>
							{location.phrase}
						</span>
					</span>
				)),
			)}
		</>
	);
}

const confidenceOf = (location: EvidenceLocation) => {
	const values = location.boxes.flatMap((box) =>
		box.confidence === null ? [] : [box.confidence],
	);
	return values.length > 0
		? ` · confidence ${Math.max(...values).toFixed(2)}`
		: "";
};

/** Ask where an element is, and switch each answer on or off. `kinds` are suggestions from the reading. */
export function LocatePanel({
	locator,
	kinds,
}: {
	locator: ReturnType<typeof useLocator>;
	kinds: string[];
}) {
	const id = useId();
	const [phrase, setPhrase] = useState("");
	const clean = phrase.trim();
	const newest = locator.locations[0];
	return (
		<div className="mt-4 space-y-2 border-line border-t pt-3">
			<form
				className="space-y-1.5"
				onSubmit={(event) => {
					event.preventDefault();
					if (clean) locator.ask(clean);
				}}
			>
				<label htmlFor={id} className="font-medium text-ink text-sm">
					Locate on the screenshot
				</label>
				<div className="flex gap-2">
					<input
						id={id}
						value={phrase}
						onChange={(event) => setPhrase(event.currentTarget.value)}
						maxLength={80}
						placeholder="button"
						className={`${inputClass} mt-0`}
					/>
					<button
						type="submit"
						className={buttonClass}
						disabled={!clean || locator.pending || locator.waiting}
					>
						Locate
					</button>
				</div>
				{kinds.length > 0 && (
					<ul className="flex flex-wrap gap-1.5" aria-label="Suggestions">
						{kinds.map((kind) => (
							<li key={kind}>
								<button
									type="button"
									onClick={() => setPhrase(kind)}
									className="rounded border border-line px-2 py-0.5 text-ink-2 text-xs hover:border-trace-done hover:text-ink"
								>
									{kind}
								</button>
							</li>
						))}
					</ul>
				)}
				<p className={hintClass}>
					Name one kind of element, such as button or table. A segmentation
					model draws where it finds it. That is a display aid, not evidence.
				</p>
			</form>
			{locator.waiting && <Loading>Locating…</Loading>}
			{locator.error && (
				<ErrorNotice
					alert
					title="The search could not be requested"
					error={locator.error}
				/>
			)}
			{locator.locations.length > 0 && (
				<div className="space-y-1.5">
					<ul className="space-y-1">
						{locator.locations.map((item) => (
							<li key={item.id} className="text-sm">
								<label className="flex items-start gap-2">
									<input
										type="checkbox"
										checked={!locator.hidden.has(item.id)}
										disabled={
											item.status === "failed" || item.boxes.length === 0
										}
										onChange={() => locator.toggle(item.id)}
										className="mt-1"
									/>
									<span className="min-w-0 break-words">
										<q>{item.phrase}</q>{" "}
										{item.status === "failed" ? (
											<span className="text-error">
												failed ({item.error?.code})
											</span>
										) : item.boxes.length === 0 ? (
											<span className="text-ink-3">nothing found</span>
										) : (
											<span className="text-ink-3">
												{item.boxes.length}{" "}
												{item.boxes.length === 1 ? "region" : "regions"}
												{confidenceOf(item)}
											</span>
										)}
									</span>
								</label>
							</li>
						))}
					</ul>
					{newest && (
						<p className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
							<InferenceLabel
								mock={newest.provenance.mode === "mock"}
								detail={`${newest.provenance.model} via ${newest.provenance.provider}`}
							/>
							<span>
								AI-located regions: where a model says it is, not proof of a
								defect.
							</span>
						</p>
					)}
				</div>
			)}
		</div>
	);
}
