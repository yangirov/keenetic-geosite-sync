import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectDomains, createFetchContext, parseDomainList } from "../src/domainsList";
import * as cli from "../src/index";
import { createSyncHandler } from "../src/server";
import type { Config } from "../src/types";

const repoRoot = path.join(__dirname, "..");
const dataRoot = path.join(repoRoot, "tests", "fixtures", "data");

// Мок загрузки списка доменов из локальных фикстур.
const fetchFn = async (url: string): Promise<string> => {
	const relative = url.startsWith("mock://") ? url.slice("mock://".length) : url;
	return fs.promises.readFile(path.join(dataRoot, relative), "utf8");
};

// Базовый running-config для сценариев по умолчанию.
const defaultRunningConfig = `
object-group fqdn domain-list4
 description Testlist
!
dns-proxy route object-group domain-list4 Wireguard0 auto disable
!
object-group fqdn domain-list5
 description Other
!
object-group fqdn skip-this
 description
!
object-group fqdn wrong-prefix
 description ShouldBeIgnored
`;

// Собираем конфиг с возможностью переопределения.
function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		baseUrl: "mock://",
		timeoutMs: 1000,
		prefix: "domain-list",
		dryRun: true,
		runningConfigText: defaultRunningConfig,
		...overrides,
		fetchFn: overrides.fetchFn ?? fetchFn,
	};
}

// Запуск основного сценария с захватом логов.
async function runCase(cfg: Config): Promise<string> {
	const logs: string[] = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
		logs.push(args.join(" "));
	});
	const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
		logs.push(args.join(" "));
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
		logs.push(args.join(" "));
	});

	try {
		await cli.runConfig(cfg);
	} finally {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errSpy.mockRestore();
	}

	return logs.join("\n");
}

// Запуск dropAll с захватом логов.
async function runDrop(cfg: Config): Promise<string> {
	const logs: string[] = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
		logs.push(args.join(" "));
	});
	try {
		await cli.dropAll(cfg);
	} finally {
		logSpy.mockRestore();
	}
	return logs.join("\n");
}

function makeReqRes(pathname = "/sync", method = "GET") {
	let body = "";
	let resolveEnd!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveEnd = resolve;
	});

	const res: Partial<http.ServerResponse> & { headers: Record<string, string> } = {
		statusCode: 200,
		headers: {},
		setHeader(key: string, value: string) {
			this.headers[key] = String(value);
		},
		end(chunk?: string) {
			if (chunk) body += chunk.toString();
			resolveEnd();
		},
	};

	const req: Partial<http.IncomingMessage> & {
		socket: { remoteAddress?: string };
	} = {
		method,
		url: pathname,
		headers: {},
		socket: { remoteAddress: "test" },
	};

	return {
		req: req as http.IncomingMessage,
		res: res as http.ServerResponse,
		awaitEnd: done.then(() => ({ status: res.statusCode ?? 0, body })),
	};
}

