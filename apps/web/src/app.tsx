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
import {
	ErrorNotice,
	Glyph,
	humanize,
	Icon,
	type IconName,
	PageStatus,
	TraceMark,
	titleClass,
} from "./ui.tsx";

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

type NavItem = {
	to: string;
	label: string;
	icon: IconName;
	/** Whether a location belongs to this section, so deep pages keep their section marked. */
	current: (pathname: string) => boolean;
};

/** The primary navigation: one entry for each top-level section. Add a section here. */
const NAV: readonly NavItem[] = [
	{
		to: "/",
		label: "Repositories",
		icon: "repository",
		current: (path) => path === "/" || path.startsWith("/repositories"),
	},
	{
		to: "/investigations",
		label: "Investigations",
		icon: "investigation",
		current: (path) => path.startsWith("/investigations"),
	},
];

/**
 * The shell: a sidebar with the brand and the primary navigation, and a top bar with system status and
 * the account menu. Below the lg breakpoint the sidebar collapses: the brand moves into the top bar
 * and the navigation becomes a tab bar fixed to the bottom edge, so there is one nav in the document. The
 * tab bar shares the width equally and scrolls sideways inside itself when sections no longer fit.
 */
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
		<div className="min-h-dvh lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)]">
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:font-medium focus:text-on-primary"
			>
				Skip to content
			</a>
			<div className="lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-line lg:border-r lg:bg-sidebar">
				{/* The same height as the top bar, so the rule under the two forms one line. */}
				<div className="max-lg:hidden lg:flex lg:h-14 lg:shrink-0 lg:items-center lg:border-line lg:border-b lg:px-5">
					<Brand />
				</div>
				<nav
					aria-label="Main"
					className="flex border-line border-t bg-sidebar max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-30 max-lg:scroll-px-10 max-lg:overflow-x-auto max-lg:pb-[env(safe-area-inset-bottom)] max-lg:[scrollbar-width:none] lg:mt-4 lg:flex-col lg:gap-0.5 lg:border-t-0 lg:bg-transparent lg:px-3"
				>
					{NAV.map((item) => {
						const active = item.current(pathname);
						return (
							<Link
								key={item.to}
								to={item.to}
								aria-current={active ? "page" : undefined}
								className={navClass(active)}
							>
								<Icon
									name={item.icon}
									className={`size-[18px] transition-colors duration-150 ${active ? "text-trace-reached" : "text-ink-3 group-hover:text-ink-2"}`}
								/>
								{item.label}
							</Link>
						);
					})}
				</nav>
			</div>
			<div className="flex min-w-0 flex-col">
				<header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-line border-b bg-canvas px-4 sm:px-6 lg:px-8">
					<Brand className="lg:hidden" />
					<SystemStatus />
					<div className="ml-auto">
						<AccountMenu
							session={session}
							signingOut={signOutMutation.isPending}
							onSignOut={() => signOutMutation.mutate()}
						/>
					</div>
				</header>
				<main
					id="main"
					ref={main}
					tabIndex={-1}
					className="mx-auto w-full max-w-7xl px-4 py-6 outline-none max-lg:pb-24 sm:px-6 lg:px-8 lg:py-8"
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
		</div>
	);
}

/** Placed in the sidebar and in the top bar; the breakpoint shows only one of the two. */
function Brand({ className = "" }: { className?: string }) {
	return (
		<Link
			to="/"
			className={`flex shrink-0 items-center gap-2.5 rounded-md font-semibold text-ink text-lg tracking-tight ${className}`}
		>
			<TraceMark className="size-7" />
			Tracera
		</Link>
	);
}

/**
 * The current section is a selection: an orange mark and the accent wash. In the sidebar the mark is a
 * bar on the left edge; in the bottom tab bar it is a bar on the top edge.
 */
const navClass = (active: boolean) =>
	`group relative flex items-center gap-3 font-medium text-sm transition-colors duration-150 max-lg:flex-1 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2.5 max-lg:text-[11px] max-lg:focus-visible:-outline-offset-2 lg:h-9 lg:rounded-md lg:px-3 ${
		active
			? "bg-wash text-ink before:absolute before:bg-accent max-lg:before:inset-x-5 max-lg:before:top-0 max-lg:before:h-0.5 lg:before:inset-y-2 lg:before:left-0 lg:before:w-[3px] lg:before:rounded-full"
			: "text-ink-2 hover:bg-elevated hover:text-ink"
	}`;

/** A small status pill: a shape, then words. */
const chipClass =
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1";

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
		<p className="flex min-w-0 items-center gap-2 text-xs">
			{inference_mode === "mock" ? (
				<span
					title="Inference uses the mock adapter: model results are not real model output"
					className={`${chipClass} border-warning/40 bg-warning/10 font-medium text-warning`}
				>
					<Glyph tone="warn" />
					<span>
						Mock<span className="max-sm:sr-only"> inference</span>
					</span>
				</span>
			) : (
				<span
					title={inference_mode}
					className={`${chipClass} border-line text-ink-2 max-sm:sr-only`}
				>
					<Glyph tone="done" />
					{humanize(inference_mode)} inference
				</span>
			)}
			{worker !== "ok" && (
				<span
					title={worker}
					className={`${chipClass} border-error/40 bg-error/10 font-medium text-error`}
				>
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
				className="flex items-center gap-2 rounded-md py-1 pr-1 pl-1 text-ink-2 text-sm transition-colors duration-150 hover:bg-elevated hover:text-ink sm:pr-2"
			>
				<span
					aria-hidden="true"
					className="grid size-8 place-items-center rounded-full border border-accent/40 bg-wash font-semibold text-link text-xs"
				>
					{initialsOf(name)}
				</span>
				<span className="max-w-36 truncate max-sm:sr-only">{name}</span>
				<Icon name="chevron-down" className="size-4 max-sm:hidden" />
				<span className="sr-only">account menu</span>
			</button>
			<div
				id="account-menu"
				popover="auto"
				className="fixed inset-auto top-16 right-4 m-0 w-64 rounded-lg border border-line-strong bg-canvas p-1 text-ink text-sm shadow-black/10 shadow-lg sm:right-6 lg:right-8"
			>
				<div className="px-3 py-2">
					<p className="truncate font-medium">{name}</p>
					{user.email && user.email !== name && (
						<p className="truncate text-ink-2 text-xs">{user.email}</p>
					)}
				</div>
				<div className="border-line border-t px-3 py-2">
					<p className="text-ink-2 text-xs">Workspace</p>
					<p className="truncate">
						{workspace.name ?? workspace.id}{" "}
						<span className="text-ink-2">({workspace.role})</span>
					</p>
				</div>
				<div className="border-line border-t p-1">
					<button
						type="button"
						onClick={onSignOut}
						disabled={signingOut}
						className="w-full rounded-md px-2 py-1.5 text-left text-ink transition-colors duration-150 hover:bg-elevated disabled:text-ink-3"
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
			<h1 className={titleClass}>This page could not be shown</h1>
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
			<h1 className={titleClass}>Page not found</h1>
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
