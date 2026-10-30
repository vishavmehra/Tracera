import type {
	BrowserLocator,
	BrowserRunReport,
	BrowserStep,
} from "@tracera/contracts";
import type { Locator, Page } from "playwright-core";

/**
 * The fixed browser runner. It runs inside the browser container, which shares the app
 * container's network namespace (loopback only), executes validated steps with Playwright locators,
 * aborts every request outside the app origin, and prints one JSON line. It never evaluates code
 * from the model or the repository. Type imports are erased when the script is stripped and loaded.
 */

export type RunnerInput = {
	port: number;
	ready_path: string;
	base_path: string;
	steps: BrowserStep[];
	startup_timeout_ms: number;
};

const PLAYWRIGHT = "/opt/tracera/node_modules/playwright-core/index.mjs";
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const MAX_SCREENSHOT_CHARS = 1_400_000;

/** At most `max` characters, ellipsis included: the report contract rejects anything longer. */
export const clip = (text: string | null | undefined, max: number) =>
	text == null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function locate(page: Page, target: BrowserLocator): Locator {
	const exact = target.exact ?? undefined;
	switch (target.by) {
		case "role":
			return page.getByRole(target.value as Parameters<Page["getByRole"]>[0], {
				name: target.name ?? undefined,
				exact,
			});
		case "text":
			return page.getByText(target.value, { exact });
		case "label":
			return page.getByLabel(target.value, { exact });
		case "placeholder":
			return page.getByPlaceholder(target.value, { exact });
		case "test_id":
			return page.getByTestId(target.value);
		case "css":
			return page.locator(target.value);
	}
}

/** Polls `probe` until it reports success or the deadline passes; returns the last observation. */
async function poll(
	timeoutMs: number,
	probe: () => Promise<{ ok: boolean; actual: string | null }>,
) {
	const deadline = Date.now() + timeoutMs;
	let last: { ok: boolean; actual: string | null } = {
		ok: false,
		actual: null,
	};
	for (;;) {
		try {
			last = await probe();
		} catch (error) {
			last = { ok: false, actual: `error: ${(error as Error).message}` };
		}
		if (last.ok || Date.now() >= deadline) return last;
		await sleep(100);
	}
}

/** A network error as a short code (`ECONNREFUSED`, `TimeoutError`); never the app's own words. */
const errorCode = (error: unknown) =>
	clip(
		(error as { cause?: { code?: string } }).cause?.code ??
			(error as Error).name ??
			"error",
		100,
	) ?? "error";

/** Probes the ready path until the app answers (anything below 500) or the deadline passes. */
async function waitForApp(
	origin: string,
	readyPath: string,
	timeoutMs: number,
) {
	const started = Date.now();
	const deadline = started + timeoutMs;
	let attempts = 0;
	let status: number | null = null;
	let error: string | null = null;
	while (Date.now() < deadline) {
		attempts += 1;
		try {
			const response = await fetch(`${origin}${readyPath}`, {
				signal: AbortSignal.timeout(2_000),
				redirect: "manual",
			});
			status = response.status;
			error = response.status < 500 ? null : `http_${response.status}`;
			if (response.status < 500)
				return {
					ok: true,
					status,
					attempts,
					waited: Date.now() - started,
					error,
				};
		} catch (caught) {
			// not listening yet
			status = null;
			error = errorCode(caught);
		}
		await sleep(250);
	}
	return { ok: false, status, attempts, waited: Date.now() - started, error };
}

