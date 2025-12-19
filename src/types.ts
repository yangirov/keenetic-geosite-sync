// Конфигурация приложения, загружаемая из config.json.
export type Config = {
	baseUrl?: string;
	timeoutMs?: number;
	prefix?: string;
	dryRun?: boolean;
	maxEntriesPerGroup?: number;
	retries?: number;
	routeInterface?: string;
	initialDomains?: string[];
	fetchFn?: (url: string, timeoutMs: number) => Promise<string>;
	runningConfigText?: string;
};

// Опции исполнения команд ndmc.
export type ExecOpts = { dryRun?: boolean };

// Поддерживаемые типы правил doman-list.
export type RuleKind = "include" | "domain" | "full" | "keyword" | "regexp";

// Атрибуты правил doman-list (используются для include-фильтров).
export type DomainAttribute = {
	key: string;
	value?: number | boolean;
};

// Универсальное правило списка доменов.
export type DomainListRule = {
	kind: RuleKind;
	value: string;
	attrs?: DomainAttribute[];
};

// Статистика пропусков по keyword/regexp.
export type SkipStats = { keyword: number; regexp: number };

// Результат загрузки доменного списка.
export type DomainLoadResult = {
	domains: Set<string>;
	skipped: SkipStats;
	includes: number;
	total: number;
};

// Контекст для загрузки списков доменов.
export type DomainListFetchContext = {
	baseUrl: string;
	timeoutMs: number;
	retries: number;
	fetchFn?: (url: string, timeoutMs: number) => Promise<string>;
};

// Найденная в конфиге группа доменов.
export type DiscoveredList = {
	name: string;
	slug: string;
	description: string;
};
