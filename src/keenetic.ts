import { execFileSync } from "node:child_process";
import type { DiscoveredList, ExecOpts } from "./types";

// Убираем суффиксы сплита вида [1/2] и числовые хвосты.
function stripChunkSuffix(value: string): string {
	let result = value.trim();

	// drop repeated [n/m] suffixes
	for (;;) {
		const next = result.replace(/\s*\[\d+\/\d+]\s*$/, "").trim();
		if (next === result) break;
		result = next;
	}

	// drop trailing "-2", " 2" etc.
	return result.replace(/\s+-?\d+$/, "").trim();
}

// Нормализуем description группы.
function normalizeDescription(desc?: string): string {
	return stripChunkSuffix(desc ?? "");
}

// Получаем слаг из description для поиска в v2fly.
function slugFromDescription(desc?: string): string | null {
	const normalized = normalizeDescription(desc).toLowerCase();
	if (!normalized) return null;

	const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

	return slug || null;
}

// Выполняем команду ndmc, в dryRun только логируем.
export function ndmc(command: string, opts: ExecOpts = {}): string {
	if (opts.dryRun) {
		console.log(`[dryRun] ndmc -c ${command}`);
		return "";
	}

	try {
		return execFileSync("ndmc", ["-c", command], {
			encoding: "utf8",
		}).trim();
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT" || err.code === "EACCES") {
			const hint =
				"ndmc недоступен (нет бинаря или прав); запустите на Keenetic или включите dryRun";
			const wrapped = new Error(`${hint}: ${command}`);
			(wrapped as Error & { cause?: unknown }).cause = err;
			throw wrapped;
		}
		throw error;
	}
}

// Безопасный вызов ndmc с подавлением ожидаемых ошибок.
export function ndmcTry(command: string, opts: ExecOpts = {}): string {
	try {
		return ndmc(command, opts);
	} catch (error) {
		const err = error as Partial<{
			status: number | string;
			stderr: unknown;
			message: string;
		}>;

		const status = err.status !== undefined ? String(err.status) : "";
		const stderr = String(err.stderr ?? "").toLowerCase();

		const isDeleteMissing =
			command.startsWith("no object-group fqdn") &&
			(status === "123" || stderr.includes("not found") || stderr.includes("unknown"));

		if (isDeleteMissing) return "";

		const details: string[] = [];
		if (err.message) details.push(err.message);
		if (status) details.push(`status=${status}`);
		if (stderr) details.push(`stderr=${stderr.slice(0, 200)}`);

		console.warn(`[ndmc:warn] command failed: "${command}" (${details.join("; ")})`);

		return "";
	}
}

// Считываем текущий running-config с роутера.
export function getRunningConfig(_: ExecOpts): string {
	return ndmcTry("show running-config", { dryRun: false });
}

type ObjectGroupBlock = {
	name: string;
	description?: string;
};

// Ищем в running-config группы доменов с нужным префиксом.
export function discoverLists(runningConfig: string, prefix: string): DiscoveredList[] {
	console.log(`[discover] running-config length=${runningConfig.length}`);

	const blocks: ObjectGroupBlock[] = [];
	let current: ObjectGroupBlock | null = null;

	for (const rawLine of runningConfig.split(/\r?\n/)) {
		const line = rawLine.trim();

		if (line === "!") {
			if (current) blocks.push(current);
			current = null;
			continue;
		}

		const start = line.match(/^object-group\s+fqdn\s+(\S+)/i);
		if (start) {
			if (current) blocks.push(current);
			current = { name: start[1] };
			continue;
		}

		if (current && line.startsWith("description")) {
			const desc = line
				.slice("description".length)
				.trim()
				.replace(/^"+|"+$/g, "");

			if (!current.description) {
				current.description = desc;
			} else if (current.description !== desc) {
				console.warn(`[discover:warn] multiple descriptions for ${current.name}, keeping first`);
			}
		}
	}

	if (current) blocks.push(current);

	const effectivePrefix = prefix || "";
	const result: DiscoveredList[] = [];

	for (const block of blocks) {
		if (!block.name.startsWith(effectivePrefix)) continue;

		const description = normalizeDescription(block.description);
		const slug = slugFromDescription(description);

		if (!slug) {
			console.warn(`[discover:warn] skip ${block.name}: empty or invalid description`);
			continue;
		}

		result.push({
			name: block.name,
			slug,
			description,
		});
	}

	console.log(
		`[discover] matched groups: ${
			result.map((g) => g.name).join(", ") || "none"
		} (prefix="${effectivePrefix}")`,
	);

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Пересоздаём группу FQDN и добавляем include для каждого домена.
export function recreateFqdnGroup(
	groupName: string,
	entries: string[],
	{ dryRun, description }: ExecOpts & { description?: string },
): void {
	ndmcTry(`no object-group fqdn ${groupName}`, { dryRun });
	const created = ndmcTry(`object-group fqdn ${groupName}`, { dryRun });
	const creationOk = dryRun || Boolean(created);
	if (!creationOk) {
		console.warn(`[ndmc:warn] failed to create group ${groupName}, skipping includes`);
		return;
	}

	if (description) {
		const escaped = description.replace(/"/g, '\\"');
		ndmc(`object-group fqdn ${groupName} description "${escaped}"`, { dryRun });
	}

	let applied = 0;
	let firstFailed: string | null = null;

	for (const value of entries) {
		const cmd = `object-group fqdn ${groupName} include ${value}`;
		const res = ndmcTry(cmd, { dryRun });

		if (res !== "") {
			applied++;
		} else if (!firstFailed) {
			firstFailed = cmd;
		}
	}

	if (applied !== entries.length) {
		console.warn(
			`[ndmc:warn] applied ${applied}/${entries.length} include(s) for ${groupName}` +
				(firstFailed ? ` (first failed: ${firstFailed})` : ""),
		);
	}
}
