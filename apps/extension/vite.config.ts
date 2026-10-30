import { defineConfig } from "vitest/config";
import { buildManifest } from "./src/manifest.ts";

// Build-time settings. Neither is secret; the API origin becomes the
// extension's only host permission and the only connect-src in its CSP.
const apiUrl =
	process.env.TRACERA_EXTENSION_DEFAULT_API_URL ?? "http://127.0.0.1:8787";
const webUrl =
	process.env.TRACERA_EXTENSION_DEFAULT_WEB_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
	define: {
		__TRACERA_DEFAULTS__: JSON.stringify({ api_url: apiUrl, web_url: webUrl }),
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "chrome120",
		// Chrome supports module preloading natively; the polyfill would add code the CSP does not need.
		modulePreload: false,
		rolldownOptions: {
			input: {
				popup: "popup.html",
				editor: "editor.html",
				background: "src/background.ts",
			},
			output: {
				// The manifest names the service worker file, so it keeps a fixed name.
				entryFileNames: (chunk) =>
					chunk.name === "background"
						? "background.js"
						: "assets/[name]-[hash].js",
			},
		},
	},
	plugins: [
		{
			name: "tracera-manifest",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "manifest.json",
					source: `${JSON.stringify(buildManifest({ apiUrl }), null, "\t")}\n`,
				});
			},
		},
	],
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		environment: "node",
	},
});
