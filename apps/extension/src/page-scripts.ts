// Functions injected into the captured tab with chrome.scripting.executeScript({ func }). Chrome serializes
// each one with toString(), so each must be self-contained: no imports, no outer variables, and only
// structured-clonable return values. Whatever they return is page data and is validated (messages.ts).

/** ISOLATED world: the viewport in CSS pixels and the device pixel ratio (browser zoom included). */
export function readPageInfo() {
	return {
		viewport: { width: window.innerWidth, height: window.innerHeight },
		device_pixel_ratio: window.devicePixelRatio,
	};
}

/**
 * ISOLATED world: a full-viewport overlay on which the user drags the region to capture (Esc cancels).
 * The overlay is removed, and two frames are painted, before the selection is reported, so it never
 * appears in the screenshot. Styles are set through CSSOM so a strict page CSP cannot block them.
 */
export function selectRegion(nonce: string, hint: string): void {
	const runtime = (
		globalThis as unknown as {
			chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
		}
	).chrome.runtime;
	const HOST_ID = "tracera-region-selector";
	document.getElementById(HOST_ID)?.remove();
	const host = document.createElement("div");
	host.id = HOST_ID;
	Object.assign(host.style, {
		position: "fixed",
		inset: "0",
		zIndex: "2147483647",
		cursor: "crosshair",
	});
	const root = host.attachShadow({ mode: "closed" });
	const veil = document.createElement("div");
	Object.assign(veil.style, {
		position: "absolute",
		inset: "0",
		background: "rgba(0, 5, 13, 0.35)",
		touchAction: "none",
	});
	const box = document.createElement("div");
	Object.assign(box.style, {
		position: "absolute",
		display: "none",
		border: "2px solid #c46ea1",
		background: "rgba(196, 110, 161, 0.15)",
		pointerEvents: "none",
	});
	const label = document.createElement("div");
	label.textContent = hint;
	Object.assign(label.style, {
		position: "absolute",
		top: "16px",
		left: "50%",
		transform: "translateX(-50%)",
		padding: "8px 14px",
		borderRadius: "6px",
		background: "#18203c",
		color: "#f2f0f5",
		font: "13px/1.4 system-ui, sans-serif",
		pointerEvents: "none",
	});
	root.append(veil, box, label);

	let start: { x: number; y: number } | null = null;
	const rectTo = (event: MouseEvent) => {
		const from = start ?? { x: event.clientX, y: event.clientY };
		const x = Math.max(0, Math.min(from.x, event.clientX));
		const y = Math.max(0, Math.min(from.y, event.clientY));
		return {
			x,
			y,
			width: Math.min(window.innerWidth, Math.max(from.x, event.clientX)) - x,
			height: Math.min(window.innerHeight, Math.max(from.y, event.clientY)) - y,
		};
	};
	const finish = (message: Record<string, unknown>) => {
		removeEventListener("keydown", onKey, true);
		host.remove();
		requestAnimationFrame(() =>
			requestAnimationFrame(() =>
				setTimeout(() => {
					runtime.sendMessage(message).catch(() => undefined);
				}, 30),
			),
		);
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		finish({ type: "tracera:region-cancelled", nonce });
	};
	// Pointer events are composed, so the host hears drags on the veil inside its closed shadow root.
	host.addEventListener("pointerdown", (event) => {
		start = { x: event.clientX, y: event.clientY };
		try {
			host.setPointerCapture(event.pointerId);
		} catch {
			// Not every environment supports pointer capture; dragging still works without it.
		}
	});
	host.addEventListener("pointermove", (event) => {
		if (!start) return;
		const rect = rectTo(event);
		Object.assign(box.style, {
			display: "block",
			left: `${rect.x}px`,
			top: `${rect.y}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
	});
	host.addEventListener("pointerup", (event) => {
		if (!start) return;
		const rect = rectTo(event);
		start = null;
		if (rect.width < 8 || rect.height < 8) {
			box.style.display = "none";
			return;
		}
		finish({
			type: "tracera:region-selected",
			nonce,
			rect,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			device_pixel_ratio: window.devicePixelRatio,
		});
	});
	addEventListener("keydown", onKey, true);
	document.documentElement.append(host);
}

/**
 * MAIN world: from now on (nothing earlier), records console errors and warnings, uncaught errors, and
 * unhandled rejections, bounded in count and length, and stops by itself after `limits.durationMs`. It
 * runs among the page's scripts, which can read or alter what it records: the result is page-reported.
 */
export function installConsoleRecorder(limits: {
	entries: number;
	messageChars: number;
	sourceChars: number;
	durationMs: number;
}): boolean {
	const key = Symbol.for("tracera.console-recorder");
	const scope = window as unknown as Record<symbol, { active: boolean }>;
	if (scope[key]?.active) return true;
	type Entry = {
		level: "error" | "warning";
		message: string;
		source: string | null;
		at: string;
	};
	const entries: Entry[] = [];
	const original = { error: console.error, warn: console.warn };
	const text = (values: unknown[]) =>
		values
			.map((value) => {
				if (value instanceof Error) return `${value.name}: ${value.message}`;
				if (typeof value === "string") return value;
				try {
					return JSON.stringify(value) ?? String(value);
				} catch {
					return String(value);
				}
			})
			.join(" ");
	const state = {
		active: true,
		started_at: new Date().toISOString(),
		entries,
		stop() {
			if (!state.active) return;
			state.active = false;
			if (console.error === ownError) console.error = original.error;
			if (console.warn === ownWarn) console.warn = original.warn;
			removeEventListener("error", onError);
			removeEventListener("unhandledrejection", onRejection);
			clearTimeout(timer);
		},
	};
	// Builds the message lazily, so a full buffer costs the page nothing.
	const record = (
		level: Entry["level"],
		message: () => string,
		source: string | null,
	) => {
		if (!state.active || entries.length >= limits.entries) return;
		entries.push({
			level,
			message: message().slice(0, limits.messageChars),
			source: source ? source.slice(0, limits.sourceChars) : null,
			at: new Date().toISOString(),
		});
	};
	const ownError = (...values: unknown[]) => {
		record("error", () => text(values), null);
		original.error.apply(console, values);
	};
	const ownWarn = (...values: unknown[]) => {
		record("warning", () => text(values), null);
		original.warn.apply(console, values);
	};
	const onError = (event: ErrorEvent) =>
		record(
			"error",
			() => `Uncaught ${event.message}`,
			event.filename
				? `${event.filename}:${event.lineno}:${event.colno}`
				: null,
		);
	const onRejection = (event: PromiseRejectionEvent) =>
		record("error", () => `Unhandled rejection: ${text([event.reason])}`, null);
	console.error = ownError;
	console.warn = ownWarn;
	addEventListener("error", onError);
	addEventListener("unhandledrejection", onRejection);
	const timer = setTimeout(() => state.stop(), limits.durationMs);
	scope[key] = state;
	return true;
}

/** MAIN world: what the recorder holds (null without one); with `stop`, also ends and removes it. */
export function collectConsole(stop: boolean) {
	const key = Symbol.for("tracera.console-recorder");
	const scope = window as unknown as Record<
		symbol,
		| { active: boolean; started_at: string; entries: unknown[]; stop(): void }
		| undefined
	>;
	const state = scope[key];
	if (!state) return null;
	const result = {
		active: state.active,
		started_at: state.started_at,
		entries: state.entries.slice(),
	};
	if (stop) {
		state.stop();
		delete scope[key];
	}
	return result;
}
