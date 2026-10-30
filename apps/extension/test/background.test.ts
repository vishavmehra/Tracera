import { describe, expect, it, vi } from "vitest";
import { createBackground } from "../src/background.ts";
import type { ChromeApi, MessageSender } from "../src/chrome.ts";
import {
	acceptRegionMessage,
	CaptureResultSchema,
	CONSOLE_LIMITS,
	isExtensionPage,
	type PendingRegion,
} from "../src/messages.ts";
import {
	collectConsole,
	installConsoleRecorder,
	readPageInfo,
	selectRegion,
} from "../src/page-scripts.ts";
import { memoryStorage } from "./fakes.ts";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${RUNTIME_ID}/`;
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";
const NONCE = "0123456789abcdef0123456789abcdef";
const POPUP: MessageSender = { id: RUNTIME_ID, url: `${ORIGIN}popup.html` };
const EDITOR: MessageSender = {
	id: RUNTIME_ID,
	url: `${ORIGIN}editor.html#x`,
	tab: { id: 99, windowId: 1 },
};
const page = (overrides: Partial<MessageSender> = {}): MessageSender => ({
	id: RUNTIME_ID,
	url: "https://shop.example/dashboard",
	frameId: 0,
	tab: { id: 7, windowId: 1 },
	...overrides,
});
const RECORDED = {
	active: true,
	started_at: "2026-10-25T09:59:00.000Z",
	entries: [
		{
			level: "error",
			message: "TypeError: x",
			source: null,
			at: "2026-10-25T09:59:30.000Z",
		},
	],
};

type Injection = {
	func: unknown;
	args: unknown[];
	world: string;
	tabId: number;
};

function fakeChrome(options: { console?: unknown; blocked?: boolean } = {}) {
	const injections: Injection[] = [];
	const opened: string[] = [];
	const captures: number[] = [];
	const badges = new Map<number, string>();
	const session = memoryStorage();
	const chrome = {
		runtime: {
			id: RUNTIME_ID,
			getURL: (path: string) => `${ORIGIN}${path}`,
			sendMessage: async () => undefined,
			onMessage: { addListener() {} },
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
		},
		tabs: {
			query: async () => [],
			get: async (tabId: number) => ({
				id: tabId,
				windowId: 1,
				url: "https://shop.example/dashboard?session=abc",
				title: "Dashboard",
			}),
			create: async ({ url }: { url: string }) => {
				opened.push(url);
				return { id: 99, windowId: 1 };
			},
			captureVisibleTab: async (windowId: number) => {
				if (options.blocked) throw new Error("Cannot access contents of url");
				captures.push(windowId);
				return IMAGE;
			},
			onUpdated: { addListener() {} },
		},
		scripting: {
			executeScript: async (injection: {
				target: { tabId: number };
				world?: string;
				func: unknown;
				args?: unknown[];
			}) => {
				injections.push({
					func: injection.func,
					args: injection.args ?? [],
					world: injection.world ?? "ISOLATED",
					tabId: injection.target.tabId,
				});
				if (injection.func === readPageInfo)
					return [
						{
							frameId: 0,
							result: {
								viewport: { width: 1280, height: 720 },
								device_pixel_ratio: 2,
							},
						},
					];
				if (injection.func === collectConsole)
					return [{ frameId: 0, result: options.console ?? null }];
				return [{ frameId: 0, result: true }];
			},
		},
		storage: { local: memoryStorage(), session },
		action: {
			setBadgeText: async ({
				tabId,
				text,
			}: {
				tabId: number;
				text: string;
			}) => {
				badges.set(tabId, text);
			},
			setBadgeBackgroundColor: async () => {},
		},
	} as unknown as ChromeApi;
	return { chrome, injections, opened, captures, badges, session };
}

