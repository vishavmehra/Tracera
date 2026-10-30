import type { StorageArea } from "../src/chrome.ts";

export const ULID = "01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
export const TOKEN = `trc_pat_${"0f".repeat(32)}`;

export type Call = { url: string; init: RequestInit };

/** A fetch double that records each call and answers from a script. */
export function fakeFetch(
	answer: (call: Call) => Response | Promise<Response>,
) {
	const calls: Call[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return answer(call);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

export const json = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

/** An RFC 9457 problem response as the API sends it. */
export const problem = (
	status: number,
	code: string,
	detail: string,
	extra: object = {},
	headers: Record<string, string> = {},
) =>
	json(
		status,
		{
			type: `urn:tracera:problem:${code}`,
			title: "Error",
			status,
			detail,
			code,
			request_id: "req-1",
			...extra,
		},
		{ "content-type": "application/problem+json", ...headers },
	);

/** An in-memory chrome.storage area. */
export function memoryStorage(
	initial: Record<string, unknown> = {},
): StorageArea & { items: Record<string, unknown> } {
	const items: Record<string, unknown> = { ...initial };
	return {
		items,
		get: async (keys) =>
			Object.fromEntries(
				(Array.isArray(keys) ? keys : [keys])
					.filter((key) => key in items)
					.map((key) => [key, items[key]]),
			),
		set: async (values) => {
			Object.assign(items, values);
		},
		remove: async (keys) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete items[key];
		},
	};
}
