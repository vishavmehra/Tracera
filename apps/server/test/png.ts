/** A valid 1x1 PNG, for tests that need screenshot bytes without a browser. */
export const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
export const TINY_PNG_BASE64 = TINY_PNG.toString("base64");
