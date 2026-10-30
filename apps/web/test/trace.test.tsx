import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
	type DiffFile,
	DiffFileView,
	Notice,
	TabNav,
	Timeline,
	TraceStrip,
} from "../src/ui.tsx";

/** The line style of each segment, in document order. */
const lines = (container: HTMLElement) =>
	[...container.querySelectorAll("[data-line]")].map((element) =>
		element.getAttribute("data-line"),
	);

describe("TraceStrip", () => {
	const stops = [
		{
			key: "symptom",
			label: "Symptom",
			value: "Reported",
			reached: true,
			open: true,
		},
		{
			key: "evidence",
			label: "Evidence",
			value: "7 items",
			reached: true,
			href: "#evidence-heading",
		},
		{
			key: "patch",
			label: "Patch",
			value: "Proposed",
			reached: false,
			pending: true,
			to: "/patch",
		},
		{ key: "decision", label: "Decision", value: "Not yet", reached: false },
	];

	it("draws solid where data is stored, dashed where work is pending, dotted beyond", () => {
		render(
			<MemoryRouter>
				<TraceStrip label="Trace" stops={stops} />
			</MemoryRouter>,
		);
		const list = screen.getByRole("list", { name: "Trace" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(4);
		// A segment sits in the stop it leaves and takes the style of the stop it reaches.
		expect(lines(list)).toEqual(["solid", "dashed", "dotted"]);
	});

	it("links the stops that have somewhere to go, to an anchor or a route", () => {
		render(
			<MemoryRouter>
				<TraceStrip label="Trace" stops={stops} />
			</MemoryRouter>,
		);
		expect(
			screen.getByRole("link", { name: /Evidence/ }).getAttribute("href"),
		).toBe("#evidence-heading");
		expect(
			screen.getByRole("link", { name: /Patch/ }).getAttribute("href"),
		).toBe("/patch");
		expect(screen.queryByRole("link", { name: /Decision/ })).toBeNull();
	});

	it("keeps every stop readable to assistive technology", () => {
		render(
			<MemoryRouter>
				<TraceStrip label="Trace" stops={stops} />
			</MemoryRouter>,
		);
		for (const text of ["Symptom", "Reported", "7 items", "Not yet"])
			expect(screen.getByText(text)).toBeTruthy();
	});
});

describe("Timeline", () => {
	it("marks the current step and styles each line by the stop it reaches", () => {
		const { container } = render(
			<Timeline
				stops={[
					{
						key: "a",
						label: "Opened",
						reached: true,
						open: true,
						body: <span>Opened</span>,
					},
					{
						key: "b",
						label: "Collect",
						reached: true,
						current: true,
						body: <span>Collect context</span>,
					},
					{
						key: "c",
						label: "Verify",
						reached: false,
						body: <span>Verify</span>,
					},
				]}
			/>,
		);
		expect(
			screen
				.getByText("Collect context")
				.closest("li")
				?.getAttribute("aria-current"),
		).toBe("step");
		expect(
			screen.getByText("Verify").closest("li")?.getAttribute("aria-current"),
		).toBeNull();
		expect(lines(container)).toEqual(["solid", "dotted"]);
	});
});

describe("TabNav", () => {
	it("marks the current tab and keeps a tab marked on the pages that belong to it", () => {
		render(
			<MemoryRouter initialEntries={["/r/1/nodes/2"]}>
				<TabNav
					label="Sections"
					items={[
						{ to: "/r/1", label: "Overview", end: true },
						{ to: "/r/1/explore", label: "Explore", also: true },
						{ to: "/r/1/questions", label: "Questions" },
					]}
				/>
			</MemoryRouter>,
		);
		const nav = screen.getByRole("navigation", { name: "Sections" });
		expect(within(nav).getAllByRole("link")).toHaveLength(3);
		// `also` styles a tab as current without a route match, so no link claims the page.
		expect(
			within(nav)
				.getAllByRole("link")
				.filter((link) => link.getAttribute("aria-current") === "page"),
		).toHaveLength(0);
		expect(
			within(nav).getByRole("link", { name: "Explore" }).className,
		).toContain("border-accent");
		expect(
			within(nav).getByRole("link", { name: "Questions" }).className,
		).toContain("border-transparent");
	});

	it("exposes the matching route as the current page", () => {
		render(
			<MemoryRouter initialEntries={["/r/1/questions"]}>
				<TabNav
					label="Sections"
					items={[
						{ to: "/r/1", label: "Overview", end: true },
						{ to: "/r/1/questions", label: "Questions" },
					]}
				/>
			</MemoryRouter>,
		);
		expect(
			screen
				.getByRole("link", { name: "Questions" })
				.getAttribute("aria-current"),
		).toBe("page");
		expect(
			screen
				.getByRole("link", { name: "Overview" })
				.getAttribute("aria-current"),
		).toBeNull();
	});
});

describe("DiffFileView", () => {
	const file: DiffFile = {
		path: "src/cart/total.ts",
		lines: [
			{
				kind: "meta",
				text: "diff --git a/src/cart/total.ts b/src/cart/total.ts",
				old: null,
				new: null,
			},
			{ kind: "hunk", text: "@@ -1,3 +1,3 @@", old: null, new: null },
			{ kind: "context", text: " keep", old: 1, new: 1 },
			{ kind: "del", text: "-old", old: 2, new: null },
			{ kind: "add", text: "+new", old: null, new: 2 },
		],
	};

	it("shows the path, the change counts, and each changed line with its sign intact", () => {
		render(<DiffFileView file={file} />);
		expect(screen.getByText("src/cart/total.ts")).toBeTruthy();
		expect(screen.getByText("+1")).toBeTruthy();
		expect(screen.getByText("−1")).toBeTruthy();
		expect(screen.getByText("-old")).toBeTruthy();
		expect(screen.getByText("+new")).toBeTruthy();
		expect(screen.getByText("@@ -1,3 +1,3 @@")).toBeTruthy();
		expect(screen.queryByText(/diff --git/)).toBeNull();
	});
});

describe("Notice", () => {
	it("announces only when asked to", () => {
		render(
			<>
				<Notice tone="bad" title="Failed at Verify" role="alert">
					Timed out.
				</Notice>
				<Notice tone="info" title="Note">
					Nothing to do.
				</Notice>
			</>,
		);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("alert").textContent).toContain("Failed at Verify");
	});
});
