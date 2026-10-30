import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../src/manifest.ts";

const manifest = buildManifest({ apiUrl: "http://127.0.0.1:8787/" });

describe("manifest (least privilege)", () => {
	it("asks only for activeTab, scripting, and storage, plus the API origin", () => {
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
		expect(manifest.host_permissions).toEqual(["http://127.0.0.1:8787/*"]);
	});

	it("declares nothing that widens access", () => {
		const granted = [...manifest.permissions, ...manifest.host_permissions];
		for (const forbidden of [
			"<all_urls>",
			"*://*/*",
			"http://*/*",
			"https://*/*",
			"tabs",
			"webRequest",
			"webRequestBlocking",
			"declarativeNetRequest",
			"cookies",
			"history",
			"debugger",
			"downloads",
			"clipboardRead",
			"nativeMessaging",
			"management",
			"sidePanel",
			"alarms",
		])
			expect(granted).not.toContain(forbidden);
		for (const key of [
			"content_scripts",
			"web_accessible_resources",
			"externally_connectable",
			"optional_permissions",
			"optional_host_permissions",
			"key",
			"oauth2",
		])
			expect(manifest).not.toHaveProperty(key);
	});

	it("limits extension pages to their own scripts and the API origin", () => {
		const csp = manifest.content_security_policy.extension_pages;
		const directives = Object.fromEntries(
			csp.split(";").map((part) => {
				const [name = "", ...values] = part.trim().split(/\s+/);
				return [name, values];
			}),
		);
		expect(directives["script-src"]).toEqual(["'self'"]);
		expect(directives["object-src"]).toEqual(["'none'"]);
		expect(directives["connect-src"]).toEqual(["http://127.0.0.1:8787"]);
		expect(csp).not.toMatch(/unsafe-(eval|inline)|wasm-unsafe-eval|\*/);
	});

	it("takes the origin from the API URL and refuses unsafe URLs", () => {
		expect(
			buildManifest({ apiUrl: "https://tracera.example/api/" })
				.host_permissions,
		).toEqual(["https://tracera.example/*"]);
		for (const apiUrl of [
			"ftp://tracera.example",
			"javascript:alert(1)",
			"https://user:secret@tracera.example",
		])
			expect(() => buildManifest({ apiUrl })).toThrow();
	});

	const built = new URL("../dist/manifest.json", import.meta.url);
	it.skipIf(!existsSync(built))("is what the build wrote to dist/", () => {
		expect(JSON.parse(readFileSync(built, "utf8"))).toEqual(
			buildManifest({
				apiUrl:
					process.env.TRACERA_EXTENSION_DEFAULT_API_URL ??
					"http://127.0.0.1:8787",
			}),
		);
	});
});
