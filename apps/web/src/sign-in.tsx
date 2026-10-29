import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, signIn } from "./api.ts";
import {
	ErrorNotice,
	inputClass,
	labelClass,
	primaryButtonClass,
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
		<main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
			<title>Sign in · Tracera</title>
			<p className="flex items-center gap-2 font-semibold text-ink tracking-tight">
				<TraceMark className="size-6" />
				Tracera
			</p>
			<p className="mt-2 text-ink-3 text-sm">
				Bug reports traced through your code to evidence, a sandboxed
				reproduction, and a patch you decide on.
			</p>
			<h1 className="mt-8 font-semibold text-2xl tracking-tight">Sign in</h1>
			<form onSubmit={onSubmit} className="mt-6 space-y-4">
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
				{error && <ErrorNotice alert title="Sign-in failed" error={error} />}
				{error instanceof ApiError && error.code === "csrf_failed" && (
					<p className="text-sm text-ink-2">
						The API accepts sign-in only from the origin in its{" "}
						<code>TRACERA_PUBLIC_URL</code>; this page is served from{" "}
						<code>{window.location.origin}</code>.
					</p>
				)}
				<button
					type="submit"
					disabled={signInMutation.isPending}
					className={`${primaryButtonClass} h-9 w-full`}
				>
					{signInMutation.isPending ? "Signing in…" : "Sign in"}
				</button>
			</form>
		</main>
	);
}
