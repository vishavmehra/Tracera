import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card, PageHeader, Table, tdClass, thClass } from "../src/ui.tsx";
import {
	ids,
	json,
	profile,
	renderApp,
	repository,
	session,
	snapshot,
	stubApi,
} from "./support.tsx";

const ME = "GET /api/v1/auth/me";
const READY = "GET /readyz";
const LIST = "GET /api/v1/repositories";
const INVESTIGATIONS = "GET /api/v1/investigations?limit=50";
const empty = () => json({ items: [], next_cursor: null });
const ready = (overrides: Record<string, unknown> = {}) =>
	json({
		status: "ready",
		worker: "ok",
		sandbox: null,
		inference_provider: "mock",
		inference_mode: "mock",
		...overrides,
	});

const mainNav = () => within(screen.getByRole("navigation", { name: "Main" }));
/** The navigation entries marked as the current page. */
const marked = () =>
	mainNav()
		.getAllByRole("link")
		.filter((link) => link.getAttribute("aria-current") === "page")
		.map((link) => link.textContent);

describe("shell navigation", () => {
	it("marks the section you are in and follows you to another", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[INVESTIGATIONS]: empty(),
		});
		renderApp("/");
		await screen.findByRole("heading", { level: 1, name: "Repositories" });
		expect(marked()).toEqual(["Repositories"]);
		fireEvent.click(mainNav().getByRole("link", { name: "Investigations" }));
		await screen.findByRole("heading", { level: 1, name: "Investigations" });
		expect(marked()).toEqual(["Investigations"]);
	});

	it("keeps Repositories marked on a page inside a repository", async () => {
		stubApi({
			[ME]: json(session()),
			[`GET /api/v1/repositories/${ids.repo}`]: json({
				repository: repository(),
			}),
			[`GET /api/v1/repositories/${ids.repo}/snapshots`]: json({
				snapshots: [snapshot()],
			}),
			[`GET /api/v1/repositories/${ids.repo}/profile`]: json(profile()),
		});
		renderApp(`/repositories/${ids.repo}`);
		await screen.findByRole("heading", { level: 1, name: "bench-shop" });
		expect(marked()).toEqual(["Repositories"]);
	});
});

describe("navigation landmarks", () => {
	it("has one Main navigation and puts the skip link first in the tab order", async () => {
		stubApi({ [ME]: json(session()), [LIST]: empty() });
		renderApp("/");
		await screen.findByRole("heading", { level: 1, name: "Repositories" });
		expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);
		const first = document.body.querySelector(
			'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		expect(first?.textContent).toBe("Skip to content");
	});
});

describe("system status", () => {
	it("announces mock inference with the reason in the tooltip", async () => {
		stubApi({ [ME]: json(session()), [LIST]: empty(), [READY]: ready() });
		renderApp("/");
		expect(await screen.findByText("Mock")).toBeTruthy();
		expect(screen.getByTitle(/mock adapter/)).toBeTruthy();
	});

	it("names the inference mode when it is not mock, without a mock label", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[READY]: ready({ inference_mode: "live" }),
		});
		renderApp("/");
		expect(await screen.findByText("Live inference")).toBeTruthy();
		expect(screen.queryByText("Mock")).toBeNull();
	});

	it("says when the worker is not running", async () => {
		stubApi({
			[ME]: json(session()),
			[LIST]: empty(),
			[READY]: ready({ worker: "not_ready" }),
		});
		renderApp("/");
		expect(await screen.findByText("Worker not ready")).toBeTruthy();
	});
});

describe("page primitives", () => {
	it("PageHeader holds the one h1 and adds no banner landmark", () => {
		render(
			<PageHeader
				title="Repositories"
				description="Snapshot status as the API reports it."
				actions={<button type="button">Register</button>}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "Repositories" }),
		).toBeTruthy();
		expect(screen.getByText(/as the API reports it/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Register" })).toBeTruthy();
		expect(screen.queryByRole("banner")).toBeNull();
	});

	it("Card is a region named by its title, and an untitled one is not", () => {
		render(
			<>
				<Card title="Workflow" actions={<span>3 of 9 stages</span>}>
					Stages
				</Card>
				<Card>Loose content</Card>
			</>,
		);
		const region = screen.getByRole("region", { name: "Workflow" });
		expect(within(region).getByText("3 of 9 stages")).toBeTruthy();
		expect(screen.getAllByRole("region")).toHaveLength(1);
	});

	it("Table is named by its caption and scrolls inside a focusable frame", () => {
		render(
			<Table caption="Snapshots">
				<thead>
					<tr>
						<th className={thClass}>Status</th>
						<th className={thClass}>Commit</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td className={tdClass}>Ready</td>
						<td className={tdClass}>1f2e3d4c5b6a</td>
					</tr>
				</tbody>
			</Table>,
		);
		const table = screen.getByRole("table", { name: "Snapshots" });
		expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
		const frame = screen.getByRole("region", { name: "Snapshots" });
		expect(frame.getAttribute("tabindex")).toBe("0");
		expect(frame.contains(table)).toBe(true);
	});
});
