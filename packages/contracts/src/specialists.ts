import { z } from "zod";

/**
 * Canonical specialist roles. They are logical responsibilities served
 * by workflow code, deterministic services, and model calls through the inference gateway; a role is
 * not a separate model or process.
 */
export const SPECIALIST_ROLES = [
	"orchestrator",
	"repository_mapping",
	"code_exploration",
	"feasibility_planning",
	"impact_analysis",
	"bug_investigation",
	"reproduction",
	"patch_generation",
	"verification",
	"security_quality",
	"engineering_memory",
	"runtime_intelligence",
] as const;

export const SpecialistRoleSchema = z.enum(SPECIALIST_ROLES);
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;