describe("сценарии cli", () => {
	it("находит группы в running-config и применяет include", async () => {
		const out = await runCase(makeConfig());

		expect(out).toContain('[discover] found 2 group(s) with prefix "domain-list"');
		expect(out).toContain("[sync] domain-list4 <= testlist: 5 domain(s)");
		expect(out).toContain("[sync] domain-list5 <= other: 2 domain(s)");
		expect(out).toContain("object-group fqdn domain-list4 include example.com");
		expect(out).toContain("object-group fqdn domain-list4 include foo.bar");
		expect(out).toContain("object-group fqdn domain-list4 include bar.example");
		expect(out).toContain("object-group fqdn domain-list5 include baz.com");
	});

	it("добавляет маршруты dns-proxy при указанном интерфейсе", async () => {
		const out = await runCase(makeConfig({ routeInterface: "Wireguard0" }));
		expect(out).toContain("dns-proxy route object-group domain-list5 Wireguard0 auto");
	});

	it("копирует флаг disable на новые части сплита", async () => {
		const cfg = makeConfig({
			routeInterface: "Wireguard0",
			maxEntriesPerGroup: 1,
		});
		const out = await runCase(cfg);
		expect(out).toContain("dns-proxy route object-group domain-list4-2 Wireguard0 auto");
		expect(out).toContain("dns-proxy route disable");
	});

	it("пропускает, если префикс не совпадает ни с одной группой", async () => {
		const out = await runCase(makeConfig({ prefix: "unknown" }));
		expect(out).toContain("No lists to sync");
	});

	it("логирует циклы include и продолжает работу", async () => {
		const cycA = path.join(dataRoot, "cyc-a");
		const cycB = path.join(dataRoot, "cyc-b");
		fs.writeFileSync(cycA, "include:cyc-b\n");
		fs.writeFileSync(cycB, "include:cyc-a\n");

		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list-cycle
 description cyc-a
`,
		});

		const out = await runCase(cfg);
		expect(out).toContain("include cycle");

		fs.rmSync(cycA);
		fs.rmSync(cycB);
	});

	it("создаёт initialDomains, если групп ещё нет", async () => {
		const cfg = makeConfig({
			runningConfigText: "",
			initialDomains: ["Foo", "Bar"],
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).toContain("[init] add domain-list0 (Foo -> foo)");
		expect(out).toContain("[init] add domain-list1 (Bar -> bar)");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0");
	});

	it("не трогает initialDomains, если группы уже есть", async () => {
		const cfg = makeConfig({
			initialDomains: ["Foo", "Bar"],
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).not.toContain("[init] add");
	});

	it("удаляет все группы и маршруты по префиксу", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description A
!
dns-proxy route object-group domain-list0 Wireguard0 auto
dns-proxy route object-group domain-list1 Wireguard0 auto disable
object-group fqdn domain-list1
 description B
`,
			routeInterface: "Wireguard0",
		});
		const out = await runDrop(cfg);
		expect(out).toContain("[drop] prefix=domain-list, groups=2");
		expect(out).toContain("no object-group fqdn domain-list1");
	});

	it("наследует флаги маршрута от существующего сплита", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list4
 description Testlist
!
object-group fqdn domain-list4-2
 description Testlist chunk
!
dns-proxy route object-group domain-list4-2 Wireguard0 auto disable
`,
			routeInterface: "Wireguard0",
			maxEntriesPerGroup: 1,
		});
		const out = await runCase(cfg);
		expect(out).toContain("dns-proxy route object-group domain-list4-3 Wireguard0 auto");
		expect(out).toContain("dns-proxy route disable");
	});

	it("убирает суффикс сплита из description при slugify", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description Facebook [1/2]
!
object-group fqdn domain-list0-2
 description Facebook [2/2]
`,
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).toContain("[sync] domain-list0 <= facebook");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0 auto");
		expect(out).not.toContain("[sync] domain-list0-2");
	});

	it("парсит disable в маршрутах и логирует отключённые", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description Testlist
!
route object-group domain-list0 Wireguard0 auto
route disable
`,
			routeInterface: "Wireguard0",
			maxEntriesPerGroup: 1,
		});
		const out = await runCase(cfg);
		expect(out).toContain("[routes] disabled: domain-list0::Wireguard0");
		expect(out).toContain("route object-group domain-list0 Wireguard0 auto");
		expect(out).toContain("route disable");
	});

	it("не убирает натуральные суффиксы (Office365) и обрабатывает спецсимволы", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list10
 description Office365
!
object-group fqdn domain-list11
 description Foo & Bar+
`,
			routeInterface: "Wireguard0",
			fetchFn: async (url) => {
				if (url.endsWith("office365")) return "example.com\n";
				if (url.endsWith("foo-bar")) return "foo.com\n";
				return "";
			},
		});
		const out = await runCase(cfg);
		expect(out).toContain("[sync] domain-list10 <= office365");
		expect(out).toContain("[sync] domain-list11 <= foo-bar");
	});

	it("обрабатывает disable, отделённый другими строками", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description Testlist
!
route object-group domain-list0 Wireguard0 auto
tls upstream 8.8.8.8 sni dns.google
route disable
`,
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).toContain("[routes] disabled: domain-list0::Wireguard0");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0 auto");
		expect(out).toContain("dns-proxy route disable");
	});

	it("игнорирует disable без предыдущего маршрута в блоке", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description Testlist
!
route disable
`,
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).not.toContain("[routes] disabled:");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0 auto");
	});

	it("логирует ошибки загрузки include-целей (404-подобные)", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description broken
`,
			routeInterface: "Wireguard0",
			fetchFn: async (url: string) => {
				if (url.endsWith("broken")) return "include:missing\n";
				throw new Error("HTTP 404");
			},
		});
		const out = await runCase(cfg);
		expect(out).toContain("[error] failed to load broken: failed to fetch");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0 auto");
	});

	it("режет очень большие списки на много частей", async () => {
		const bigDomains = Array.from({ length: 205 }, (_, i) => `domain${i}.com`).join("\n");
		const cfg = makeConfig({
			maxEntriesPerGroup: 50,
			routeInterface: "Wireguard0",
			runningConfigText: `
object-group fqdn domain-list0
 description biglist
`,
			fetchFn: async (url: string) => {
				if (url.endsWith("biglist")) return bigDomains;
				return "";
			},
		});
		const out = await runCase(cfg);
		expect(out).toContain("[sync] domain-list0 <= biglist: 205 domain(s) [split into 5 groups]");
		expect(out).toContain("object-group fqdn domain-list0 include domain0.com");
		expect(out).toContain('object-group fqdn domain-list0-5 description "biglist 5"');
	});

	it("парсит маршруты отдельно по интерфейсам", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description Testlist
!
route object-group domain-list0 Wireguard0 auto
route object-group domain-list0 L2 auto
route disable
`,
			routeInterface: "Wireguard0",
		});
		const out = await runCase(cfg);
		expect(out).toContain("[routes] disabled: domain-list0::L2");
		expect(out).toContain("dns-proxy route object-group domain-list0 Wireguard0 auto");
	});

	it("предупреждает и пропускает при пустом/дублированном описании", async () => {
		const cfg = makeConfig({
			runningConfigText: `
object-group fqdn domain-list0
 description
!
object-group fqdn domain-list1
 description Foo
 description Bar
`,
			fetchFn: async () => "",
		});
		const out = await runCase(cfg);
		expect(out).toContain("[discover:warn] skip domain-list0: empty or invalid description");
		expect(out).toContain("[discover:warn] multiple descriptions for domain-list1");
	});
});

