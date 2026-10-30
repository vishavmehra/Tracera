import { z } from "zod";
import { chromeApi, type MessageSender } from "./chrome.ts";

// Messages between the extension's own pages, its service worker, and the scripts it injects into a tab.
// Page-originated data (the region selector's message, page info, console records) is untrusted: it is
// checked here before the service worker acts on it or stores it.

export const CONSOLE_LIMITS = {
	entries: 200,
	messageChars: 2000,
	sourceChars: 2048,
	durationMs: 10 * 60 * 1000,
} as const;

const Nonce = z.string().regex(/^[0-9a-f]{32}$/);
const TabId = z.number().int().min(0);
const Viewport = z.strictObject({
	width: z.number().int().min(1).max(20_000),
	height: z.number().int().min(1).max(20_000),
});
const PixelRatio = z.number().min(0.1).max(10);
const CssRect = z.strictObject({
	x: z.number().min(0).max(20_000),
	y: z.number().min(0).max(20_000),
	width: z.number().min(1).max(20_000),
	height: z.number().min(1).max(20_000),
});

export const PageInfoSchema = z.strictObject({
	viewport: Viewport,
	device_pixel_ratio: PixelRatio,
});

export const ConsoleCaptureSchema = z.strictObject({
	active: z.boolean(),
	started_at: z.iso.datetime(),
	entries: z
		.array(
			z.strictObject({
				level: z.enum(["error", "warning"]),
				message: z.string().max(CONSOLE_LIMITS.messageChars),
				source: z.string().max(CONSOLE_LIMITS.sourceChars).nullable(),
				at: z.iso.datetime(),
			}),
		)
		.max(CONSOLE_LIMITS.entries),
});

export const RegionMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("tracera:region-selected"),
		nonce: Nonce,
		rect: CssRect,
		viewport: Viewport,
		device_pixel_ratio: PixelRatio,
	}),
	z.strictObject({ type: z.literal("tracera:region-cancelled"), nonce: Nonce }),
]);

/** Commands from the popup and the editor page to the service worker. */
export const CommandSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("tracera:capture"),
		tab_id: TabId,
		mode: z.enum(["visible", "region"]),
	}),
	z.strictObject({ type: z.literal("tracera:console-start"), tab_id: TabId }),
	z.strictObject({ type: z.literal("tracera:console-status"), tab_id: TabId }),
	z.strictObject({
		type: z.literal("tracera:take-capture"),
		capture_id: Nonce,
	}),
]);

export const CaptureSchema = z.strictObject({
	id: Nonce,
	captured_at: z.iso.datetime(),
	image: z.string().startsWith("data:image/png;base64,"),
	/** The selected region in CSS pixels of the viewport it was drawn on; null for the visible area. */
	region: z.strictObject({ rect: CssRect, viewport: Viewport }).nullable(),
	page: z.strictObject({
		url: z.string().max(8192).nullable(),
		title: z.string().max(2000).nullable(),
		viewport: Viewport.nullable(),
		device_pixel_ratio: PixelRatio.nullable(),
	}),
	console: ConsoleCaptureSchema.nullable(),
	/** Things the user should know about this capture, such as diagnostics that could not be read. */
	notes: z.array(z.string().max(500)).max(10),
});

export const CaptureResultSchema = z.discriminatedUnion("ok", [
	z.strictObject({ ok: z.literal(true), capture: CaptureSchema }),
	z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export const ConsoleStatusSchema = z.strictObject({
	ok: z.literal(true),
	active: z.boolean(),
	entries: z.number().int().min(0),
});
const CommandFailureSchema = z.strictObject({
	ok: z.literal(false),
	error: z.string(),
});

export type Command = z.infer<typeof CommandSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type CaptureResult = z.infer<typeof CaptureResultSchema>;
export type ConsoleCapture = z.infer<typeof ConsoleCaptureSchema>;
export type RegionMessage = z.infer<typeof RegionMessageSchema>;
export type PendingRegion = {
	tab_id: number;
	nonce: string;
	expires_at: number;
};

/** True for the extension's own pages (popup, editor); content scripts report the page's URL instead. */
export function isExtensionPage(
	sender: MessageSender,
	runtimeId: string,
	extensionOrigin: string,
): boolean {
	return (
		sender.id === runtimeId &&
		typeof sender.url === "string" &&
		sender.url.startsWith(extensionOrigin)
	);
}

/**
 * Accepts a region-selector message only from the top frame of the tab where this selection was started,
 * with that selection's nonce, before it expires, and with a rectangle inside the reported viewport.
 */
export function acceptRegionMessage(
	message: unknown,
	sender: MessageSender,
	runtimeId: string,
	pending: PendingRegion | null,
	now: number,
): RegionMessage | null {
	if (
		!pending ||
		sender.id !== runtimeId ||
		sender.frameId !== 0 ||
		sender.tab?.id !== pending.tab_id ||
		now > pending.expires_at
	)
		return null;
	const parsed = RegionMessageSchema.safeParse(message);
	if (!parsed.success || parsed.data.nonce !== pending.nonce) return null;
	if (parsed.data.type === "tracera:region-selected") {
		const { rect, viewport } = parsed.data;
		if (
			rect.x + rect.width > viewport.width + 1 ||
			rect.y + rect.height > viewport.height + 1
		)
			return null;
	}
	return parsed.data;
}

/** Sends a command to the service worker and validates the answer against the expected shape. */
export async function sendCommand<T>(
	command: Command,
	response: z.ZodType<T>,
): Promise<T | { ok: false; error: string }> {
	const answer = await chromeApi()
		.runtime.sendMessage(command)
		.catch((error: unknown) => ({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}));
	const failure = CommandFailureSchema.safeParse(answer);
	if (failure.success) return failure.data;
	const parsed = response.safeParse(answer);
	return parsed.success
		? parsed.data
		: {
				ok: false,
				error: "The extension's background worker gave no usable answer.",
			};
}

export const OkSchema = z.strictObject({ ok: z.literal(true) });