export async function runBrowser(
	input: RunnerInput,
): Promise<BrowserRunReport> {
	const started = Date.now();
	const origin = `http://localhost:${input.port}`;
	const report: BrowserRunReport = {
		ready: false,
		steps: [],
		console_errors: [],
		page_errors: [],
		blocked_requests: [],
		failed_requests: [],
		final_path: null,
		screenshot: null,
		duration_ms: 0,
	};
	const finish = () => ({ ...report, duration_ms: Date.now() - started });
	const health = await waitForApp(
		origin,
		input.ready_path,
		input.startup_timeout_ms,
	);
	report.ready = health.ok;
	const startup = {
		health_path: input.ready_path,
		health_ok: health.ok,
		health_status: health.status,
		health_attempts: health.attempts,
		health_waited_ms: health.waited,
		health_error: health.error,
		page_loaded: false,
		page_error: null as string | null,
	};
	report.startup = startup;
	if (!report.ready) return finish();

	const { chromium } = (await import(
		PLAYWRIGHT
	)) as typeof import("playwright-core");
	const browser = await chromium.launch({
		// The container is the sandbox boundary; Chromium's own sandbox needs capabilities it lacks.
		chromiumSandbox: false,
		args: ["--disable-dev-shm-usage", "--disable-gpu"],
	});
	try {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			serviceWorkers: "block",
		});
		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (url.startsWith(`${origin}/`) || url === origin)
				return route.continue();
			if (report.blocked_requests.length < 50)
				report.blocked_requests.push(
					clip(url.replace(/[?#].*$/, ""), 300) ?? "",
				);
			return route.abort("blockedbyclient");
		});
		const page = await context.newPage();
		page.on("console", (message) => {
			if (message.type() === "error" && report.console_errors.length < 50)
				report.console_errors.push(clip(message.text(), 1000) ?? "");
		});
		page.on("pageerror", (error) => {
			if (report.page_errors.length < 50)
				report.page_errors.push(clip(error.message, 1000) ?? "");
		});
		page.on("response", (response) => {
			const url = new URL(response.url());
			if (
				response.status() >= 400 &&
				url.origin === origin &&
				report.failed_requests.length < 50
			)
				report.failed_requests.push({
					path: clip(url.pathname, 500) ?? "/",
					status: response.status(),
					failure: null,
				});
		});
		page.on("requestfailed", (request) => {
			const url = new URL(request.url());
			if (url.origin === origin && report.failed_requests.length < 50)
				report.failed_requests.push({
					path: clip(url.pathname, 500) ?? "/",
					status: null,
					failure: clip(request.failure()?.errorText ?? "failed", 300),
				});
		});
		try {
			await page.goto(`${origin}${input.base_path}`, { timeout: 15_000 });
			startup.page_loaded = true;
		} catch (error) {
			startup.page_error = clip((error as Error).message.split("\n")[0], 500);
		}

		// A page that did not load runs no step: nothing was observed.
		let stopped = !startup.page_loaded;
		for (const [index, step] of input.steps.entries()) {
			const assertion = step.action.startsWith("expect_");
			if (stopped) {
				report.steps.push({
					index,
					action: step.action,
					status: "skipped",
					assertion,
					message: null,
					expected: null,
					actual: null,
					duration_ms: 0,
				});
				continue;
			}
			const stepStarted = Date.now();
			const timeout = step.timeout_ms ?? DEFAULT_STEP_TIMEOUT_MS;
			const result = await runStep(page, step, timeout, origin, report).catch(
				(error: Error) => ({
					ok: false,
					message: error.message,
					expected: null,
					actual: null,
				}),
			);
			report.steps.push({
				index,
				action: step.action,
				status: result.ok ? "passed" : "failed",
				assertion,
				message: clip(result.message, 2000),
				expected: clip(result.expected, 1000),
				actual: clip(result.actual, 1000),
				duration_ms: Date.now() - stepStarted,
			});
			if (!result.ok) stopped = true;
		}
		if (startup.page_loaded) {
			const url = new URL(page.url());
			report.final_path = clip(`${url.pathname}${url.search}`, 500);
		}
		// Taken whatever the steps did, so a failed run still shows what the page looked like.
		report.screenshot = await screenshotOf(page);
	} finally {
		await browser.close();
	}
	return finish();
}

/** The page as a PNG (base64); null when it cannot be captured or exceeds the report's size cap. */
async function screenshotOf(page: Page): Promise<string | null> {
	try {
		const png = await page.screenshot({
			type: "png",
			animations: "disabled",
			timeout: 10_000,
		});
		const encoded = png.toString("base64");
		return encoded.length <= MAX_SCREENSHOT_CHARS ? encoded : null;
	} catch {
		return null;
	}
}

