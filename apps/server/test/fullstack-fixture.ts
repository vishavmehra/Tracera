// A small full-stack repository (Express API, React UI, Drizzle tables, events, SQL migration) shared by
// the framework-relationship unit tests and the graph integration tests.

export const SHOP: Record<string, string> = {
	"server/app.js": [
		'import express from "express";',
		'import ordersRouter from "./routes/orders.js";',
		"const app = express();",
		"app.use(express.json());",
		'app.use("/api", ordersRouter);',
		'app.get("/health", (req, res) => res.json({ ok: true }));',
		"export default app;",
	].join("\n"),
	"server/routes/orders.js": [
		'import { Router } from "express";',
		'import { requireAuth } from "../middleware/auth.js";',
		'import * as controller from "../controllers/index.js";',
		"const router = Router();",
		'router.get("/orders/:id", requireAuth, controller.getOrder);',
		'router.post("/orders", requireAuth, controller.createOrder);',
		"export default router;",
	].join("\n"),
	"server/middleware/auth.js": [
		"export function requireAuth(req, res, next) {",
		"\tif (!process.env.API_TOKEN) return next();",
		"\tnext();",
		"}",
	].join("\n"),
	"server/controllers/index.js": 'export * from "./orders.js";',
	"server/controllers/orders.js": [
		'import { OrderService } from "../services/orders.ts";',
		"const service = new OrderService();",
		"export async function getOrder(req, res) { res.json(await service.find(req.params.id)); }",
		"export async function createOrder(req, res) { res.json(await service.create(req.body)); }",
	].join("\n"),
	"server/services/orders.ts": [
		'import { db } from "../db/client.ts";',
		'import { orders } from "../db/schema.ts";',
		'import { events } from "../events.ts";',
		"export class BaseService { log(message: string) { return message; } }",
		"export class OrderService extends BaseService {",
		"\tfind(id: string) { return db.select().from(orders).where(id); }",
		"\tcreate(body: unknown) {",
		'\t\tthis.log("create");',
		'\t\tevents.emit("order:created", body);',
		"\t\treturn db.insert(orders).values(body);",
		"\t}",
		"}",
	].join("\n"),
	"server/db/schema.ts": [
		'import { pgTable } from "drizzle-orm/pg-core";',
		'export const orders = pgTable("orders", {});',
	].join("\n"),
	"server/db/client.ts": "export const db = makeDb(process.env.DATABASE_URL);",
	"server/events.ts": [
		'import { EventEmitter } from "node:events";',
		"export const events = new EventEmitter();",
		'events.on("order:created", sendReceipt);',
		'events.on("error", sendReceipt);',
		"export function sendReceipt(order) { return order; }",
	].join("\n"),
	"server/migrations/0001_orders.sql": [
		"-- orders",
		"CREATE TABLE orders (id text primary key);",
		"ALTER TABLE orders ADD COLUMN total int;",
	].join("\n"),
	"server/unrelated.js": [
		"const cache = new Map();",
		"export function forget(key) { cache.delete(key); return Array.from(cache.keys()); }",
		'export function lookup(map) { return map.get("/orders"); }',
	].join("\n"),
	"web/src/api.ts": [
		'import axios from "axios";',
		'export const api = axios.create({ baseURL: "/api" });',
		"export const ordersApi = {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code containing a template literal
		"\tget: (id: string) => api.get(`/orders/${id}`),",
		'\tcreate: (body: unknown) => fetch("/api/orders", { method: "POST", body: JSON.stringify(body) }),',
		"};",
		'export function track() { return fetch("https://analytics.example.com/v1/events", { method: "POST" }); }',
		'export function lost() { return fetch("/api/nowhere"); }',
	].join("\n"),
	"web/src/OrderPage.tsx": [
		'import { ordersApi } from "./api.ts";',
		"export function OrderPage() {",
		"\tconst save = () => ordersApi.create({});",
		'\treturn <button onClick={save} onMouseEnter={() => ordersApi.get("1")}>Save</button>;',
		"}",
	].join("\n"),
	"web/src/App.tsx": [
		'import { Routes, Route } from "react-router-dom";',
		'import { OrderPage } from "./OrderPage.tsx";',
		'export function App() { return <Routes><Route path="/orders/:id" element={<OrderPage />} /></Routes>; }',
	].join("\n"),
};
export const DEPS = {
	express: "5.0.0",
	axios: "1.7.0",
	"drizzle-orm": "0.45.0",
	"react-router-dom": "7.0.0",
};
