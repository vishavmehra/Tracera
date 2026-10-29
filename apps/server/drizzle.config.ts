import { defineConfig } from "drizzle-kit";

// Run from the repository root: npm run db:generate
export default defineConfig({
	dialect: "postgresql",
	schema: "./apps/server/src/db/schema.ts",
	out: "./apps/server/drizzle",
	casing: "snake_case",
	strict: true,
});
