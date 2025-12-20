import http from "node:http";
import type { Config } from "./types";

export type ServerDeps = {
	run?: (cfg: Config) => Promise<void>;
	drop?: (cfg: Config) => Promise<void>;
};

export type ServerOpts = {
	host?: string;
	port?: number;
	listen?: boolean;
	serverFactory?: typeof http.createServer;
};

// Обработчик HTTP-запросов /sync|/clean|/health с защитой от параллельных вызовов.
export function createSyncHandler(cfg: Config, deps: ServerDeps = {}): http.RequestListener {
	let running = false;
	const run = deps.run;
	const drop = deps.drop;

	return async (req, res) => {
		const method = req.method ?? "";
		const url = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;
		const pathName = url?.pathname || "/";

		if (pathName === "/health") {
			res.statusCode = 200;
			res.end("OK\n");
			return;
		}

		const isSync = pathName === "/sync";
		const isClean = pathName === "/clean";

		if (!isSync && !isClean) {
			res.statusCode = 404;
			res.end("Not found\n");
			return;
		}

		if (method !== "GET" && method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "GET, POST");
			res.end("Method not allowed\n");
			return;
		}

		if (running) {
			res.statusCode = 429;
			res.end("Sync already running\n");
			return;
		}

		if (!run && isSync) {
			res.statusCode = 500;
			res.end("Sync handler not configured\n");
			return;
		}
		if (!drop && isClean) {
			res.statusCode = 500;
			res.end("Clean handler not configured\n");
			return;
		}

		running = true;
		console.log(`[serve] manual sync requested from ${req.socket.remoteAddress || "unknown"}`);

		try {
			if (isClean) {
				await drop?.(cfg);
			} else {
				await run?.(cfg);
			}
			res.statusCode = 200;
			res.end("OK\n");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[serve] sync failed: ${msg}`);
			res.statusCode = 500;
			res.end("Sync failed\n");
		} finally {
			running = false;
		}
	};
}

// Поднимает HTTP-сервер с обработчиком /sync|/clean|/health.
export function startHttpServer(cfg: Config, deps: ServerDeps, opts: ServerOpts = {}): http.Server {
	const host = opts.host ?? "0.0.0.0";
	const port = opts.port ?? 3939;
	const listen = opts.listen ?? true;
	const factory = opts.serverFactory ?? http.createServer;
	const handler = createSyncHandler(cfg, deps);
	const server = factory(handler);

	if (listen) {
		server.listen(port, host, () => {
			console.log(`[serve] listening on http://${host}:${port}, GET/POST /sync to trigger sync`);
		});
	}

	server.on("error", (err) => {
		console.error(`[serve] server error: ${err instanceof Error ? err.message : String(err)}`);
	});

	return server;
}
