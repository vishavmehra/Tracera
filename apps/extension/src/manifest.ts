export const EXTENSION_VERSION = "0.1.0";

/**
 * The MV3 manifest, generated at build time (vite.config.ts) so that the only host permission and the only
 * network destination allowed by the page CSP are the configured Tracera API origin. Pages are
 * reached through `activeTab` after a click; there are no declared content scripts, no web-accessible
 * resources, and no `externally_connectable`, so web pages cannot message the extension.
 */
export function buildManifest(options: { apiUrl: string }) {
	const url = new URL(options.apiUrl);
	if (!/^https?:$/.test(url.protocol) || url.username || url.password)
		throw new Error(
			"TRACERA_EXTENSION_DEFAULT_API_URL must be an http(s) URL without credentials",
		);
	return {
		manifest_version: 3,
		name: "Tracera bug capture",
		short_name: "Tracera",
		version: EXTENSION_VERSION,
		description:
			"Capture a bug from the current tab and send it to your Tracera workspace.",
		minimum_chrome_version: "120",
		permissions: ["activeTab", "scripting", "storage"],
		host_permissions: [`${url.origin}/*`],
		background: { service_worker: "background.js", type: "module" },
		action: {
			default_title: "Report a bug to Tracera",
			default_popup: "popup.html",
		},
		content_security_policy: {
			extension_pages: [
				"default-src 'self'",
				"script-src 'self'",
				"object-src 'none'",
				"base-uri 'none'",
				"form-action 'none'",
				"img-src 'self' blob: data:",
				`connect-src ${url.origin}`,
			].join("; "),
		},
	};
}
