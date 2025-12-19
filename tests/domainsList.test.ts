import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectDomains, createFetchContext, parseDomainList } from "../src/domainsList";

const dataRoot = path.join(__dirname, "fixtures", "data");

const fetchFn = async (url: string): Promise<string> => {
	const relative = url.startsWith("mock://") ? url.slice("mock://".length) : url;
	return fs.promises.readFile(path.join(dataRoot, relative), "utf8");
};

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
