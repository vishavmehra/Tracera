import {
	type FormEvent,
	type InputHTMLAttributes,
	type ReactNode,
	StrictMode,
	useEffect,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { ApiError, createApiClient } from "./api.ts";
import { chromeApi, type Tab } from "./chrome.ts";
import { ConsoleStatusSchema, OkSchema, sendCommand } from "./messages.ts";
import {
	ALLOWED_API_ORIGIN,
	acceptConsent,
	DEFAULTS,
	type ExtensionState,
	forgetAll,
	loadState,
	RECOMMENDED_SCOPES,
	type Settings,
	saveSettings,
	validateSettings,
} from "./settings.ts";
import "./ui.css";

function Brand({ children }: { children?: ReactNode }) {
	return (
		<header className="row spread">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true" />
				<strong>Tracera</strong>
			</div>
			{children}
		</header>
	);
}

function Consent({ onAgree }: { onAgree: () => void }) {
	return (
		<main className="popup stack">
			<Brand />
			<h1>Before you report a bug</h1>
			<p className="secondary">
				Tracera bug capture sends only what you choose, and only to your Tracera
				workspace at <code>{ALLOWED_API_ORIGIN}</code>.
			</p>
			<div className="card stack-tight">
				<h3>When you capture a tab, it collects</h3>
				<ul className="plain small">
					<li>
						a screenshot of the visible part of that tab, which you can crop,
						mark, and black out before anything is sent;
					</li>
					<li>
						the page address without its query string or fragment, the page
						title, the viewport size, and your browser and OS versions;
					</li>
					<li>
						console errors and warnings, only if you turn on recording for that
						tab (off by default).
					</li>
				</ul>
				<h3>It never collects</h3>
				<p className="small secondary">
					Cookies, site storage, form values, passwords, request or response
					bodies, browsing history, or other tabs.
				</p>
			</div>
			<p className="small muted">
				Nothing is sent until you review the exact data and press Send. You can
				withdraw this consent, which also forgets your token, at any time.
			</p>
			<div className="row">
				<button type="button" className="btn btn-primary" onClick={onAgree}>
					Agree and continue
				</button>
				<button
					type="button"
					className="btn btn-quiet"
					onClick={() => window.close()}
				>
					Not now
				</button>
			</div>
		</main>
	);
}

type Saved = { workspace: string; missing: string[] };

function SettingsForm({
	current,
	onDone,
	onCancel,
}: {
	current: Settings | null;
	onDone: () => void;
	onCancel?: () => void;
}) {
	const [values, setValues] = useState({
		api_url: current?.api_url ?? DEFAULTS.api_url,
		web_url: current?.web_url ?? DEFAULTS.web_url,
		token: "",
	});
	const [errors, setErrors] = useState<Partial<Record<keyof Settings, string>>>(
		{},
	);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState<Saved | null>(null);

	async function save(event: FormEvent) {
		event.preventDefault();
		const result = validateSettings(
			{ ...values, token: values.token || current?.token || "" },
			ALLOWED_API_ORIGIN,
		);
		setProblem(null);
		if (!result.ok) {
			setErrors(result.errors);
			return;
		}
		setErrors({});
		setBusy(true);
		try {
			// The token is checked with the API before it is stored.
			const me = await createApiClient({
				apiUrl: result.settings.api_url,
				token: result.settings.token,
			}).me();
			await saveSettings(chromeApi().storage.local, result.settings);
			setSaved({
				workspace: me.workspace.name ?? "your workspace",
				missing: RECOMMENDED_SCOPES.filter(
					(scope) => !me.auth.scopes?.includes(scope),
				),
			});
		} catch (error) {
			setProblem(error instanceof ApiError ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	if (saved)
		return (
			<main className="popup stack">
				<Brand />
				<h1>Connected</h1>
				<p className="secondary">
					The token works for <strong>{saved.workspace}</strong>.
				</p>
				{saved.missing.length > 0 && (
					<p className="alert alert-warning small">
						The token lacks {saved.missing.join(", ")}. Reports will still be
						created, but the extension cannot list repositories, start the
						investigation, or follow its status. Create a token with all four
						scopes to use the full flow.
					</p>
				)}
				<button type="button" className="btn btn-primary" onClick={onDone}>
					Done
				</button>
			</main>
		);

	const field = (
		name: keyof Settings,
		label: string,
		input: InputHTMLAttributes<HTMLInputElement>,
	) => (
		<label className="field">
			<span>{label}</span>
			<input
				{...input}
				value={values[name]}
				aria-invalid={errors[name] ? true : undefined}
				onChange={(event) =>
					setValues({ ...values, [name]: event.currentTarget.value })
				}
			/>
			{errors[name] && <span className="field-error">{errors[name]}</span>}
		</label>
	);

	return (
		<main className="popup">
			<form className="stack" onSubmit={save} noValidate>
				<Brand />
				<h1>Connect to Tracera</h1>
				{field("api_url", "API URL", { type: "url", required: true })}
				{field("web_url", "Web app URL (for links to investigations)", {
					type: "url",
					required: true,
				})}
				{field("token", "Personal access token", {
					type: "password",
					autoComplete: "off",
					spellCheck: false,
					required: !current,
					placeholder: current
						? "Saved. Paste a new token to replace it."
						: "trc_pat_…",
				})}
				<p className="small muted">
					Create the token in Tracera with <code>client_kind</code>{" "}
					<code>extension</code> and the scopes{" "}
					{RECOMMENDED_SCOPES.map((scope, index) => (
						<span key={scope}>
							<code>{scope}</code>
							{index < RECOMMENDED_SCOPES.length - 1 ? ", " : "."}
						</span>
					))}{" "}
					It is stored only in this browser profile and sent only to the API URL
					above.
				</p>
				{problem && <p className="alert alert-error small">{problem}</p>}
				<div className="row">
					<button type="submit" className="btn btn-primary" disabled={busy}>
						{busy ? "Checking the token…" : "Check and save"}
					</button>
					{onCancel && (
						<button type="button" className="btn btn-quiet" onClick={onCancel}>
							Cancel
						</button>
					)}
				</div>
			</form>
		</main>
	);
}

type Recording = { active: boolean; entries: number };

function CaptureScreen({
	settings,
	onSettings,
	onForget,
}: {
	settings: Settings;
	onSettings: () => void;
	onForget: () => void;
}) {
	const [tab, setTab] = useState<Tab | null>(null);
	const [recording, setRecording] = useState<Recording | null>(null);
	const [optIn, setOptIn] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const tabId = tab?.id;
	const capturable = !tab?.url || /^https?:/.test(tab.url);

	useEffect(() => {
		chromeApi()
			.tabs.query({ active: true, currentWindow: true })
			.then(([active]) => setTab(active ?? null));
	}, []);
	useEffect(() => {
		if (tabId === undefined || !capturable) return;
		void sendCommand(
			{ type: "tracera:console-status", tab_id: tabId },
			ConsoleStatusSchema,
		).then((status) => setRecording(status.ok ? status : null));
	}, [tabId, capturable]);

	async function capture(mode: "visible" | "region") {
		if (tabId === undefined) return;
		setBusy(true);
		setError(null);
		const result = await sendCommand(
			{ type: "tracera:capture", tab_id: tabId, mode },
			OkSchema,
		);
		if (!result.ok) {
			setBusy(false);
			setError(result.error);
			return;
		}
		window.close(); // the region overlay or the editor tab takes over
	}

	async function startRecording() {
		if (tabId === undefined) return;
		setError(null);
		const result = await sendCommand(
			{ type: "tracera:console-start", tab_id: tabId },
			ConsoleStatusSchema,
		);
		if (result.ok) setRecording(result);
		else setError(result.error);
	}

	return (
		<main className="popup stack">
			<Brand>
				<button type="button" className="btn btn-quiet" onClick={onSettings}>
					Settings
				</button>
			</Brand>
			<div className="stack-tight">
				<h1>Report a bug on this page</h1>
				{tab?.title && <p className="secondary truncate">{tab.title}</p>}
				{tab?.url && capturable && (
					<p className="small muted truncate">{new URL(tab.url).host}</p>
				)}
			</div>
			{!capturable ? (
				<p className="alert alert-info small">
					Tracera captures web pages (http and https). Chrome keeps extensions
					out of its own pages and the Chrome Web Store.
				</p>
			) : (
				<>
					<div className="stack-tight">
						<button
							type="button"
							className="btn btn-primary btn-block"
							disabled={busy || tabId === undefined}
							onClick={() => capture("visible")}
						>
							Capture the visible area
						</button>
						<button
							type="button"
							className="btn btn-block"
							disabled={busy || tabId === undefined}
							onClick={() => capture("region")}
						>
							Select a region
						</button>
						<p className="small muted">
							You can mark and black out parts of the screenshot, then review
							everything before it is sent.
						</p>
					</div>
					<section className="card stack-tight" aria-labelledby="diagnostics">
						<h2 id="diagnostics">Console diagnostics (optional)</h2>
						{recording?.active ? (
							<p className="small secondary row">
								<span className="status status-warning">
									<span className="live-dot" aria-hidden="true" />
									Recording
								</span>
								{recording.entries} message(s) so far. Reproduce the problem,
								then capture.
							</p>
						) : (
							<>
								<label className="check small">
									<input
										type="checkbox"
										checked={optIn}
										onChange={(event) => setOptIn(event.currentTarget.checked)}
									/>
									<span>
										Record this tab's console errors and warnings from now until
										I capture: at most 10 minutes or 200 messages, and never
										after the page navigates. The page writes these messages; I
										review them before anything is sent.
									</span>
								</label>
								<button
									type="button"
									className="btn"
									disabled={!optIn || tabId === undefined}
									onClick={startRecording}
								>
									Start recording
								</button>
							</>
						)}
					</section>
				</>
			)}
			{error && <p className="alert alert-error small">{error}</p>}
			<footer className="stack-tight small muted">
				<span className="truncate">Sends to {settings.api_url}</span>
				<button type="button" className="btn btn-quiet" onClick={onForget}>
					Withdraw consent and forget the token
				</button>
			</footer>
		</main>
	);
}

function Popup() {
	const [state, setState] = useState<ExtensionState | null>(null);
	const [editing, setEditing] = useState(false);
	const storage = chromeApi().storage.local;
	const reload = () => loadState(storage).then(setState);
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once when the popup opens
	useEffect(() => {
		void reload();
	}, []);

	if (!state) return null;
	if (state.step === "consent")
		return (
			<Consent
				onAgree={async () => {
					await acceptConsent(storage);
					await reload();
				}}
			/>
		);
	if (state.step === "settings" || editing)
		return (
			<SettingsForm
				current={state.step === "ready" ? state.settings : null}
				onDone={async () => {
					setEditing(false);
					await reload();
				}}
				onCancel={state.step === "ready" ? () => setEditing(false) : undefined}
			/>
		);
	return (
		<CaptureScreen
			settings={state.settings}
			onSettings={() => setEditing(true)}
			onForget={async () => {
				await forgetAll(storage);
				await reload();
			}}
		/>
	);
}

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<Popup />
		</StrictMode>,
	);
