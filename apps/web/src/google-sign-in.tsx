import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, getAuthProviders, signInWithGoogle } from "./api.ts";
import { buttonClass, ErrorNotice, PageStatus, TraceMark } from "./ui.tsx";

/**
 * "Continue with Google": shown only when the server says it is set up. The password form stays the
 * way in when this is absent, so a failed lookup simply leaves it out. The answer is not kept in the
 * query cache because the sign-in page empties that cache when it opens.
 */
export function GoogleSignInButton() {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		let current = true;
		getAuthProviders()
			.then(({ google }) => {
				if (current && google.enabled) setUrl(google.authorize_url);
			})
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, []);
	if (!url) return null;
	return (
		<div className="mt-6">
			<div className="flex items-center gap-3 text-ink-3 text-xs">
				<span aria-hidden="true" className="h-px flex-1 bg-line" />
				or
				<span aria-hidden="true" className="h-px flex-1 bg-line" />
			</div>
			<a href={url} className={`${buttonClass} mt-6 h-10 w-full`}>
				Continue with Google
			</a>
		</div>
	);
}

const TRY_AGAIN = "Start again from the sign-in page.";
const OTHER_WAY = "Try again, or sign in with your email and password.";

/** What each stable failure code means to the person signing in. Nothing from the address or the response is shown. */
const MESSAGES: Record<string, string> = {
	invalid_provider_token: `Google did not accept this sign-in. It may have expired. ${TRY_AGAIN}`,
	validation_failed: `Google sent a sign-in this server cannot read. ${TRY_AGAIN}`,
	email_not_verified:
		"The email address of this Google account is not verified, so it cannot be used to sign in.",
	signin_not_allowed:
		"This Google account is not allowed to sign in here. Ask a workspace owner for access, or sign in with your email and password.",
	provider_unreachable:
		"The sign-in provider could not be reached. Try again in a moment.",
	google_signin_unavailable: "Google sign-in is not turned on for this server.",
	rate_limited:
		"Too many failed sign-in attempts. Wait a few minutes and try again.",
	csrf_failed:
		"The server accepts sign-in only from its configured address, which is not the address of this page.",
	network_error: "The Tracera API could not be reached.",
};
const CANCELLED = `Google sign-in was cancelled or did not complete. ${OTHER_WAY}`;
const NOTHING_TO_DO = `There is no Google sign-in to complete here. ${TRY_AGAIN}`;
const FALLBACK = `Google sign-in could not be completed. ${OTHER_WAY}`;

/**
 * Takes the provider's answer out of the address, removes it from the address bar and the history
 * entry before anything else happens, and trades the access token for a session. Resolves to null
 * when signed in, otherwise to the message to show.
 */
async function completeSignIn(): Promise<string | null> {
	const fragment = new URLSearchParams(window.location.hash.slice(1));
	const query = new URLSearchParams(window.location.search);
	window.history.replaceState(
		window.history.state,
		"",
		window.location.pathname,
	);
	for (const answer of [fragment, query])
		if (answer.has("error") || answer.has("error_description"))
			return CANCELLED;
	const token = fragment.get("access_token");
	if (!token) return NOTHING_TO_DO;
	try {
		await signInWithGoogle({ access_token: token });
		return null;
	} catch (error) {
		return (error instanceof ApiError && MESSAGES[error.code]) || FALLBACK;
	}
}

/** Where the identity provider sends the browser back to: finishes the sign-in, then opens the app. */
export function AuthCallbackPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	// The address can be read only once, so a second run of the effect (React's development re-run)
	// has to wait for the first run's attempt instead of starting one that finds it empty.
	const attempt = useRef<Promise<string | null>>(null);
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		attempt.current ??= completeSignIn();
		let current = true;
		void attempt.current.then((message) => {
			if (!current) return;
			if (message) return setFailure(message);
			// Whatever was cached belonged to an earlier session; the session is fetched again.
			queryClient.clear();
			void navigate("/", { replace: true });
		});
		return () => {
			current = false;
		};
	}, [navigate, queryClient]);
	if (!failure)
		return (
			<>
				<title>Signing in · Tracera</title>
				<PageStatus>Signing you in with Google…</PageStatus>
			</>
		);
	return (
		<main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
			<title>Sign-in failed · Tracera</title>
			<p className="flex items-center gap-2 font-semibold text-ink tracking-tight">
				<TraceMark className="size-6" />
				Tracera
			</p>
			<h1 className="mt-8 font-semibold text-2xl tracking-tight">
				Google sign-in
			</h1>
			<div className="mt-6">
				<ErrorNotice alert title="Sign-in failed" error={new Error(failure)} />
			</div>
			<Link to="/sign-in" className="mt-6 inline-block text-link underline">
				Back to sign in
			</Link>
		</main>
	);
}
