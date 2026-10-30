import { createServer } from "node:http";
import { parseQuantity, renderCart } from "./src/cart-page.js";

// No dependencies. The sandbox sets PORT; run by hand it listens on 4173.
const port = Number(process.env.PORT ?? 4173);

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (url.pathname === "/health") {
		response.writeHead(200, { "content-type": "text/plain" });
		return response.end("ok");
	}
	if (url.pathname === "/") {
		response.writeHead(302, { location: "/cart" });
		return response.end();
	}
	if (url.pathname === "/cart") {
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		});
		return response.end(renderCart(parseQuantity(url.searchParams.get("qty"))));
	}
	response.writeHead(404, { "content-type": "text/plain" });
	response.end("Not found");
});

server.listen(port, () => console.log(`shop-ui listening on ${port}`));
