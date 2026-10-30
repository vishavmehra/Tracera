import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, signIn } from "./api.ts";
import {
	ErrorNotice,
	inputClass,
	labelClass,
	primaryButtonClass,
	Timeline,
	type TimelineStop,
	TraceMark,
} from "./ui.tsx";

/** Where to go after signing in: the in-app path that sent the user here, otherwise the overview. */
function returnPath(state: unknown): string {
	const from =
		typeof state === "object" && state !== null && "from" in state
			? state.from
			: undefined;
	return typeof from === "string" &&
		from.startsWith("/") &&
		!from.startsWith("//")
		? from
		: "/";
}

/** The words beside one stop. Its first line sits level with the stop's node. */
function StopText({
	title,
	last = false,
	children,
}: {
	title: string;
	last?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={`pt-1.5 ${last ? "" : "pb-5"}`}>
			<p className="font-medium text-ink text-sm">{title}</p>
			<p className="mt-0.5 max-w-[44ch] text-ink-2 text-sm">{children}</p>
		</div>
	);
}

/**
 * The product in one line, from a symptom to a decision. The line is drawn the way it is drawn in
 * the app: solid where a result is recorded, dashed where something waits for a person, dotted
 * where nothing is established. It is a picture of the process, not of any investigation.
 */
const STOPS: readonly TimelineStop[] = [
	{
		key: "symptom",
		label: "Symptom",
		tone: "done",
		open: true,
		reached: true,
		body: (
			<StopText title="Symptom">A bug report, as someone reported it.</StopText>
		),
	},
	{
		key: "evidence",
		label: "Evidence",
		tone: "done",
		reached: true,
		body: (
			<StopText title="Evidence">
				Traced through your code graph, with every claim citing its source.
			</StopText>
		),
	},
	{
		key: "reproduction",
		label: "Reproduction",
		tone: "done",
		reached: true,
		body: (
			<StopText title="Reproduction">
				Run in a sandbox, never on your machine.
			</StopText>
		),
	},
	{
		key: "patch",
		label: "Patch",
		tone: "done",
		reached: true,
		body: (
			<StopText title="Patch">
				A diff you can read, with its risks listed.
			</StopText>
		),
	},
	{
		key: "decision",
		label: "Decision",
		tone: "decision",
		open: true,
		reached: false,
		pending: true,
		body: (
			<StopText title="Decision">
				Yours. Nothing reaches your repository without you.
			</StopText>
		),
	},
	{
		key: "certainty",
		label: "Certainty",
		tone: "neutral",
		reached: false,
		body: (
			<StopText title="Certainty" last>
				Claimed only when the recorded checks say so.
			</StopText>
		),
	},
];

export function SignInPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const queryClient = useQueryClient();
	// Data cached for an earlier session must not outlive it, however it ended.
	useEffect(() => {
		queryClient.clear();
	}, [queryClient]);
	const signInMutation = useMutation({
		mutationFn: signIn,
		onSuccess: () => navigate(returnPath(location.state), { replace: true }),
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		signInMutation.mutate({
			email: String(form.get("email") ?? ""),
			password: String(form.get("password") ?? ""),
		});
	};
	const error = signInMutation.error;
	return (
		<div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
			<main className="flex min-h-dvh flex-col px-6 py-8 sm:px-12 lg:min-h-0 lg:px-16 lg:py-10">
				<title>Sign in · Tracera</title>
				<p className="flex items-center gap-2.5 font-semibold text-ink text-lg tracking-tight">
					<TraceMark className="size-7" />
					Tracera
				</p>
				<div className="my-auto w-full max-w-sm py-12">
					<h1 className="font-semibold text-[1.75rem] leading-tight tracking-tight">
						Sign in
					</h1>
					<form onSubmit={onSubmit} className="mt-8 space-y-5">
						<div>
							<label htmlFor="email" className={labelClass}>
								Email
							</label>
							<input
								id="email"
								name="email"
								type="email"
								autoComplete="username"
								required
								maxLength={254}
								className={inputClass}
							/>
						</div>
						<div>
							<label htmlFor="password" className={labelClass}>
								Password
							</label>
							<input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
								minLength={8}
								maxLength={256}
								className={inputClass}
							/>
						</div>
						{error && (
							<ErrorNotice alert title="Sign-in failed" error={error} />
						)}
						{error instanceof ApiError && error.code === "csrf_failed" && (
							<p className="text-ink-2 text-sm">
								The API accepts sign-in only from the origin in its{" "}
								<code>TRACERA_PUBLIC_URL</code>; this page is served from{" "}
								<code>{window.location.origin}</code>.
							</p>
						)}
						<button
							type="submit"
							disabled={signInMutation.isPending}
							className={`${primaryButtonClass} h-10 w-full`}
						>
							{signInMutation.isPending ? "Signing in…" : "Sign in"}
						</button>
					</form>
				</div>
			</main>
			<aside
				aria-label="How Tracera works"
				className="border-line border-t bg-sidebar px-6 py-12 sm:px-12 lg:flex lg:flex-col lg:justify-center lg:border-t-0 lg:border-l lg:px-16 lg:py-10"
			>
				<div className="max-w-md">
					<p className="text-balance font-semibold text-3xl text-ink leading-tight tracking-tight">
						From symptom to certainty.
					</p>
					<p className="mt-3 max-w-[46ch] text-ink-2 text-sm">
						Tracera follows a bug report through your code, reproduces it in a
						sandbox, and puts a patch in front of you with the evidence behind
						it.
					</p>
					<Timeline className="trace-intro mt-9" stops={STOPS} />
					<p className="mt-6 max-w-[46ch] text-ink-3 text-xs">
						The line is solid where a result is recorded, dashed where something
						waits for you, and dotted where nothing is established yet.
					</p>
				</div>
			</aside>
		</div>
	);
}
