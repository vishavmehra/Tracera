import { randomBytes } from "node:crypto";
import type { IdPrefix } from "@tracera/contracts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Prefixed ULID: 10 chars of millisecond time + 16 random chars (32 divides 256, so no modulo bias). */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
	let time = "";
	let remaining = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD.charAt(remaining % 32) + time;
		remaining = Math.floor(remaining / 32);
	}
	let random = "";
	for (const byte of randomBytes(16)) random += CROCKFORD.charAt(byte % 32);
	return `${prefix}_${time}${random}`;
}
