import https from "node:https";
import type {
	DomainAttribute,
	DomainListFetchContext,
	DomainListRule,
	DomainLoadResult,
	RuleKind,
} from "./types";

// Простая загрузка текста по HTTPS с таймаутом и user-agent.
function httpGetText(url: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{
				timeout: timeoutMs,
				headers: { "user-agent": "keenetic-geosite-sync/1.0" },
			},
			(res) => {
				if (res.statusCode && res.statusCode >= 400) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode} for ${url}`));
					return;
				}

				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve(body));
			},
		);

		req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms for ${url}`)));
		req.on("error", reject);
	});
}

// Убираем комментарии после # и пробелы по краям строки.
function stripComment(line: string): string {
	const hashIndex = line.indexOf("#");
	return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

// Парсим атрибуты вида @ru или @!ads=1.
function parseAttribute(token: string): DomainAttribute | null {
	if (!token.startsWith("@") || token === "@") return null;

	const [, raw] = token.split("@");
	const [keyRaw, valueRaw] = raw.split("=");
	const key = keyRaw?.toLowerCase();
	if (!key) throw new Error(`invalid attribute: ${token}`);

	if (valueRaw === undefined) return { key, value: true };

	const intValue = Number.parseInt(valueRaw, 10);
	if (Number.isNaN(intValue)) throw new Error(`invalid attribute: ${token}`);

	return { key, value: intValue };
}

// Парсим строку списка в структуру DomainListRule.
function parseRule(tokens: string[]): DomainListRule {
	const attrs: DomainAttribute[] = [];
	const payload: string[] = [];

	for (const token of tokens) {
		const attr = parseAttribute(token);
		if (attr) {
			attrs.push(attr);
			continue;
		}
		payload.push(token);
	}

	const [head, next] = payload;
	if (!head) throw new Error("empty entry");

	if (head.startsWith("include:")) {
		const value = head.slice("include:".length) || next;
		if (!value) throw new Error("include without target");
		return { kind: "include", value: value.toLowerCase(), attrs };
	}

	if (head === "include") {
		if (!next) throw new Error("include without target");
		return { kind: "include", value: next.toLowerCase(), attrs };
	}

	const colonIndex = head.indexOf(":");
	let kind: RuleKind = "domain";
	let value: string | undefined = head;

	if (colonIndex > 0) {
		kind = head.slice(0, colonIndex) as RuleKind;
		value = head.slice(colonIndex + 1) || next;
	}

	if (!["domain", "full", "keyword", "regexp"].includes(kind) || !value) {
		throw new Error(`invalid format: ${tokens.join(" ")}`);
	}

	const normalizedValue = kind === "regexp" ? value : value.toLowerCase();

	return { kind, value: normalizedValue, attrs };
}

// Разбираем текст doman-list в набор правил.
export function parseDomainList(text: string): DomainListRule[] {
	const rules: DomainListRule[] = [];

	for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = stripComment(rawLine);
		if (!line) continue;

		const tokens = line.trim().split(/\s+/).filter(Boolean);
		if (!tokens.length) continue;

		rules.push(parseRule(tokens));
	}

	return rules;
}

// Загружаем правила конкретного списка с ретраями.
async function loadRules(key: string, ctx: DomainListFetchContext): Promise<DomainListRule[]> {
	const url = ctx.baseUrl + encodeURIComponent(key);
	const fetch = ctx.fetchFn ?? httpGetText;

	let lastError: unknown;

	for (let attempt = 1; attempt <= ctx.retries; attempt++) {
		try {
			const text = await fetch(url, ctx.timeoutMs);
			return parseDomainList(text);
		} catch (err) {
			lastError = err;
			if (attempt === ctx.retries) break;

			const delay = Math.min(3000, attempt * 500);
			await new Promise((r) => setTimeout(r, delay));
		}
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError);

	throw new Error(`failed to fetch ${url}: ${message}`);
}

function matchesAttr(ruleAttrs: DomainAttribute[] | undefined, includeKey: string): boolean {
	let isMatch = false;
	let mustMatch = true;
	let matchName = includeKey;
	if (includeKey.startsWith("!")) {
		isMatch = true;
		mustMatch = false;
		matchName = includeKey.replace(/^!+/, "");
	}

	for (const attr of ruleAttrs ?? []) {
		const attrName = attr.key;
		if (mustMatch) {
			if (matchName === attrName) {
				isMatch = true;
				break;
			}
		} else if (matchName === attrName) {
			isMatch = false;
			break;
		}
	}

	return isMatch;
}

type ResolveCache = Map<string, DomainListRule[]>;

type ResolvedRules = {
	rules: DomainListRule[];
	includes: number;
	total: number;
};

async function loadRulesCached(
	key: string,
	ctx: DomainListFetchContext,
	cache: ResolveCache,
): Promise<DomainListRule[]> {
	const cached = cache.get(key);
	if (cached) return cached;

	const rules = await loadRules(key, ctx);
	cache.set(key, rules);
	return rules;
}

async function resolveRules(
	key: string,
	ctx: DomainListFetchContext,
	cache: ResolveCache,
	inclusionSet: Set<string>,
	stack: string[],
	attrFilter?: string,
): Promise<ResolvedRules> {
	if (stack.includes(key)) {
		throw new Error(`include cycle: ${[...stack, key].join(" -> ")}`);
	}

	const rawRules = await loadRulesCached(key, ctx, cache);
	const filtered = attrFilter ? rawRules.filter((r) => matchesAttr(r.attrs, attrFilter)) : rawRules;

	const result: ResolvedRules = {
		rules: [],
		includes: 0,
		total: rawRules.length,
	};

	for (const rule of filtered) {
		if (rule.kind !== "include") {
			result.rules.push(rule);
			continue;
		}

		result.includes += 1;

		const attrList = rule.attrs?.length ? rule.attrs : [null];
		for (const attr of attrList) {
			const inclusionKey = attr ? `${rule.value}@${attr.key}` : rule.value;
			if (inclusionSet.has(inclusionKey)) continue;
			inclusionSet.add(inclusionKey);

			const child = await resolveRules(
				rule.value,
				ctx,
				cache,
				inclusionSet,
				[...stack, key],
				attr?.key,
			);

			result.includes += child.includes;
			result.total += child.total;
			result.rules.push(...child.rules);
		}
	}

	return result;
}

// Собираем домены, раскрывая include-правила и накапливая статистику.
export async function collectDomains(
	key: string,
	ctx: DomainListFetchContext,
	stack: string[] = [],
): Promise<DomainLoadResult> {
	const cache = new Map<string, DomainListRule[]>();
	const inclusionSet = new Set<string>();
	const { rules, includes, total } = await resolveRules(key, ctx, cache, inclusionSet, stack);

	const result: DomainLoadResult = {
		domains: new Set<string>(),
		skipped: { keyword: 0, regexp: 0 },
		includes,
		total,
	};

	for (const rule of rules) {
		if (rule.kind === "keyword") {
			result.skipped.keyword++;
			continue;
		}

		if (rule.kind === "regexp") {
			result.skipped.regexp++;
			continue;
		}

		result.domains.add(rule.value);
	}

	return result;
}

// Удобный конструктор контекста загрузки списков.
export function createFetchContext(
	baseUrl: string,
	timeoutMs: number,
	retries: number,
	fetchFn?: DomainListFetchContext["fetchFn"],
): DomainListFetchContext {
	return { baseUrl, timeoutMs, retries, fetchFn };
}
