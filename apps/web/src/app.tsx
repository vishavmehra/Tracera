import {
	MutationCache,
	QueryCache,
	QueryClient,
	useMutation,
	useQuery,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	type DataRouter,
	Link,
	NavLink,
	Outlet,
	type RouteObject,
	useLocation,
	useNavigate,
	useRouteError,
} from "react-router";
import {
	ApiError,
	getReadiness,
	getSession,
	isSignedOut,
	signOut,
} from "./api.ts";
import { ExplorePage, NodePage } from "./explore.tsx";
import { ImpactPage, PatchAnalysisPage } from "./impact.tsx";
import {
	InvestigationPage,
	InvestigationsPage,
	NewInvestigationPage,
} from "./investigations.tsx";
import { QuestionPage, QuestionsPage } from "./questions.tsx";
import { RepositoriesPage } from "./repositories.tsx";
import {
	RegisterRepositoryPage,
	RepositoryLayout,
	RepositoryOverview,
} from "./repository.tsx";
import { PatchReviewPage, ReportPage } from "./review.tsx";
import type { Session } from "./schemas.ts";
import { SignInPage } from "./sign-in.tsx";
import { ErrorNotice, Glyph, humanize, PageStatus, TraceMark } from "./ui.tsx";

/** Only failures that can pass by themselves are retried: no response at all, or a 5xx. */
const retryTransient = (failures: number, error: unknown) =>
	failures < 2 &&
	error instanceof ApiError &&
	(error.status === 0 || error.status >= 500);

/** Any 401 means the session ended: go to sign-in, then come back to the same page. */
export function createQueryClient(
	router: Pick<DataRouter, "navigate" | "state">,
) {
	const onError = (error: unknown) => {
		const from = router.state.location.pathname;
		if (isSignedOut(error) && from !== "/sign-in")
			void router.navigate("/sign-in", { replace: true, state: { from } });
	};
	return new QueryClient({
		queryCache: new QueryCache({ onError }),
		mutationCache: new MutationCache({ onError }),
		defaultOptions: { queries: { retry: retryTransient } },
	});
}

function RequireSession() {
	const session = useQuery({
		queryKey: ["session"],
		queryFn: getSession,
		staleTime: 5 * 60_000,
	});
	if (session.error) {
		// The query client's 401 handler is already navigating to sign-in.
		if (isSignedOut(session.error))
			return <PageStatus>Redirecting to sign in…</PageStatus>;
		return (
			<main className="mx-auto max-w-lg px-4 py-16">
				<ErrorNotice
					title="Your session could not be checked"
					error={session.error}
					onRetry={() => void session.refetch()}
				/>
			</main>
		);
	}
	if (!session.data) return <PageStatus>Checking your session…</PageStatus>;
	return <Shell session={session.data} />;
}

function Shell({ session }: { session: Session }) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const main = useRef<HTMLElement>(null);
	const shownPath = useRef(pathname);
	// After in-app navigation, move focus to the new page so keyboard and screen-reader users start there.
	useEffect(() => {
		if (shownPath.current === pathname) return;
		shownPath.current = pathname;
		main.current?.focus();
	}, [pathname]);
	const signOutMutation = useMutation({
		mutationFn: signOut,
		onSuccess: () => navigate("/sign-in", { replace: true }),
	});
	return (
		<div className="min-h-dvh">
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:rounded focus:bg-elevated focus:px-3 focus:py-2 focus:text-ink"
			>
				Skip to content
			</a>
			<header className="sticky top-0 z-20 border-line border-b bg-sidebar">
				<div className="mx-auto flex h-12 max-w-6xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
					<Link
						to="/"
						className="flex shrink-0 items-center gap-2 rounded font-semibold text-ink tracking-tight"
					>
						<TraceMark />
						<span className="max-sm:sr-only">Tracera</span>
					</Link>
					<nav aria-label="Main" className="flex items-center gap-0.5 sm:gap-1">
						<NavLink
							to="/"
							className={({ isActive }) =>
								navClass(isActive || pathname.startsWith("/repositories"))
							}
							end
						>
							Repositories
						</NavLink>
						<NavLink
							to="/investigations"
							className={({ isActive }) => navClass(isActive)}
						>
							Investigations
						</NavLink>
					</nav>
					<div className="ml-auto flex items-center gap-2 sm:gap-4">
						<SystemStatus />
						<AccountMenu
							session={session}
							signingOut={signOutMutation.isPending}
							onSignOut={() => signOutMutation.mutate()}
						/>
					</div>
				</div>
			</header>
			<main
				id="main"
				ref={main}
				tabIndex={-1}
				className="mx-auto max-w-6xl px-4 py-8 outline-none sm:px-6"
			>
				{signOutMutation.error && !isSignedOut(signOutMutation.error) && (
					<div className="mb-6">
						<ErrorNotice
							alert
							title="Sign-out failed"
							error={signOutMutation.error}
						/>
					</div>
				)}
				<Outlet />
			</main>
		</div>
	);
}

// Active navigation is a selection: a plum chip, the brand's selected-state color.
const navClass = (active: boolean) =>
	`rounded px-2 py-1.5 text-sm transition-colors sm:px-2.5 ${active ? "bg-plum/80 font-medium text-ink" : "text-ink-2 hover:bg-interactive/50 hover:text-ink"}`;

/**
 * What the server is running with (public /readyz): mock inference is announced in the shell so no
 * result is mistaken for a live one, and a missing worker explains work that never starts.
 */