describe("http server", () => {
	it("отрабатывает /sync и вызывает runConfig", async () => {
		const runSpy = vi.fn().mockResolvedValue(undefined);
		const handler = createSyncHandler(makeConfig(), { run: runSpy });

		const { req, res, awaitEnd } = makeReqRes("/sync", "GET");
		await handler(req, res);
		const result = await awaitEnd;

		expect(result.status).toBe(200);
		expect(runSpy).toHaveBeenCalledTimes(1);

		runSpy.mockRestore();
	});

	it("возвращает 429 при параллельном запросе", async () => {
		let release!: () => void;
		const block = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runSpy = vi.fn().mockImplementation(async () => block);
		const handler = createSyncHandler(makeConfig(), { run: runSpy });

		const first = makeReqRes("/sync", "POST");
		const second = makeReqRes("/sync", "GET");
		const firstPromise = handler(first.req, first.res);
		const secondPromise = handler(second.req, second.res);

		const secondRes = await second.awaitEnd;
		expect(secondRes.status).toBe(429);
		expect(runSpy).toHaveBeenCalledTimes(1);

		release();
		await firstPromise;
		await secondPromise;
		const firstRes = await first.awaitEnd;
		expect(firstRes.status).toBe(200);

		runSpy.mockRestore();
	});

	it("возвращает 405 и 404 на неподдерживаемые запросы", async () => {
		const runSpy = vi.fn().mockResolvedValue(undefined);
		const handler = createSyncHandler(makeConfig(), { run: runSpy });

		const badMethod = makeReqRes("/sync", "PUT");
		const notFound = makeReqRes("/other", "GET");
		const badClean = makeReqRes("/clean", "PUT");
		await handler(badMethod.req, badMethod.res);
		await handler(notFound.req, notFound.res);
		await handler(badClean.req, badClean.res);

		const badResult = await badMethod.awaitEnd;
		const notFoundResult = await notFound.awaitEnd;
		const badCleanResult = await badClean.awaitEnd;

		expect(badResult.status).toBe(405);
		expect(notFoundResult.status).toBe(404);
		expect(badCleanResult.status).toBe(405);
		expect(runSpy).not.toHaveBeenCalled();

		runSpy.mockRestore();
	});

	it("отвечает 200 на /health без запуска синка", async () => {
		const runSpy = vi.fn().mockResolvedValue(undefined);
		const handler = createSyncHandler(makeConfig(), { run: runSpy });

		const ping = makeReqRes("/health", "GET");
		await handler(ping.req, ping.res);
		const res = await ping.awaitEnd;

		expect(res.status).toBe(200);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("запускает dropAll для /clean", async () => {
		const runSpy = vi.fn().mockResolvedValue(undefined);
		const dropSpy = vi.fn().mockResolvedValue(undefined);
		const handler = createSyncHandler(makeConfig(), { run: runSpy, drop: dropSpy });

		const reqRes = makeReqRes("/clean", "POST");
		await handler(reqRes.req, reqRes.res);
		const res = await reqRes.awaitEnd;

		expect(res.status).toBe(200);
		expect(runSpy).not.toHaveBeenCalled();
		expect(dropSpy).toHaveBeenCalledTimes(1);
	});
});

describe("parser", () => {
	it("парсит атрибуты и сохраняет регэксп без изменения регистра", () => {
		const rules = parseDomainList(`
full:Example.COM @Ru
regexp:^ChatGPT-Async-WebPs-Prod-\\S+-\\d+\\.webpubsub\\.azure\\.com$ @Ads
`);

		expect(rules).toHaveLength(2);
		expect(rules[0]).toEqual({
			kind: "full",
			value: "example.com",
			attrs: [{ key: "ru", value: true }],
		});
		expect(rules[1]?.value).toBe("^ChatGPT-Async-WebPs-Prod-\\S+-\\d+\\.webpubsub\\.azure\\.com$");
		expect(rules[1]?.attrs).toEqual([{ key: "ads", value: true }]);
	});

	it("фильтрует include по атрибутам и учитывает отрицание", async () => {
		const ctx = createFetchContext("mock://", 500, 1, fetchFn);

		const res = await collectDomains("attr-include", ctx);
		expect([...res.domains].sort()).toEqual(["bar.com", "baz.com", "foo.com", "qux.com"]);
		expect(res.skipped).toEqual({ keyword: 1, regexp: 1 });
		expect(res.includes).toBe(2);
		expect(res.total).toBe(14);

		const neg = await collectDomains("attr-include-neg", ctx);
		expect([...neg.domains].sort()).toEqual(["baz.com", "foo.com"]);
		expect(neg.skipped).toEqual({ keyword: 0, regexp: 0 });
	});

	it("не дублирует include с одинаковым атрибутом и считает статистику как в Go", async () => {
		const ctx = createFetchContext("mock://", 500, 1, fetchFn);

		const res = await collectDomains("attr-include-dup", ctx);
		expect([...res.domains].sort()).toEqual(["bar.com", "baz.com", "foo.com", "qux.com"]);
		expect(res.includes).toBe(3);
		expect(res.total).toBe(15);
		expect(res.skipped).toEqual({ keyword: 2, regexp: 2 });
	});

	it("выбрасывает ошибки на некорректные строки/атрибуты", () => {
		expect(() => parseDomainList("include:\n")).toThrow();
		expect(() => parseDomainList("foo @@@\n")).toThrow();
	});
});
