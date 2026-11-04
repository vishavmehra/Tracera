import { z } from "zod";

// What this server can really do, so a client states the facts instead of assuming a feature exists.

export const CAPABILITY_IDS = [
	"investigation_analysis",
	"screenshot_understanding",
	"sandbox_verification",
	"patch_download",
	"authorized_actions",
	"google_meet",
	"mcp_client",
	"browser_extension",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * `available`: usable here now. `needs_configuration`: usable in this environment once the operator
 * sets something up or starts something. `unavailable`: not possible in this environment.
 */
export const CapabilityStatusSchema = z.enum([
	"available",
	"unavailable",
	"needs_configuration",
]);

export const CapabilitySchema = z.object({
	/** A client treats an id it does not know as unknown, so a newer server never breaks an older client. */
	id: z.string(),
	label: z.string(),
	status: CapabilityStatusSchema,
	/** One plain sentence. It names variables that are missing, never their values. */
	reason: z.string(),
});

export const CapabilitiesResponseSchema = z.object({
	environment: z.enum(["hosted", "local"]),
	/** `mock` means model results are placeholders from the mock adapter, never real model output. */
	inference: z.object({ mode: z.enum(["live", "mock"]), provider: z.string() }),
	items: z.array(CapabilitySchema),
});

export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
