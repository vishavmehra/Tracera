import { useMutation, useQuery } from "@tanstack/react-query";
import { type AnswerStatus, idSchema } from "@tracera/contracts";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { askQuestion, getAssessment } from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import { useRepository } from "./repository.tsx";
import { type AnswerResult, parseAnswer, parsePartial } from "./schemas.ts";
import {
	Breadcrumbs,
	ErrorNotice,
	EvidenceView,
	Facts,
	humanize,
	InferenceLabel,
	inputClass,
	Limitations,
	Loading,
	labelClass,
	linkClass,
	NotIndexed,
	notIndexed,
	panelClass,
	primaryButtonClass,
	QueryView,
	Section,
	Sha,
	StateBadge,
	Status,
	type Tone,
} from "./ui.tsx";

// An answer is a verdict on evidence, not a verification: answered is information blue, never green.
const ANSWER_TONES: Record<AnswerStatus, Tone> = {
	ANSWERED: "info",
	PARTIALLY_ANSWERED: "warn",
	// Not an error and not an answer: the uncertainty tone keeps it apart from both.
	INSUFFICIENT_EVIDENCE: "uncertain",
};

const answerLabel = (status: string) => humanize(status.toLowerCase());

function AskForm({
	followUpOf,
	initial = "",
}: {
	followUpOf?: string;
	initial?: string;
}) {
	const repo = useRepository();
	const navigate = useNavigate();
	const ask = useMutation({
		mutationFn: (question: string) =>
			askQuestion(repo.id, { question, follow_up_of: followUpOf }),
		onSuccess: ({ assessment }) =>
			navigate(`/repositories/${repo.id}/questions/${assessment.id}`),
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		ask.mutate(
			String(new FormData(event.currentTarget).get("question") ?? "").trim(),
		);
	};
	const id = followUpOf ? "follow-up" : "question";
	return (
		<form onSubmit={onSubmit} className="space-y-3">
			<label htmlFor={id} className={labelClass}>
				{followUpOf ? "Ask a follow-up" : "Question about this repository"}
			</label>
			<textarea
				id={id}
				name="question"
				key={initial}
				defaultValue={initial}
				required
				minLength={5}
				maxLength={2000}
				rows={3}
				className={inputClass}
			/>
			{notIndexed(ask.error) ? (
				<NotIndexed />
			) : (
				ask.error && (
					<ErrorNotice
						alert
						title="The question could not be asked"
						error={ask.error}
					/>
				)
			)}
			<button
				type="submit"
				className={primaryButtonClass}
				disabled={ask.isPending}
			>
				{ask.isPending ? "Asking…" : followUpOf ? "Ask follow-up" : "Ask"}
			</button>
		</form>
	);
}

export function QuestionsPage() {
	return (
		<Section title="Engineering questions" id="questions-heading">
			<p className="mb-4 max-w-[68ch] text-ink-2 text-sm">
				Answers are drafted by the configured model from evidence gathered out
				of the indexed snapshot. A claim counts as supported only when it cites
				valid code, graph, or repository-fact evidence; everything else is shown
				as unsupported.
			</p>
			<div className={`max-w-3xl ${panelClass}`}>
				<AskForm />
			</div>
		</Section>
	);
}

function Answer({
	result,
	onFollowUp,
}: {
	result: AnswerResult;
	onFollowUp: (question: string) => void;
}) {
	return (
		<div className="space-y-6 text-sm">
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<Status
						tone={ANSWER_TONES[result.status]}
						title={result.status}
						size="sm"
					>
						{answerLabel(result.status)}
					</Status>
					<InferenceLabel
						mock={result.inference_mode === "mock"}
						detail={`${result.model.provider}/${result.model.model}`}
					/>
				</div>
				<Facts
					items={[
						[
							"Confidence",
							<span key="confidence">
								{humanize(result.confidence)}
								{result.model_confidence !== result.confidence && (
									<span className="text-ink-3">
										{" "}
										(model said {result.model_confidence})
									</span>
								)}
							</span>,
						],
						[
							"Citations",
							<span key="citations" className="tabular-nums">
								{result.citations.total}
								{result.citations.invalid > 0 && (
									<span className="text-warning">
										{" "}
										({result.citations.invalid} invalid)
									</span>
								)}
							</span>,
						],
					]}
				/>
			</div>
			{result.downgrades.length > 0 && (
				<p className="border-warning border-l-2 bg-warning/6 py-2 pr-3 pl-3.5 text-ink-2">
					<span className="font-medium text-warning">Downgraded by rules</span>{" "}
					from {answerLabel(result.model_status).toLowerCase()}:{" "}
					{result.downgrades.map((reason) => humanize(reason)).join(", ")}.
				</p>
			)}
			{result.status === "INSUFFICIENT_EVIDENCE" && (
				<p className="border-uncertain border-l-2 bg-uncertain/6 py-2 pr-3 pl-3.5">
					The indexed evidence is not enough to answer this question. Try naming
					files or symbols, or ask a narrower question.
				</p>
			)}
			<div>
				<h3 className="font-semibold">
					Summary{" "}
					<span className="font-normal text-ink-3 text-xs">
						inferred by the model
					</span>
				</h3>
				<p className="mt-1.5 max-w-[68ch] whitespace-pre-wrap text-[15px] leading-relaxed">
					{result.summary.text}
				</p>
			</div>
			<div>
				<h3 className="font-semibold">Claims ({result.claims.length})</h3>
				<ol className="mt-2 divide-y divide-line border-line border-y">
					{result.claims.map((claim, index) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: claims have no ID and keep their order
							key={index}
							className="space-y-2.5 py-3"
						>
							<p className="flex flex-wrap items-start gap-x-3 gap-y-1">
								<Status
									tone={claim.supported ? "info" : "uncertain"}
									title={claim.basis}
								>
									{claim.supported ? "Supported" : "Unsupported"}
								</Status>
								<span className="min-w-0 max-w-[68ch] flex-1">
									{claim.statement}
								</span>
							</p>
							{claim.evidence.length > 0 ? (
								<ul className="space-y-3 border-trace border-l-2 pl-4">
									{claim.evidence.map((evidence) => (
										<li
											key={`${evidence.handle}:${evidence.path}:${evidence.start_line}`}
										>
											<EvidenceView evidence={evidence} />
										</li>
									))}
								</ul>
							) : (
								<p className="text-ink-3 text-xs">No valid citation.</p>
							)}
						</li>
					))}
				</ol>
			</div>
			{result.unknowns.length > 0 && (
				<div>
					<h3 className="font-semibold">Unknowns</h3>
					<ul className="mt-1.5 max-w-[68ch] list-disc space-y-1 pl-5">
						{result.unknowns.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</div>
			)}
			{result.follow_up_questions.length > 0 && (
				<div>
					<h3 className="font-semibold">Suggested follow-ups</h3>
					<ul className="mt-1.5 space-y-1">
						{result.follow_up_questions.map((question) => (
							<li key={question}>
								<button
									type="button"
									className={`${linkClass} text-left`}
									onClick={() => onFollowUp(question)}
								>
									{question}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
			<p className="max-w-[68ch] text-ink-3 text-xs">
				Confidence rationale: {result.confidence_rationale}
			</p>
			<Limitations items={result.limitations} />
		</div>
	);
}

export function QuestionPage() {
	const repo = useRepository();
	const { assessmentId = "" } = useParams();
	const valid = idSchema("asm").safeParse(assessmentId).success;
	const [followUp, setFollowUp] = useState("");
	const assessment = useQuery({
		queryKey: ["assessments", assessmentId],
		queryFn: () => getAssessment(assessmentId),
		enabled: valid,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "queued" || status === "running" ? POLL_MS : false;
		},
	});
	if (!valid) return <p className="mt-6">Not a question ID.</p>;
	return (
		<div className="mt-6">
			<Breadcrumbs
				items={[
					{
						key: "questions",
						label: "Questions",
						to: `/repositories/${repo.id}/questions`,
					},
					{ key: "question", label: "Answer" },
				]}
			/>
			<QueryView query={assessment} what="Question">
				{(data) => {
					const answer =
						data.status === "completed" ? parseAnswer(data.result) : null;
					const partial = parsePartial(data.result);
					return (
						<div className="mt-3 space-y-6">
							<title>{`Question · ${repo.name} · Tracera`}</title>
							<div>
								<h2 className="max-w-[68ch] whitespace-pre-wrap break-words font-semibold text-xl leading-snug tracking-tight">
									{data.request}
								</h2>
								<p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-3 text-sm">
									<StateBadge value={data.status} />
									{data.commit_sha && (
										<span>
											At <Sha sha={data.commit_sha} />
										</span>
									)}
									{data.follow_up_of && (
										<Link
											to={`/repositories/${repo.id}/questions/${data.follow_up_of}`}
											className={linkClass}
										>
											Follows an earlier question
										</Link>
									)}
								</p>
							</div>
							<div aria-live="polite">
								{data.status === "queued" || data.status === "running" ? (
									<Loading>
										{data.status === "queued"
											? "Queued"
											: "Gathering evidence and drafting an answer"}
										…
									</Loading>
								) : null}
							</div>
							{data.status === "failed" && (
								<div className="border-error border-l-2 bg-error/7 py-2.5 pr-3 pl-3.5 text-sm">
									<p className="text-error">
										<code>{data.error?.code ?? "failed"}</code>:{" "}
										{data.error?.message ??
											"The question could not be answered."}
									</p>
									<p className="mt-1 text-ink-3">No verdict was produced.</p>
									{partial.success && (
										<Limitations items={partial.data.limitations ?? []} />
									)}
								</div>
							)}
							{answer &&
								(answer.success ? (
									<Answer result={answer.data} onFollowUp={setFollowUp} />
								) : (
									<p className="text-sm text-warning">
										The stored answer does not match the expected format and is
										not shown.
									</p>
								))}
							{data.status === "completed" && data.kind === "question" && (
								<div className={`max-w-3xl ${panelClass}`}>
									<AskForm followUpOf={data.id} initial={followUp} />
								</div>
							)}
						</div>
					);
				}}
			</QueryView>
		</div>
	);
}
