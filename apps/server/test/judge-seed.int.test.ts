import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users, workspaceMembers } from "../src/db/schema.ts";
import { defaultWorkspaceId, seedMember } from "../src/db/seed.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	login,
	PASSWORD,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

let ctx: TestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
});

const judge = {
	email: "judge@example.com",
	password: PASSWORD,
	displayName: "Judge",
	costLog2: 10,
};

const accountOf = async (email: string) => {
	const [user] = await ctx.db
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	return user;
};

const membershipsOf = async (userId: string) =>
	(
		await ctx.db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.userId, userId))
	).map(({ workspaceId, role }) => ({ workspaceId, role }));

describe("seedMember", () => {
	it("does nothing while no owner exists", async () => {
		expect(await seedMember(ctx.db, judge)).toBeNull();
		expect(await accountOf(judge.email)).toBeUndefined();
		expect(await defaultWorkspaceId(ctx.db)).toBeNull();
	});

	it("adds the judge as a member of the owner's workspace, and the judge can sign in", async () => {
		const owner = await createOwner(ctx.db);
		const seeded = await seedMember(ctx.db, judge);
		expect(seeded).toMatchObject({
			created: true,
			workspaceId: owner.workspaceId,
		});
		const account = await accountOf(judge.email);
		expect(account?.displayName).toBe("Judge");
		expect(await membershipsOf(account?.id ?? "")).toEqual([
			{ workspaceId: owner.workspaceId, role: "member" },
		]);

		const me = await asSession(ctx, await login(ctx, judge.email))(
			"GET",
			"/api/v1/auth/me",
		);
		expect(me.json()).toMatchObject({
			user: { email: judge.email, display_name: "Judge" },
			workspace: { id: owner.workspaceId, role: "member" },
		});
	});

	it("normalises the email", async () => {
		await createOwner(ctx.db);
		await seedMember(ctx.db, { ...judge, email: "  Judge@Example.COM " });
		expect(await accountOf("judge@example.com")).toBeDefined();
	});

	it("keeps an existing judge account as it is on later boots", async () => {
		await createOwner(ctx.db);
		await seedMember(ctx.db, judge);
		const before = await accountOf(judge.email);

		const again = await seedMember(ctx.db, {
			...judge,
			password: "a-different-long-password",
			displayName: "Someone else",
		});
		expect(again?.created).toBe(false);
		const after = await accountOf(judge.email);
		expect(after?.passwordHash).toBe(before?.passwordHash);
		expect(after?.displayName).toBe("Judge");
		expect(await membershipsOf(after?.id ?? "")).toHaveLength(1);
		await login(ctx, judge.email);
	});

	it("never promotes an existing owner", async () => {
		const owner = await createOwner(ctx.db);
		const seeded = await seedMember(ctx.db, {
			...judge,
			email: "owner@example.com",
		});
		expect(seeded).toMatchObject({ created: false, userId: owner.userId });
		expect(await membershipsOf(owner.userId)).toEqual([
			{ workspaceId: owner.workspaceId, role: "owner" },
		]);
	});

	it("takes the workspace of the earliest owner, and only adds the missing membership to another account", async () => {
		const first = await createOwner(ctx.db, "first@example.com");
		const second = await createOwner(ctx.db, "second@example.com");
		const before = await accountOf("second@example.com");

		const seeded = await seedMember(ctx.db, {
			...judge,
			email: "second@example.com",
		});
		expect(seeded).toMatchObject({
			created: false,
			workspaceId: first.workspaceId,
		});
		expect(await membershipsOf(second.userId)).toEqual(
			expect.arrayContaining([
				{ workspaceId: second.workspaceId, role: "owner" },
				{ workspaceId: first.workspaceId, role: "member" },
			]),
		);
		const after = await accountOf("second@example.com");
		expect(after?.passwordHash).toBe(before?.passwordHash);
		expect(after?.displayName).toBe(before?.displayName);

		const created = await seedMember(ctx.db, judge);
		expect(created?.workspaceId).toBe(first.workspaceId);
		expect(
			await membershipsOf((await accountOf(judge.email))?.id ?? ""),
		).toEqual([{ workspaceId: first.workspaceId, role: "member" }]);
	});
});
