import { type ChromeApi, chromeApi, type MessageSender } from "./chrome.ts";
import {
	acceptRegionMessage,
	type Capture,
	type CaptureResult,
	CONSOLE_LIMITS,
	type Command,
	CommandSchema,
	ConsoleCaptureSchema,
	isExtensionPage,
	PageInfoSchema,
	type PendingRegion,
} from "./messages.ts";
import {
	collectConsole,
	installConsoleRecorder,
	readPageInfo,
	selectRegion,
} from "./page-scripts.ts";

const REGION_TIMEOUT_MS = 5 * 60 * 1000;
const RECORDING_BADGE = "REC";
const CAPTURE_BLOCKED =
	"This tab cannot be captured. Chrome keeps extensions out of its own pages (chrome://), the Chrome Web Store, and other extensions' pages.";

const randomHex = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * The service worker. It acts only on commands from the extension's own pages, and on region-selector
 * messages that match a selection it started. A screenshot waits in memory, never in storage, until the
 * editor tab opened for it takes it (and drops it).
 */
export function createBackground(chrome: ChromeApi, now = () => Date.now()) {
	const captures = new Map<string, CaptureResult>();
	const extensionOrigin = chrome.runtime.getURL("");

	const inject = async <Args extends unknown[], Result>(
		tabId: number,
		func: (...args: Args) => Result,
		args: Args,
		world: "ISOLATED" | "MAIN" = "ISOLATED",
	) =>
		(
			await chrome.scripting.executeScript({
				target: { tabId },
				world,
				func,
				args,
			})
		)[0]?.result;

	const recordingTabs = async (): Promise<number[]> => {
		const { console_tabs } = await chrome.storage.session.get("console_tabs");
		return Array.isArray(console_tabs)
			? console_tabs.filter((id): id is number => Number.isInteger(id))
			: [];
	};
	const setRecording = async (tabId: number, active: boolean) => {
		const others = (await recordingTabs()).filter((id) => id !== tabId);
		await chrome.storage.session.set({
			console_tabs: active ? [...others, tabId] : others,
		});
		await chrome.action.setBadgeText({
			tabId,
			text: active ? RECORDING_BADGE : "",
		});
		if (active)
			await chrome.action.setBadgeBackgroundColor({ tabId, color: "#9c2968" });
	};

	/** Reads (and, when stopping, ends) the tab's console recorder; null when there is none or it is unreadable. */
	const readConsole = async (tabId: number, stop: boolean) => {
		const raw = await inject(tabId, collectConsole, [stop], "MAIN").catch(
			() => undefined,
		);
		if (raw === null || raw === undefined)
			return { capture: null, malformed: false };
		const parsed = ConsoleCaptureSchema.safeParse(raw);
		return {
			capture: parsed.success ? parsed.data : null,
			malformed: !parsed.success,
		};
	};

	async function openEditor(id: string, result: CaptureResult) {
		captures.set(id, result);
		await chrome.tabs.create({
			url: chrome.runtime.getURL(`editor.html#${id}`),
		});
	}

	async function capture(tabId: number, region: Capture["region"]) {
		const id = randomHex();
		const captured_at = new Date(now()).toISOString();
		let image: string;
		let tab: Awaited<ReturnType<ChromeApi["tabs"]["get"]>>;
		try {
			tab = await chrome.tabs.get(tabId);
			image = await chrome.tabs.captureVisibleTab(tab.windowId, {
				format: "png",
			});
		} catch {
			await openEditor(id, { ok: false, error: CAPTURE_BLOCKED });
			return;
		}
		const notes: string[] = [];
		const info = PageInfoSchema.safeParse(
			await inject(tabId, readPageInfo, []).catch(() => undefined),
		);
		if (!info.success) notes.push("The page did not report its viewport size.");
		const recorded = (await recordingTabs()).includes(tabId);
		const log = recorded
			? await readConsole(tabId, true)
			: { capture: null, malformed: false };
		if (recorded) await setRecording(tabId, false);
		if (log.malformed)
			notes.push(
				"Console messages were left out: the page returned data in an unexpected shape.",
			);
		await openEditor(id, {
			ok: true,
			capture: {
				id,
				captured_at,
				image,
				region,
				page: {
					url: tab.url ?? null,
					title: tab.title ?? null,
					viewport: info.success ? info.data.viewport : null,
					device_pixel_ratio: info.success
						? info.data.device_pixel_ratio
						: null,
				},
				console: log.capture,
				notes,
			},
		});
	}

	async function onCommand(command: Command): Promise<unknown> {
		switch (command.type) {
			case "tracera:capture": {
				if (command.mode === "visible") {
					await capture(command.tab_id, null);
					return { ok: true };
				}
				const pending: PendingRegion = {
					tab_id: command.tab_id,
					nonce: randomHex(),
					expires_at: now() + REGION_TIMEOUT_MS,
				};
				await chrome.storage.session.set({ pending_region: pending });
				await inject(command.tab_id, selectRegion, [
					pending.nonce,
					"Drag to select the area to capture. Press Esc to cancel.",
				]);
				return { ok: true };
			}
			case "tracera:console-start":
				await inject(
					command.tab_id,
					installConsoleRecorder,
					[CONSOLE_LIMITS],
					"MAIN",
				);
				await setRecording(command.tab_id, true);
				return { ok: true, active: true, entries: 0 };
			case "tracera:console-status": {
				const { capture: log } = await readConsole(command.tab_id, false);
				return {
					ok: true,
					active: log?.active ?? false,
					entries: log?.entries.length ?? 0,
				};
			}
			case "tracera:take-capture": {
				const result = captures.get(command.capture_id);
				captures.delete(command.capture_id);
				return (
					result ?? {
						ok: false,
						error:
							"This capture is no longer available. Use the Tracera button to capture again.",
					}
				);
			}
		}
	}

	async function onRegionMessage(message: unknown, sender: MessageSender) {
		const { pending_region } =
			await chrome.storage.session.get("pending_region");
		const accepted = acceptRegionMessage(
			message,
			sender,
			chrome.runtime.id,
			(pending_region as PendingRegion | undefined) ?? null,
			now(),
		);
		if (!accepted) return;
		await chrome.storage.session.remove("pending_region");
		if (
			accepted.type === "tracera:region-selected" &&
			sender.tab?.id !== undefined
		)
			await capture(sender.tab.id, {
				rect: accepted.rect,
				viewport: accepted.viewport,
			});
	}

	return {
		captures,
		onMessage(
			message: unknown,
			sender: MessageSender,
			sendResponse: (response: unknown) => void,
		): boolean | undefined {
			if (!isExtensionPage(sender, chrome.runtime.id, extensionOrigin)) {
				void onRegionMessage(message, sender).catch(() => undefined);
				return undefined;
			}
			const command = CommandSchema.safeParse(message);
			if (!command.success) {
				sendResponse({ ok: false, error: "Unknown command." });
				return undefined;
			}
			onCommand(command.data).then(sendResponse, (error: unknown) =>
				sendResponse({ ok: false, error: messageOf(error) }),
			);
			return true; // the answer is sent asynchronously
		},
		/** A navigation ends the page's recorder; clear the badge unless the recorder survived. */
		async onTabUpdated(tabId: number, change: { status?: string }) {
			if (
				change.status !== "loading" ||
				!(await recordingTabs()).includes(tabId)
			)
				return;
			const { capture: log } = await readConsole(tabId, false);
			if (!log?.active) await setRecording(tabId, false);
		},
	};
}

const chrome = chromeApi();
if (chrome?.runtime?.id) {
	const background = createBackground(chrome);
	chrome.runtime.onMessage.addListener(background.onMessage);
	chrome.tabs.onUpdated.addListener((tabId, change) => {
		void background.onTabUpdated(tabId, change).catch(() => undefined);
	});
	// The token lives in storage.local, which Chrome exposes to content scripts by default; restrict it to
	// the extension's own pages where Chrome supports that (it may for `session` only, hence the catch).
	const restrict = () =>
		chrome.storage.local
			.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
			.catch(() => undefined);
	chrome.runtime.onInstalled.addListener(restrict);
	chrome.runtime.onStartup.addListener(restrict);
}