type StepResult = {
	ok: boolean;
	message: string | null;
	expected: string | null;
	actual: string | null;
};

async function runStep(
	page: Page,
	step: BrowserStep,
	timeout: number,
	origin: string,
	report: BrowserRunReport,
): Promise<StepResult> {
	const done = { ok: true, message: null, expected: null, actual: null };
	const target = step.target ? locate(page, step.target).first() : null;
	switch (step.action) {
		case "goto":
			await page.goto(`${origin}${step.path ?? "/"}`, {
				timeout: Math.max(timeout, 10_000),
			});
			return done;
		case "click":
			await target?.click({ timeout });
			return done;
		case "fill":
			await target?.fill(step.value ?? "", { timeout });
			return done;
		case "select":
			await target?.selectOption(step.value ?? "", { timeout });
			return done;
		case "press":
			if (target) await target.press(step.key ?? "", { timeout });
			else await page.keyboard.press(step.key ?? "");
			return done;
		case "set_viewport":
			await page.setViewportSize({
				width: step.width ?? 1280,
				height: step.height ?? 800,
			});
			return done;
		case "wait_for":
			await target?.waitFor({ state: "visible", timeout });
			return done;
		case "expect_text": {
			const expected = step.value ?? "";
			const equals = step.match === "equals";
			const seen = await poll(timeout, async () => {
				const text = squash(
					(await target?.textContent({ timeout: 500 })) ?? "",
				);
				return {
					ok: equals
						? text === squash(expected)
						: text.includes(squash(expected)),
					actual: text,
				};
			});
			return seen.ok
				? done
				: {
						ok: false,
						message: `expected the text to ${equals ? "equal" : "contain"} the expected value`,
						expected,
						actual: seen.actual,
					};
		}
		case "expect_visible":
		case "expect_hidden": {
			const want = step.action === "expect_visible";
			const seen = await poll(timeout, async () => {
				const visible = (await target?.isVisible()) ?? false;
				return { ok: visible === want, actual: visible ? "visible" : "hidden" };
			});
			return seen.ok
				? done
				: {
						ok: false,
						message: `expected the element to be ${want ? "visible" : "hidden"}`,
						expected: want ? "visible" : "hidden",
						actual: seen.actual,
					};
		}
		case "expect_url": {
			const seen = await poll(timeout, async () => {
				const url = new URL(page.url());
				const actual = `${url.pathname}${url.search}`;
				return { ok: actual === step.path, actual };
			});
			return seen.ok
				? done
				: {
						ok: false,
						message: "expected a different page",
						expected: step.path,
						actual: seen.actual,
					};
		}
		case "expect_no_console_errors": {
			// Errors logged right after the last interaction still count.
			await sleep(300);
			const errors = [...report.console_errors, ...report.page_errors];
			return errors.length === 0
				? done
				: {
						ok: false,
						message: "the page reported errors",
						expected: "no console or page errors",
						actual: errors.slice(0, 3).join(" | "),
					};
		}
		case "expect_no_horizontal_overflow": {
			// A constant expression (the server's TypeScript has no DOM types); never model input.
			const widths = await page.evaluate<{ scroll: number; client: number }>(
				"({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })",
			);
			return widths.scroll <= widths.client + 1
				? done
				: {
						ok: false,
						message: "the page scrolls horizontally",
						expected: `content width ≤ ${widths.client}px`,
						actual: `content width ${widths.scroll}px`,
					};
		}
	}
}

if (process.env.TRACERA_ROLE === "browser-runner") {
	(async () => {
		const input = JSON.parse(
			Buffer.from(process.env.TRACERA_BROWSER_INPUT ?? "", "base64").toString(
				"utf8",
			),
		) as RunnerInput;
		const report = await runBrowser(input);
		process.stdout.write(`${JSON.stringify({ browser: report })}\n`);
	})().catch((error: Error) => {
		process.stdout.write(
			`${JSON.stringify({ browser_error: clip(error.message, 1000) })}\n`,
		);
		process.exitCode = 1;
	});
}
