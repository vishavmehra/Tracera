import { describe, expect, it } from "vitest";
import {
	ALLOWED_API_ORIGIN,
	acceptConsent,
	CONSENT_VERSION,
	deriveState,
	forgetAll,
	loadState,
	saveSettings,
	validateSettings,
} from "../src/settings.ts";
import { memoryStorage, TOKEN } from "./fakes.ts";

const ORIGIN = "http://127.0.0.1:8787";
const ENDPOINTS = { api_url: ORIGIN, web_url: "http://127.0.0.1:5173" };
const consent = {
	version: CONSENT_VERSION,
	accepted_at: "2026-10-25T10:00:00.000Z",
};
const settings = { ...ENDPOINTS, token: TOKEN };

describe("deriveState (consent and settings state machine)", () => {
	it.each([
		["nothing stored", {}, "consent"],
		[
			"an older consent version",
			{ consent: { ...consent, version: 0 }, settings },
			"consent",
		],
		[
			"a tampered consent",
			{ consent: { version: CONSENT_VERSION }, settings },
			"consent",
		],
		["consent without settings", { consent }, "settings"],
		[
			"a malformed token",
			{ consent, settings: { ...settings, token: "trc_pat_short" } },
			"settings",
		],
		[
			"an API URL on another origin",
			{ consent, settings: { ...settings, api_url: "https://evil.example" } },
			"settings",
		],
		[
			"a non-http API URL",
			{ consent, settings: { ...settings, api_url: "javascript:alert(1)" } },
			"settings",
		],
		["consent and valid settings", { consent, settings }, "ready"],
	])("%s → %s", (_, stored, step) => {
		expect(deriveState(stored, ORIGIN, ENDPOINTS).step).toBe(step);
	});
});

describe("validateSettings", () => {
	it("accepts the permitted origin and normalizes trailing slashes", () => {
		expect(
			validateSettings(
				{
					api_url: `${ORIGIN}/`,
					web_url: "http://127.0.0.1:5173/",
					token: ` ${TOKEN} `,
				},
				ORIGIN,
			),
		).toEqual({ ok: true, settings });
	});

	it("refuses another origin, credentials, a query string, and a malformed token", () => {
		const result = validateSettings(
			{ api_url: "https://evil.example", web_url: "nope", token: "abc" },
			ORIGIN,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.api_url).toContain(`only connect to ${ORIGIN}`);
		expect(result.errors.web_url).toBeDefined();
		expect(result.errors.token).toBeDefined();
		for (const api_url of [
			`http://user:pw@127.0.0.1:8787`,
			`${ORIGIN}/?token=x`,
		])
			expect(validateSettings({ ...settings, api_url }, ORIGIN).ok).toBe(false);
	});
});

describe("stored consent and token", () => {
	it("moves from consent to settings to ready, and withdrawing consent forgets the token", async () => {
		const storage = memoryStorage();
		expect(ALLOWED_API_ORIGIN).toBe(ORIGIN); // the build-time default used by this test run
		expect((await loadState(storage)).step).toBe("consent");
		await acceptConsent(storage, new Date("2026-10-25T10:00:00.000Z"));
		expect(await loadState(storage)).toEqual({
			step: "settings",
			endpoints: ENDPOINTS,
		});
		await saveSettings(storage, settings);
		expect(await loadState(storage)).toEqual({ step: "ready", settings });
		await forgetAll(storage);
		expect(storage.items).toEqual({});
		expect((await loadState(storage)).step).toBe("consent");
	});
});
