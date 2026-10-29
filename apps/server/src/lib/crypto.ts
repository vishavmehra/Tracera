import {
	createHash,
	randomBytes,
	type ScryptOptions,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";

const KEY_LENGTH = 64;
const MAX_MEMORY = 256 * 1024 * 1024;

function scrypt(
	password: string,
	salt: Buffer,
	keyLength: number,
	options: ScryptOptions,
): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scryptCallback(password, salt, keyLength, options, (error, key) =>
			error ? reject(error) : resolve(key),
		),
	);
}

/**
 * scrypt password hash: N=2^17, r=8, p=1 by default, per OWASP guidance.
 * Format: scrypt$<log2 N>$<r>$<p>$<salt b64url>$<key b64url>, so parameters can be raised later.
 */
export async function hashPassword(
	password: string,
	options: { costLog2?: number } = {},
): Promise<string> {
	const costLog2 = options.costLog2 ?? 17;
	const salt = randomBytes(16);
	const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
		N: 2 ** costLog2,
		r: 8,
		p: 1,
		maxmem: MAX_MEMORY,
	});
	return `scrypt$${costLog2}$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const [scheme, logN, r, p, salt, key] = stored.split("$");
	const costLog2 = Number(logN);
	const blockSize = Number(r);
	const parallel = Number(p);
	if (
		scheme !== "scrypt" ||
		!salt ||
		!key ||
		!(costLog2 >= 10 && costLog2 <= 20)
	)
		return false;
	if (!(blockSize >= 1 && blockSize <= 16) || !(parallel >= 1 && parallel <= 4))
		return false;
	const expected = Buffer.from(key, "base64url");
	const actual = await scrypt(
		password.normalize("NFKC"),
		Buffer.from(salt, "base64url"),
		expected.length,
		{
			N: 2 ** costLog2,
			r: blockSize,
			p: parallel,
			maxmem: MAX_MEMORY,
		},
	);
	return expected.length > 0 && timingSafeEqual(expected, actual);
}

/** Personal access token: fixed prefix + 256 random bits as hex. Only its SHA-256 is stored. */
export const generateToken = (): string =>
	`trc_pat_${randomBytes(32).toString("hex")}`;

/** Opaque session cookie value. Only its SHA-256 is stored. */
export const generateSessionToken = (): string =>
	randomBytes(32).toString("base64url");

export const sha256Hex = (value: string | Buffer): string =>
	createHash("sha256").update(value).digest("hex");
