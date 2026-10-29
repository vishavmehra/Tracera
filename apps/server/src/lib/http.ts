/** An error that maps to an RFC 9457 problem response with a stable `code`. */
export class AppError extends Error {
	readonly status: number;
	readonly code: string;
	readonly extra: Record<string, unknown> | undefined;
	readonly errors: Array<{ path: string; message: string }> | undefined;

	constructor(
		status: number,
		code: string,
		detail: string,
		options: {
			extra?: Record<string, unknown>;
			errors?: Array<{ path: string; message: string }>;
		} = {},
	) {
		super(detail);
		this.status = status;
		this.code = code;
		this.extra = options.extra;
		this.errors = options.errors;
	}
}

const TITLES: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	409: "Conflict",
	413: "Payload Too Large",
	415: "Unsupported Media Type",
	422: "Unprocessable Content",
	429: "Too Many Requests",
	500: "Internal Server Error",
	503: "Service Unavailable",
};

export function problemBody(error: AppError, requestId: string) {
	return {
		type: `urn:tracera:problem:${error.code}`,
		title: TITLES[error.status] ?? "Error",
		status: error.status,
		detail: error.message,
		code: error.code,
		request_id: requestId,
		...(error.errors ? { errors: error.errors } : {}),
		...(error.extra ?? {}),
	};
}

/** Opaque keyset cursor over (created_at desc, id desc). */
export function encodeCursor(createdAt: Date, id: string): string {
	return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString(
		"base64url",
	);
}

export function decodeCursor(
	cursor: string | undefined,
): { createdAt: Date; id: string } | null {
	if (!cursor) return null;
	const [iso, id] = Buffer.from(cursor, "base64url")
		.toString("utf8")
		.split("|");
	const createdAt = new Date(iso ?? "");
	if (!id || Number.isNaN(createdAt.getTime()))
		throw new AppError(400, "validation_failed", "Invalid cursor");
	return { createdAt, id };
}

export function parseCookies(
	header: string | undefined,
): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		const raw = part.slice(index + 1).trim();
		try {
			cookies[name] = decodeURIComponent(raw);
		} catch {
			cookies[name] = raw;
		}
	}
	return cookies;
}

export function serializeCookie(
	name: string,
	value: string,
	options: { maxAgeSeconds: number; secure: boolean },
): string {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${options.maxAgeSeconds}`,
	];
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Fixed-window in-memory rate limiter.
 * ponytail: per-process memory; switch to a shared store (Postgres or @fastify/rate-limit + store) for multiple instances.
 */
export function createRateLimiter(options: {
	limit: number;
	windowMs: number;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const windows = new Map<string, { start: number; count: number }>();
	return {
		/** Checks without counting (e.g. before verifying a password, counting only failures). */
		isLimited(key: string): { limited: boolean; retryAfterSeconds: number } {
			const window = windows.get(key);
			const time = now();
			if (
				!window ||
				time - window.start >= options.windowMs ||
				window.count < options.limit
			)
				return { limited: false, retryAfterSeconds: 0 };
			return {
				limited: true,
				retryAfterSeconds: Math.ceil(
					(window.start + options.windowMs - time) / 1000,
				),
			};
		},
		take(key: string): { allowed: boolean; retryAfterSeconds: number } {
			const time = now();
			if (windows.size > 10_000) {
				for (const [k, w] of windows)
					if (time - w.start >= options.windowMs) windows.delete(k);
			}
			let window = windows.get(key);
			if (!window || time - window.start >= options.windowMs) {
				window = { start: time, count: 0 };
				windows.set(key, window);
			}
			window.count += 1;
			const allowed = window.count <= options.limit;
			return {
				allowed,
				retryAfterSeconds: allowed
					? 0
					: Math.ceil((window.start + options.windowMs - time) / 1000),
			};
		},
	};
}