function SystemStatus() {
	const ready = useQuery({
		queryKey: ["readyz"],
		queryFn: getReadiness,
		staleTime: 60_000,
		refetchInterval: 60_000,
	});
	if (!ready.data) return null;
	const { inference_mode, worker } = ready.data;
	return (
		<p className="flex items-center gap-3 text-xs">
			{inference_mode === "mock" ? (
				<span
					title="Inference uses the mock adapter: model results are not real model output"
					className="inline-flex items-center gap-1.5 font-medium text-warning"
				>
					<Glyph tone="warn" />
					<span>
						Mock<span className="max-sm:sr-only"> inference</span>
					</span>
				</span>
			) : (
				<span className="inline-flex items-center gap-1.5 text-ink-3 max-sm:sr-only">
					<Glyph tone="done" />
					{humanize(inference_mode)} inference
				</span>
			)}
			{worker !== "ok" && (
				<span className="inline-flex items-center gap-1.5 font-medium text-error">
					<Glyph tone="bad" />
					Worker {worker.replaceAll("_", " ")}
				</span>
			)}
		</p>
	);
}

const initialsOf = (name: string) =>
	name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join("") || "?";

/** Who is signed in, in which workspace, and sign-out: one menu instead of a row of metadata. */
function AccountMenu({
	session,
	signingOut,
	onSignOut,
}: {
	session: Session;
	signingOut: boolean;
	onSignOut: () => void;
}) {
	const { user, workspace } = session;
	const name = user.display_name ?? user.email ?? user.id;
	return (
		<>
			<button
				type="button"
				popoverTarget="account-menu"
				className="flex items-center gap-2 rounded py-1 pr-1 pl-1 text-ink-2 text-sm transition-colors hover:bg-interactive/50 hover:text-ink sm:pr-2"
			>
				<span
					aria-hidden="true"
					className="grid size-7 place-items-center rounded-full bg-ocean font-semibold text-[11px] text-ink"
				>
					{initialsOf(name)}
				</span>
				<span className="max-w-32 truncate max-sm:sr-only">{name}</span>
				<span className="sr-only">account menu</span>
			</button>
			<div
				id="account-menu"
				popover="auto"
				className="fixed inset-auto top-13 right-[max(1rem,calc((100vw-72rem)/2+1.5rem))] m-0 w-64 rounded-md border border-line-strong bg-elevated p-1 text-ink text-sm shadow-black/50 shadow-xl"
			>
				<div className="px-3 py-2">
					<p className="truncate font-medium">{name}</p>
					{user.email && user.email !== name && (
						<p className="truncate text-ink-3 text-xs">{user.email}</p>
					)}
				</div>
				<div className="border-line border-t px-3 py-2">
					<p className="text-ink-3 text-xs">Workspace</p>
					<p className="truncate">
						{workspace.name ?? workspace.id}{" "}
						<span className="text-ink-3">({workspace.role})</span>
					</p>
				</div>
				<div className="border-line border-t p-1">
					<button
						type="button"
						onClick={onSignOut}
						disabled={signingOut}
						className="w-full rounded px-2 py-1.5 text-left text-ink hover:bg-interactive/60 disabled:text-ink-3"
					>
						{signingOut ? "Signing out…" : "Sign out"}
					</button>
				</div>
			</div>
		</>
	);
}

function RouteError() {
	const error = useRouteError();
	return (
		<main className="mx-auto max-w-lg px-4 py-16">
			<title>Error · Tracera</title>
			<h1 className="font-semibold text-2xl">This page could not be shown</h1>
			<p className="mt-2 break-words text-ink-2">
				{error instanceof Error
					? error.message
					: "An unexpected error occurred."}
			</p>
			<Link to="/" className="mt-4 inline-block text-link underline">
				Back to repositories
			</Link>
		</main>
	);
}

function NotFound() {
	return (
		<>
			<title>Page not found · Tracera</title>
			<h1 className="font-semibold text-2xl">Page not found</h1>
			<Link to="/" className="mt-4 inline-block text-link underline">
				Back to repositories
			</Link>
		</>
	);
}

export const routes: RouteObject[] = [
	{ path: "/sign-in", element: <SignInPage />, errorElement: <RouteError /> },
	{
		element: <RequireSession />,
		errorElement: <RouteError />,
		children: [
			{ index: true, element: <RepositoriesPage /> },
			{ path: "repositories/new", element: <RegisterRepositoryPage /> },
			{
				path: "repositories/:repositoryId",
				element: <RepositoryLayout />,
				children: [
					{ index: true, element: <RepositoryOverview /> },
					{ path: "explore", element: <ExplorePage /> },
					{ path: "nodes/:nodeId", element: <NodePage /> },
					{ path: "questions", element: <QuestionsPage /> },
					{ path: "questions/:assessmentId", element: <QuestionPage /> },
					{ path: "impact", element: <ImpactPage /> },
					{ path: "patch-impact/:analysisId", element: <PatchAnalysisPage /> },
				],
			},
			{ path: "investigations", element: <InvestigationsPage /> },
			{ path: "investigations/new", element: <NewInvestigationPage /> },
			{
				path: "investigations/:investigationId",
				element: <InvestigationPage />,
			},
			{
				path: "investigations/:investigationId/patches/:patchId",
				element: <PatchReviewPage />,
			},
			{
				path: "investigations/:investigationId/report",
				element: <ReportPage />,
			},
			{ path: "*", element: <NotFound /> },
		],
	},
];
