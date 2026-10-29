/** Secret patterns to redact. Order matters: specific before generic. */
const PATTERNS: Array<{ type: string; pattern: RegExp; replace?: string }> = [
	{
		type: "private_key",
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{ type: "meta_key", pattern: /\bLLM_\d{6,}_[A-Za-z0-9_-]{10,}/g },
	{ type: "tracera_pat", pattern: /\btrc_pat_[A-Za-z0-9]{20,}/g },
	{
		type: "nebius_key",
		pattern: /\bv1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
	},
	{ type: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ type: "openai_style", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
	{
		type: "github",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
	},
	{ type: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ type: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
	{ type: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
	{
		type: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	},
	{ type: "bearer", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
	{
		type: "url_credentials",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi,
		replace: "$1[REDACTED:url_credentials]@",
	},
	{
		type: "assignment",
		pattern:
			/\b(api[_-]?key|secret|token|password|passwd|authorization)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi,
		replace: "$1$2[REDACTED:assignment]",
	},
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Replaces likely secrets (and optionally emails) with [REDACTED:<type>] and counts replacements. */
export function redactSecrets(
	input: string,
	options: { redactEmails: boolean },
): { text: string; count: number } {
	let text = input;
	let count = 0;
	for (const { type, pattern, replace } of PATTERNS) {
		text = text.replace(pattern, (...args: string[]) => {
			count += 1;
			if (!replace) return `[REDACTED:${type}]`;
			return replace.replace(
				/\$(\d)/g,
				(_, group: string) => args[Number(group)] ?? "",
			);
		});
	}
	if (options.redactEmails) {
		text = text.replace(EMAIL, () => {
			count += 1;
			return "[REDACTED:email]";
		});
	}
	return { text, count };
}