/** Delivers a message as Chrome does and resolves with the answer, or undefined when there is none. */
function deliver(
	background: ReturnType<typeof createBackground>,
	message: unknown,
	sender: MessageSender,
): Promise<unknown> {
	return new Promise((resolve) => {
		let answered = false;
		const open = background.onMessage(message, sender, (response) => {
			answered = true;
			resolve(response);
		});
		if (!open && !answered) resolve(undefined);
	});
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const captureId = (url: string | undefined) => url?.split("#")[1] ?? "";

describe("acceptRegionMessage (untrusted page data)", () => {
	const pending: PendingRegion = { tab_id: 7, nonce: NONCE, expires_at: 1000 };
	const selected = {
		type: "tracera:region-selected",
		nonce: NONCE,
		rect: { x: 10, y: 20, width: 300, height: 200 },
		viewport: { width: 1280, height: 720 },
		device_pixel_ratio: 2,
	};
	it("accepts the selection it started", () => {
		expect(
			acceptRegionMessage(selected, page(), RUNTIME_ID, pending, 999),
		).toEqual(selected);
		expect(
			acceptRegionMessage(
				{ type: "tracera:region-cancelled", nonce: NONCE },
				page(),
				RUNTIME_ID,
				pending,
				999,
			),
		).toMatchObject({ type: "tracera:region-cancelled" });
	});
	it.each([
		["no selection was started", selected, page(), null, 999],
		["after the selection expired", selected, page(), pending, 1001],
		[
			"from another tab",
			selected,
			page({ tab: { id: 8, windowId: 1 } }),
			pending,
			999,
		],
		["from a subframe", selected, page({ frameId: 3 }), pending, 999],
		["from another extension", selected, page({ id: "other" }), pending, 999],
		[
			"with another nonce",
			{ ...selected, nonce: "f".repeat(32) },
			page(),
			pending,
			999,
		],
		[
			"with an extra field",
			{ ...selected, cookies: "a=b" },
			page(),
			pending,
			999,
		],
		[
			"with a rectangle outside the viewport",
			{ ...selected, rect: { x: 1200, y: 0, width: 300, height: 10 } },
			page(),
			pending,
			999,
		],
		[
			"with a non-finite value",
			{ ...selected, device_pixel_ratio: Number.POSITIVE_INFINITY },
			page(),
			pending,
			999,
		],
		[
			"with an unknown type",
			{ ...selected, type: "tracera:capture" },
			page(),
			pending,
			999,
		],
	])("rejects a message %s", (_, message, sender, current, now) => {
		expect(
			acceptRegionMessage(message, sender, RUNTIME_ID, current, now),
		).toBeNull();
	});
});

describe("isExtensionPage", () => {
	it("recognizes only this extension's own pages", () => {
		expect(isExtensionPage(POPUP, RUNTIME_ID, ORIGIN)).toBe(true);
		expect(isExtensionPage(EDITOR, RUNTIME_ID, ORIGIN)).toBe(true);
		expect(isExtensionPage(page(), RUNTIME_ID, ORIGIN)).toBe(false);
		expect(isExtensionPage({ ...POPUP, id: "other" }, RUNTIME_ID, ORIGIN)).toBe(
			false,
		);
		expect(isExtensionPage({ id: RUNTIME_ID }, RUNTIME_ID, ORIGIN)).toBe(false);
	});
});

describe("service worker", () => {
	it("acts on commands only from the extension's own pages", async () => {
		const fake = fakeChrome();
		const background = createBackground(fake.chrome);
		const command = { type: "tracera:capture", tab_id: 7, mode: "visible" };
		expect(await deliver(background, command, page())).toBeUndefined();
		await settle();
		expect(fake.captures).toEqual([]);
		expect(
			await deliver(background, { type: "tracera:read-token" }, POPUP),
		).toEqual({
			ok: false,
			error: "Unknown command.",
		});
	});

	it("captures the visible area and hands the screenshot to the editor tab exactly once", async () => {
		const fake = fakeChrome();
		const background = createBackground(fake.chrome, () =>
			Date.parse("2026-10-25T10:00:00.000Z"),
		);
		expect(
			await deliver(
				background,
				{ type: "tracera:capture", tab_id: 7, mode: "visible" },
				POPUP,
			),
		).toEqual({ ok: true });
		expect(fake.captures).toEqual([1]);
		expect(fake.opened).toHaveLength(1);
		expect(fake.opened[0]).toMatch(
			new RegExp(`^${ORIGIN}editor\\.html#[0-9a-f]{32}$`),
		);
		const take = {
			type: "tracera:take-capture",
			capture_id: captureId(fake.opened[0]),
		};
		const result = CaptureResultSchema.parse(
			await deliver(background, take, EDITOR),
		);
		expect(result).toEqual({
			ok: true,
			capture: {
				id: take.capture_id,
				captured_at: "2026-10-25T10:00:00.000Z",
				image: IMAGE,
				region: null,
				page: {
					url: "https://shop.example/dashboard?session=abc",
					title: "Dashboard",
					viewport: { width: 1280, height: 720 },
					device_pixel_ratio: 2,
				},
				console: null,
				notes: [],
			},
		});
		expect(await deliver(background, take, EDITOR)).toMatchObject({
			ok: false,
		});
		expect(background.captures.size).toBe(0);
	});

	it("opens the editor with an explanation when Chrome refuses to capture the tab", async () => {
		const fake = fakeChrome({ blocked: true });
		const background = createBackground(fake.chrome);
		await deliver(
			background,
			{ type: "tracera:capture", tab_id: 7, mode: "visible" },
			POPUP,
		);
		const result = await deliver(
			background,
			{ type: "tracera:take-capture", capture_id: captureId(fake.opened[0]) },
			EDITOR,
		);
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("cannot be captured"),
		});
	});

	it("captures a region only for the selection it started, once", async () => {
		let now = 1_000;
		const fake = fakeChrome();
		const background = createBackground(fake.chrome, () => now);
		await deliver(
			background,
			{ type: "tracera:capture", tab_id: 7, mode: "region" },
			POPUP,
		);
		const injected = fake.injections.find(
			(injection) => injection.func === selectRegion,
		);
		const [nonce] = (injected?.args ?? []) as [string];
		expect(nonce).toMatch(/^[0-9a-f]{32}$/);
		expect(fake.session.items.pending_region).toMatchObject({
			tab_id: 7,
			nonce,
		});
		const message = {
			type: "tracera:region-selected",
			nonce,
			rect: { x: 10, y: 20, width: 300, height: 200 },
			viewport: { width: 1280, height: 720 },
			device_pixel_ratio: 2,
		};

		for (const [forged, sender] of [
			[{ ...message, nonce: "f".repeat(32) }, page()],
			[message, page({ tab: { id: 8, windowId: 1 } })],
			[message, page({ frameId: 2 })],
		] as const)
			expect(await deliver(background, forged, sender)).toBeUndefined();
		await settle();
		expect(fake.captures).toEqual([]);

		await deliver(background, message, page());
		await vi.waitFor(() => expect(fake.opened).toHaveLength(1));
		const result = CaptureResultSchema.parse(
			await deliver(
				background,
				{ type: "tracera:take-capture", capture_id: captureId(fake.opened[0]) },
				EDITOR,
			),
		);
		expect(result.ok && result.capture.region).toEqual({
			rect: message.rect,
			viewport: message.viewport,
		});
		expect(fake.session.items.pending_region).toBeUndefined();

		await deliver(background, message, page()); // replayed
		now += 10 * 60 * 1000;
		await settle();
		expect(fake.captures).toEqual([1]);
	});

	it("records the console only after opt-in, shows a badge, and stops when capturing", async () => {
		const fake = fakeChrome({ console: RECORDED });
		const background = createBackground(fake.chrome);
		expect(
			await deliver(
				background,
				{ type: "tracera:console-start", tab_id: 7 },
				POPUP,
			),
		).toEqual({ ok: true, active: true, entries: 0 });
		expect(fake.injections).toEqual([
			{
				func: installConsoleRecorder,
				args: [CONSOLE_LIMITS],
				world: "MAIN",
				tabId: 7,
			},
		]);
		expect(fake.badges.get(7)).toBe("REC");
		expect(
			await deliver(
				background,
				{ type: "tracera:console-status", tab_id: 7 },
				POPUP,
			),
		).toEqual({ ok: true, active: true, entries: 1 });

		await deliver(
			background,
			{ type: "tracera:capture", tab_id: 7, mode: "visible" },
			POPUP,
		);
		expect(
			fake.injections
				.filter((injection) => injection.func === collectConsole)
				.at(-1),
		).toMatchObject({ args: [true], world: "MAIN" });
		expect(fake.badges.get(7)).toBe("");
		expect(fake.session.items.console_tabs).toEqual([]);
		const result = CaptureResultSchema.parse(
			await deliver(
				background,
				{ type: "tracera:take-capture", capture_id: captureId(fake.opened[0]) },
				EDITOR,
			),
		);
		expect(result.ok && result.capture.console).toEqual(RECORDED);
	});

	it("never reads the console without a recording, and leaves out malformed page data with a note", async () => {
		const quiet = fakeChrome({ console: RECORDED });
		await deliver(
			createBackground(quiet.chrome),
			{ type: "tracera:capture", tab_id: 7, mode: "visible" },
			POPUP,
		);
		expect(
			quiet.injections.some((injection) => injection.func === collectConsole),
		).toBe(false);

		const tampered = fakeChrome({
			console: {
				...RECORDED,
				entries: [{ ...RECORDED.entries[0], extra: "<img src=x>" }],
			},
		});
		const background = createBackground(tampered.chrome);
		await deliver(
			background,
			{ type: "tracera:console-start", tab_id: 7 },
			POPUP,
		);
		await deliver(
			background,
			{ type: "tracera:capture", tab_id: 7, mode: "visible" },
			POPUP,
		);
		const result = CaptureResultSchema.parse(
			await deliver(
				background,
				{
					type: "tracera:take-capture",
					capture_id: captureId(tampered.opened[0]),
				},
				EDITOR,
			),
		);
		expect(result.ok && result.capture.console).toBeNull();
		expect(result.ok && result.capture.notes.join(" ")).toContain(
			"Console messages were left out",
		);
	});

	it("clears the badge when a navigation ends the page's recorder", async () => {
		const fake = fakeChrome({ console: null });
		const background = createBackground(fake.chrome);
		await deliver(
			background,
			{ type: "tracera:console-start", tab_id: 7 },
			POPUP,
		);
		await background.onTabUpdated(7, { status: "complete" });
		expect(fake.badges.get(7)).toBe("REC");
		await background.onTabUpdated(7, { status: "loading" });
		expect(fake.badges.get(7)).toBe("");
		expect(fake.session.items.console_tabs).toEqual([]);
	});
});
