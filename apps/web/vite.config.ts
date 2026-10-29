import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

/**
 * The policy for the built app (a strict CSP). Whatever serves `dist/` in
 * production should send the same header; `vite preview` sends it so the build can be checked.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

// The API compares a mutation's Origin with TRACERA_PUBLIC_URL. The proxy forwards the browser's
// Origin unchanged, so development needs TRACERA_PUBLIC_URL=http://127.0.0.1:<web port>; the fixed host
// and strict port keep that origin stable. TRACERA_WEB_API_URL and TRACERA_WEB_PORT are read by this
// config only (never exposed to the bundle) so a second stack can run beside the default one.
const target = process.env.TRACERA_WEB_API_URL ?? "http://127.0.0.1:8787";
const port = Number(process.env.TRACERA_WEB_PORT ?? 5173);
const api = { "/api": { target }, "/readyz": { target } };

export default defineConfig({
	plugins: [tailwindcss()],
	server: { host: "127.0.0.1", port, strictPort: true, proxy: api },
	preview: {
		host: "127.0.0.1",
		port: 4173,
		strictPort: true,
		proxy: api,
		headers: { "content-security-policy": CONTENT_SECURITY_POLICY },
	},
	test: {
		environment: "jsdom",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["./test/setup.ts"],
	},
});
