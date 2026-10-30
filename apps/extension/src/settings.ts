import { z } from "zod";
import type { StorageArea } from "./chrome.ts";

declare const __TRACERA_DEFAULTS__: { api_url: string; web_url: string };

/** Build-time defaults (vite.config.ts). The API origin is also the extension's only host permission. */
export const DEFAULTS = __TRACERA_DEFAULTS__;
export const ALLOWED_API_ORIGIN = new URL(DEFAULTS.api_url).origin;

/** Bump when the consent text changes materially, so every user sees and accepts the new text. */
export const CONSENT_VERSION = 1;

/** Scopes the full extension flow needs; the `extension` token preset grants only `reports:write`. */
export const RECOMMENDED_SCOPES = [
	"reports:write",
	"repositories:read",
	"investigations:write",
	"investigations:read",
] as const;

const TOKEN_PATTERN = /^trc_pat_[0-9a-f]{64}$/;
const httpUrl = z.url({ protocol: /^https?$/ });

const ConsentSchema = z.object({
	version: z.literal(CONSENT_VERSION),
	accepted_at: z.iso.datetime(),
});
const SettingsSchema = z.object({
	api_url: httpUrl,
	web_url: httpUrl,
	token: z.string().regex(TOKEN_PATTERN),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Endpoints = Omit<Settings, "token">;
export type ExtensionState =
	| { step: "consent" }
	| { step: "settings"; endpoints: Endpoints }
	| { step: "ready"; settings: Settings };

/**
 * The UI state from raw `chrome.storage.local` contents. Storage is validated like any other input:
 * a malformed value, an older consent version, or an API URL outside the permitted origin counts as
 * absent, so a corrupted entry can never route the token anywhere else.
 */
export function deriveState(
	stored: Record<string, unknown>,
	allowedOrigin: string,
	defaults: Endpoints,
): ExtensionState {
	if (!ConsentSchema.safeParse(stored.consent).success)
		return { step: "consent" };
	const settings = SettingsSchema.safeParse(stored.settings);
	if (
		!settings.success ||
		new URL(settings.data.api_url).origin !== allowedOrigin
	)
		return { step: "settings", endpoints: defaults };
	return { step: "ready", settings: settings.data };
}

export type SettingsInput = { api_url: string; web_url: string; token: string };

export function validateSettings(
	input: SettingsInput,
	allowedOrigin: string,
):
	| { ok: true; settings: Settings }
	| { ok: false; errors: Partial<Record<keyof Settings, string>> } {
	const errors: Partial<Record<keyof Settings, string>> = {};
	const api = httpUrl.safeParse(input.api_url.trim());
	const apiUrl = api.success ? new URL(api.data) : null;
	if (!apiUrl)
		errors.api_url =
			"Enter the Tracera API URL, for example http://127.0.0.1:8787.";
	else if (apiUrl.origin !== allowedOrigin)
		errors.api_url = `This build may only connect to ${allowedOrigin}. Rebuild the extension with TRACERA_EXTENSION_DEFAULT_API_URL to use another server.`;
	else if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash)
		errors.api_url = "Remove credentials, the query string, and the fragment.";
	const web = httpUrl.safeParse(input.web_url.trim());
	if (!web.success)
		errors.web_url =
			"Enter the Tracera web app URL, for example http://127.0.0.1:5173.";
	const token = input.token.trim();
	if (!TOKEN_PATTERN.test(token))
		errors.token =
			"Paste a personal access token: trc_pat_ followed by 64 hexadecimal characters.";
	if (!apiUrl || !web.success || Object.keys(errors).length > 0)
		return { ok: false, errors };
	return {
		ok: true,
		settings: {
			api_url: `${apiUrl.origin}${apiUrl.pathname.replace(/\/+$/, "")}`,
			web_url: web.data.replace(/\/+$/, ""),
			token,
		},
	};
}

export async function loadState(storage: StorageArea): Promise<ExtensionState> {
	return deriveState(
		await storage.get(["consent", "settings"]),
		ALLOWED_API_ORIGIN,
		{ api_url: DEFAULTS.api_url, web_url: DEFAULTS.web_url },
	);
}

export const acceptConsent = (storage: StorageArea, now = new Date()) =>
	storage.set({
		consent: { version: CONSENT_VERSION, accepted_at: now.toISOString() },
	});

export const saveSettings = (storage: StorageArea, settings: Settings) =>
	storage.set({ settings });

/** Withdrawing consent also forgets the token: nothing can be sent until the user agrees again. */
export const forgetAll = (storage: StorageArea) =>
	storage.remove(["consent", "settings"]);
