// @vitest-environment jsdom
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import {
	CONSOLE_LIMITS,
	ConsoleCaptureSchema,
	PageInfoSchema,
	RegionMessageSchema,
} from "../src/messages.ts";
import {
	collectConsole,
	installConsoleRecorder,
	readPageInfo,
	selectRegion,
} from "../src/page-scripts.ts";

/**
 * Chrome serializes an injected function with toString() and runs it in the page. Re-creating each one
 * from its source text, outside this module, fails with a ReferenceError if it uses anything it does
 * not define itself.
 */
const isolated = <F>(fn: F): F => new Function(`return (${String(fn)})`)() as F;

const NONCE = "0123456789abcdef0123456789abcdef";
const sent: unknown[] = [];

beforeEach(() => {
	sent.length = 0;
	(globalThis as unknown as { chrome: unknown }).chrome = {
		runtime: {
			sendMessage: async (message: unknown) => {
				sent.push(message);
			},
		},
	};
});
afterEach(() => {
	delete (globalThis as { chrome?: unknown }).chrome;
	document.getElementById("tracera-region-selector")?.remove();
	vi.useRealTimers();
});

describe("readPageInfo", () => {
	it("reports the viewport and pixel ratio in the validated shape", () => {
		expect(PageInfoSchema.parse(isolated(readPageInfo)())).toEqual({
			viewport: { width: window.innerWidth, height: window.innerHeight },
			device_pixel_ratio: window.devicePixelRatio,
		});
	});
});

describe("selectRegion", () => {
	const host = () => document.getElementById("tracera-region-selector");
	const fire = (type: string, x: number, y: number) =>
		host()?.dispatchEvent(
			new PointerEvent(type, {
				clientX: x,
				clientY: y,
				bubbles: true,
				pointerId: 1,
			}),
		);

	it("removes its overlay, then reports the dragged region in any direction", async () => {
		isolated(selectRegion)(NONCE, "Drag to select");
		expect(host()).not.toBeNull();
		fire("pointerdown", 300, 150);
		fire("pointermove", 200, 100);
		fire("pointerup", 100, 50);
		expect(host()).toBeNull();
		expect(sent).toEqual([]); // waits two frames so the overlay is gone from the screen
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(RegionMessageSchema.parse(sent[0])).toEqual({
			type: "tracera:region-selected",
			nonce: NONCE,
			rect: { x: 100, y: 50, width: 200, height: 100 },
			viewport: { width: window.innerWidth, height: window.innerHeight },
			device_pixel_ratio: window.devicePixelRatio,
		});
	});

	it("ignores a click without a drag and cancels on Escape", async () => {
		isolated(selectRegion)(NONCE, "Drag to select");
		fire("pointerdown", 40, 40);
		fire("pointerup", 42, 41);
		expect(host()).not.toBeNull();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(host()).toBeNull();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toEqual({ type: "tracera:region-cancelled", nonce: NONCE });
	});

	it("keeps the selection inside the viewport", async () => {
		isolated(selectRegion)(NONCE, "Drag to select");
		fire("pointerdown", 900, 700);
		fire("pointerup", 5000, 5000);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(RegionMessageSchema.parse(sent[0])).toMatchObject({
			rect: {
				x: 900,
				y: 700,
				width: window.innerWidth - 900,
				height: window.innerHeight - 700,
			},
		});
	});
});

describe("console recorder (opt-in diagnostics)", () => {
	let pageError: Mock<typeof console.error>;
	let pageWarn: Mock<typeof console.warn>;
	const saved = { error: console.error, warn: console.warn };
	beforeEach(() => {
		pageError = vi.fn<typeof console.error>();
		pageWarn = vi.fn<typeof console.warn>();
		console.error = pageError;
		console.warn = pageWarn;
	});
	afterEach(() => {
		isolated(collectConsole)(true);
		console.error = saved.error;
		console.warn = saved.warn;
	});

	it("records only what happens after it starts, within its limits, and still logs for the page", () => {
		console.error("before recording");
		expect(
			isolated(installConsoleRecorder)({
				...CONSOLE_LIMITS,
				entries: 4,
				messageChars: 30,
			}),
		).toBe(true);
		console.error("Failed:", new TypeError("total is undefined"));
		console.warn({ retry: 2 });
		window.dispatchEvent(
			new ErrorEvent("error", {
				message: "x is not defined",
				filename: "https://shop.example/app.js",
				lineno: 3,
				colno: 7,
			}),
		);
		window.dispatchEvent(
			new PromiseRejectionEvent("unhandledrejection", {
				promise: Promise.resolve(),
				reason: "timeout",
			}),
		);
		console.error("over the entry limit");

		const capture = ConsoleCaptureSchema.parse(isolated(collectConsole)(false));
		expect(capture.active).toBe(true);
		expect(
			capture.entries.map((entry) => [
				entry.level,
				entry.message,
				entry.source,
			]),
		).toEqual([
			["error", "Failed: TypeError: total is un", null], // cut at 30 characters
			["warning", '{"retry":2}', null],
			["error", "Uncaught x is not defined", "https://shop.example/app.js:3:7"],
			["error", "Unhandled rejection: timeout", null],
		]);
		expect(pageError).toHaveBeenCalledWith("Failed:", expect.any(TypeError));
		expect(pageWarn).toHaveBeenCalledWith({ retry: 2 });
	});

	it("collecting with stop ends the recording, restores the console, and removes the recorder", () => {
		isolated(installConsoleRecorder)(CONSOLE_LIMITS);
		expect(console.error).not.toBe(pageError);
		console.error("one");
		const capture = ConsoleCaptureSchema.parse(isolated(collectConsole)(true));
		expect(capture.entries).toHaveLength(1);
		expect(console.error).toBe(pageError);
		expect(console.warn).toBe(pageWarn);
		expect(isolated(collectConsole)(false)).toBeNull();
	});

	it("stops by itself after its time limit and does not start twice", () => {
		vi.useFakeTimers();
		const install = isolated(installConsoleRecorder);
		install({ ...CONSOLE_LIMITS, durationMs: 1000 });
		const wrapped = console.error;
		install({ ...CONSOLE_LIMITS, durationMs: 1000 });
		expect(console.error).toBe(wrapped); // the running recorder is kept
		vi.advanceTimersByTime(1001);
		console.error("too late");
		const capture = ConsoleCaptureSchema.parse(isolated(collectConsole)(false));
		expect(capture).toMatchObject({ active: false, entries: [] });
		expect(console.error).toBe(pageError);
	});
});
