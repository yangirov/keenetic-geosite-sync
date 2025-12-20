import path from "node:path";
import { collectDomains, createFetchContext } from "./domainsList";
import { discoverLists, getRunningConfig, ndmcTry, recreateFqdnGroup } from "./keenetic";
import { startHttpServer } from "./server";
import type { Config, DiscoveredList } from "./types";
import { chunk, desiredGroupNames, isObject, normalizeBaseUrl, readJson } from "./utils";

const DEFAULT_BASE_URL =
	"https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/";
const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_DELAY_BETWEEN_LISTS_MS = 500;

// Убираем служебные суффиксы вроде [1/2] или "-2" из описания.
function stripChunkSuffix(desc: string): string {
	let current = desc.trim();
	while (true) {
		const next = current.replace(/\s*\[\d+\/\d+]\s*$/, ""); // drop [n/m] suffixes
		if (next === current) break;
		current = next.trim();
	}
	// drop trailing " -<n>" or " <n>" chunks (with preceding space) to handle splits like "Facebook -2" / "Facebook 2"
	current = current
		.replace(/\s+-\d+$/, "")
		.replace(/\s+\d+$/, "")
		.trim();
	return current;
}

// Преобразуем описание группы в слаг для имени файла из v2fly.
function slugifyDescription(desc: string): string {
	const cleaned = stripChunkSuffix(desc);
	return cleaned
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Собираем уже занятые индексы групп по префиксу.
function collectUsedIndexes(runningConfig: string, prefix: string): Set<number> {
	const used = new Set<number>();
	const pattern = new RegExp(`^object-group\\s+fqdn\\s+${prefix}(\\d+)`, "i");
	for (const raw of runningConfig.split(/\r?\n/)) {
		const line = raw.trim();
		const match = line.match(pattern);
		if (match) used.add(Number.parseInt(match[1], 10));
	}
	return used;
}

// Берём следующий свободный индекс и имя группы.
function nextAvailableName(prefix: string, used: Set<number>): { name: string; index: number } {
	let idx = 0;
	while (used.has(idx)) idx += 1;
	used.add(idx);
	return { name: `${prefix}${idx}`, index: idx };
}

type RouteInfo = { auto: boolean; reject: boolean; disabled: boolean };
type RouteIndex = Map<string, RouteInfo>;

// Разбираем running-config и вытаскиваем маршруты DNS-прокси.
function parseRoutes(runningConfig: string): RouteIndex {
	const routes: RouteIndex = new Map();
	const pattern = /^(?:dns-proxy\s+)?route\s+object-group\s+(\S+)\s+(\S+)(.*)$/i;
	const disableLine = /^(?:dns-proxy\s+)?route\s+disable\b/i;
	let lastKey: string | null = null;
	let inDnsProxy = false;

	for (const raw of runningConfig.split(/\r?\n/)) {
		const line = raw
			.trim()
			.replace(/^"+|"+$/g, "") // drop surrounding quotes if present
			.replace(/,$/, ""); // drop trailing comma if present
		if (/^dns-proxy$/i.test(line)) {
			inDnsProxy = true;
			lastKey = null;
			continue;
		}
		if (inDnsProxy && line === "!") {
			inDnsProxy = false;
			lastKey = null;
			continue;
		}

		const match = line.match(pattern);
		if (match) {
			const [, group, iface, rest] = match;
			const tokens = rest.trim().split(/\s+/).filter(Boolean);
			const auto = tokens.includes("auto");
			const reject = tokens.includes("reject");
			const disabled = tokens.includes("disable") || tokens.includes("disabled");
			lastKey = `${group}::${iface}`;
			routes.set(lastKey, { auto, reject, disabled });
			continue;
		}
		if (disableLine.test(line) && lastKey) {
			const prev = routes.get(lastKey);
			if (prev) routes.set(lastKey, { ...prev, disabled: true });
			lastKey = null;
			continue;
		}
		if (/^(?:dns-proxy\s+)?route\b/i.test(line)) {
			// another route encountered; do not apply future disables to previous one
			lastKey = null;
		}
	}
	return routes;
}

// Ищем подходящий шаблон маршрута для новой группы или её части.
function findRouteTemplate(
	baseName: string,
	iface: string | undefined,
	routes: RouteIndex,
): RouteInfo | undefined {
	if (!iface) return undefined;
	const exact = routes.get(`${baseName}::${iface}`);
	if (exact) return exact;
	const baseRoot = baseName.replace(/-\d+$/, "");
	for (const [key, info] of routes) {
		const [group, routeIface] = key.split("::");
		if (routeIface !== iface) continue;
		if (group.startsWith(`${baseName}-`)) return info;
		if (baseRoot && group === baseRoot) return info;
		if (baseRoot && group.startsWith(`${baseRoot}-`)) return info;
	}
	return undefined;
}

// Состояние маршрутов: переиспользуем флаги и создаём недостающие.
function createRouteState(
	runningConfig: string,
	dryRun: boolean,
): {
	ensure: (groupName: string, iface: string | undefined, templateHint?: RouteInfo) => void;
	stats: { created: number };
	templates: RouteIndex;
} {
	const templateRoutes = parseRoutes(runningConfig);
	const disabledRoutes = [...templateRoutes.entries()]
		.filter(([, info]) => info.disabled)
		.map(([key]) => key);
	if (disabledRoutes.length) {
		console.log(`[routes] disabled: ${disabledRoutes.join(", ")}`);
	}
	const seen = new Set<string>();
	const stats = { created: 0 };
	const defaults: RouteInfo = { auto: true, reject: false, disabled: false };

	function ensure(groupName: string, iface: string | undefined, templateHint?: RouteInfo) {
		if (!iface) return;
		const key = `${groupName}::${iface}`;
		if (seen.has(key)) return;

		const template =
			templateHint ??
			templateRoutes.get(key) ??
			findRouteTemplate(groupName, iface, templateRoutes);
		const info = template ?? defaults;

		const tokens = ["dns-proxy route object-group", groupName, iface];
		if (info.auto) tokens.push("auto");
		if (info.reject) tokens.push("reject");

		const cmd = tokens.join(" ");
		console.log(`  [route] ${cmd}${info.disabled ? " (will disable)" : ""}`);
		ndmcTry(cmd, { dryRun });
		if (info.disabled) {
			const disableCmd = "dns-proxy route disable";
			console.log(`  [route] ${disableCmd}`);
			ndmcTry(disableCmd, { dryRun });
		}
		seen.add(key);
		stats.created += 1;
	}

	return { ensure, stats, templates: templateRoutes };
}

// Добавляем initialDomains, если подходящих групп ещё нет.
function provisionInitialDomains(
	existing: DiscoveredList[],
	cfg: Config,
	prefix: string,
	runningConfig: string,
): DiscoveredList[] {
	if (!cfg.initialDomains?.length) return existing;
	if (existing.length) {
		return existing;
	}

	const used = collectUsedIndexes(runningConfig, prefix);
	for (const item of existing) {
		const match = item.name.match(new RegExp(`^${prefix}(\\d+)$`));
		if (match) used.add(Number.parseInt(match[1], 10));
	}

	const bySlug = new Map<string, DiscoveredList>();
	for (const item of existing) bySlug.set(item.slug, item);

	const created: DiscoveredList[] = [];

	for (const raw of cfg.initialDomains) {
		const desc = String(raw || "").trim();
		const slug = slugifyDescription(desc);
		if (!desc || !slug) continue;
		if (bySlug.has(slug)) continue;

		const { name } = nextAvailableName(prefix, used);
		const item: DiscoveredList = { name, slug, description: desc };
		created.push(item);
		bySlug.set(slug, item);
		console.log(`[init] add ${name} (${desc} -> ${slug})`);
	}

	return [...existing, ...created];
}

// Ищем имена групп с заданным префиксом.
function findGroupNames(runningConfig: string, prefix: string): string[] {
	const names = new Set<string>();
	const pattern = /^object-group\s+fqdn\s+(\S+)/i;
	for (const raw of runningConfig.split(/\r?\n/)) {
		const line = raw.trim();
		const match = line.match(pattern);
		if (match?.[1].startsWith(prefix)) names.add(match[1]);
	}
	return [...names].sort();
}

// Убираем дубликаты по slug, оставляя базовую группу при сплите.
function dedupeLists(lists: DiscoveredList[]): DiscoveredList[] {
	const bySlug = new Map<string, DiscoveredList>();
	for (const item of lists) {
		const existing = bySlug.get(item.slug);
		if (!existing) {
			bySlug.set(item.slug, item);
			continue;
		}
		const isBase = !/-\d+$/.test(item.name);
		const existingIsBase = !/-\d+$/.test(existing.name);
		if (isBase && !existingIsBase) bySlug.set(item.slug, item);
	}
	return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Основной сценарий: поиск групп, загрузка списков, пересоздание и маршруты.
export async function runConfig(cfg: Config): Promise<void> {
	const dryRun = Boolean(cfg.dryRun);
	const baseUrl = normalizeBaseUrl(cfg.baseUrl ?? DEFAULT_BASE_URL);
	const timeoutMs = cfg.timeoutMs ?? 20000;
	const prefix = cfg.prefix ?? "domain-list";
	const maxEntriesPerGroup = cfg.maxEntriesPerGroup ?? DEFAULT_MAX_ENTRIES;
	const retries = cfg.retries ?? 3;
	const fetchFn = (cfg as Record<string, unknown>).fetchFn as Config["fetchFn"];
	const ctx = createFetchContext(baseUrl, timeoutMs, retries, fetchFn);

	const runningConfig = cfg.runningConfigText ?? getRunningConfig({ dryRun });
	const _existingGroups = new Set(findGroupNames(runningConfig, ""));
	const discovered = discoverLists(runningConfig, prefix);
	const lists = dedupeLists(provisionInitialDomains(discovered, cfg, prefix, runningConfig));
	const routeState = createRouteState(runningConfig, dryRun);

	console.log(
		`[config] baseUrl=${baseUrl}, prefix=${prefix}, timeoutMs=${timeoutMs}, dryRun=${dryRun}, maxEntriesPerGroup=${maxEntriesPerGroup}, retries=${retries}, routeInterface=${cfg.routeInterface || ""}`,
	);

	if (!lists.length) {
		console.log("No lists to sync (object-group fqdn with matching prefix not found).");
		return;
	}

	console.log(`[discover] found ${lists.length} group(s) with prefix "${prefix}"`);

	let applied = 0;
	let failed = 0;
	let index = 0;

	for (const item of lists) {
		if (index > 0) {
			const delay = dryRun ? 0 : DEFAULT_DELAY_BETWEEN_LISTS_MS;
			await sleep(delay);
		}
		let domains: string[] = [];
		let skipped = { keyword: 0, regexp: 0 };
		let includes = 0;
		let total = 0;

		try {
			const res = await collectDomains(item.slug, ctx);
			domains = [...res.domains].sort();
			skipped = res.skipped;
			includes = res.includes;
			total = res.total;
		} catch (err) {
			console.error(
				`[error] failed to load ${item.slug}: ${err instanceof Error ? err.message : String(err)}`,
			);
			const template = findRouteTemplate(item.name, cfg.routeInterface, routeState.templates);
			routeState.ensure(item.name, cfg.routeInterface, template);
			failed += 1;
			continue;
		}

		const chunks = chunk(domains, maxEntriesPerGroup);
		const desiredNames = desiredGroupNames(item.name, chunks.length);

		console.log(
			`[sync] ${item.name} <= ${item.slug}: ${domains.length} domain(s)` +
				(skipped.keyword || skipped.regexp || includes
					? `, skipped keyword=${skipped.keyword}, regexp=${skipped.regexp}, includes=${includes}, total=${total}`
					: "") +
				(chunks.length > 1 ? ` [split into ${chunks.length} groups]` : ""),
		);

		const baseDescription = stripChunkSuffix(item.description || item.slug);

		for (let i = 0; i < chunks.length; i += 1) {
			const groupName = desiredNames[i];
			const entries = chunks[i];
			const description = chunks.length > 1 ? `${baseDescription} ${i + 1}` : baseDescription;
			recreateFqdnGroup(groupName, entries, { dryRun, description });
		}

		if (chunks.length > 1) {
			console.log(
				`  [warn] group ${item.name} was split; update Keenetic routes to use: ${desiredNames.join(
					", ",
				)}`,
			);
		}

		for (const groupName of desiredNames) {
			const template = findRouteTemplate(groupName, cfg.routeInterface, routeState.templates);
			routeState.ensure(groupName, cfg.routeInterface, template);
		}

		applied += 1;
		index += 1;
	}

	if (!dryRun) ndmcTry("system configuration save", { dryRun: false });

	console.log(
		`Done. applied=${applied}, failed=${failed}, routesAdded=${routeState.stats.created}${
			failed ? " (see errors above)" : ""
		}`,
	);
}

// Удаляем все найденные группы и соответствующие маршруты.
export async function dropAll(cfg: Config): Promise<void> {
	const dryRun = Boolean(cfg.dryRun);
	const prefix = cfg.prefix ?? "domain-list";
	const runningConfig = cfg.runningConfigText ?? getRunningConfig({ dryRun });
	const groups = findGroupNames(runningConfig, prefix);

	console.log(`[drop] prefix=${prefix}, groups=${groups.length}`);
	for (const name of groups) {
		console.log(`  [drop] no object-group fqdn ${name}`);
		ndmcTry(`no object-group fqdn ${name}`, { dryRun });
	}
	if (!dryRun) ndmcTry("system configuration save", { dryRun: false });
	console.log("Drop complete.");
}

// Точка входа CLI: выбирает режим синхронизации или очистки.
async function main(): Promise<void> {
	const cmd = process.argv[2];
	const isDrop = cmd === "clean";
	const configPath = path.join(__dirname, "config.json");
	const cfg = readJson<Config | null>(configPath, null);
	if (!cfg || !isObject(cfg)) throw new Error(`Config not found or invalid JSON: ${configPath}`);
	console.log(`[config] path=${configPath}`);
	if (isDrop) {
		await dropAll(cfg);
		return;
	}

	startHttpServer(cfg, { run: runConfig, drop: dropAll });
	await runConfig(cfg);
}

export { createSyncHandler, startHttpServer } from "./server";

if (require.main === module) {
	main().catch((err) => {
		console.error("ERROR:", err instanceof Error ? err.stack : String(err));
		process.exit(1);
	});
}
