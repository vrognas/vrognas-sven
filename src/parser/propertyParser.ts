import { ensureArray, XmlParserAdapter } from "./xmlParserAdapter";

export interface SvnPropertyEntry {
  readonly path: string;
  readonly name: string;
  readonly value: string;
}

type XmlRecord = Record<string, unknown>;

function asRecord(value: unknown): XmlRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : undefined;
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  };
  return value.replace(
    /&(amp|apos|gt|lt|quot|#\d+|#x[\da-f]+);/gi,
    (entity, code: string) => {
      if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
      const numeric = code[1]?.toLowerCase() === "x";
      const point = Number.parseInt(
        code.slice(numeric ? 2 : 1),
        numeric ? 16 : 10
      );
      const valid =
        point === 0x9 ||
        point === 0xa ||
        point === 0xd ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff);
      return valid ? String.fromCodePoint(point) : entity;
    }
  );
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return decodeXmlEntities(String(value));
}

export function parseSvnPropertiesXml(content: string): SvnPropertyEntry[] {
  const parsed = XmlParserAdapter.parse(content, {
    mergeAttrs: true,
    explicitRoot: true,
    explicitArray: false,
    camelcase: true,
    preserveText: true
  });
  if (parsed === "") return [];

  const parsedRecord = asRecord(parsed);
  if (!parsedRecord) throw new Error("Invalid SVN properties XML root");
  const rooted = Object.prototype.hasOwnProperty.call(
    parsedRecord,
    "properties"
  );
  if (rooted && parsedRecord.properties === "") return [];
  const root = rooted ? asRecord(parsedRecord.properties) : parsedRecord;
  if (!root) throw new Error("Invalid SVN properties XML root");
  if (!root.target) {
    if (rooted) return [];
    throw new Error("Expected SVN properties XML root");
  }

  const entries: SvnPropertyEntry[] = [];
  for (const targetValue of ensureArray(root.target)) {
    const target = asRecord(targetValue);
    if (target?.path === undefined) {
      throw new Error("SVN property target is missing path");
    }
    const targetPath = text(target.path);
    for (const propertyValue of ensureArray(target.property)) {
      const property = asRecord(propertyValue);
      if (property?.name === undefined) {
        throw new Error("SVN property is missing name");
      }
      const name = text(property.name);
      let value = text(property._);
      if (property.encoding !== undefined) {
        if (property.encoding !== "base64") {
          throw new Error(
            `Unsupported SVN property encoding: ${property.encoding}`
          );
        }
        value = Buffer.from(value, "base64").toString("utf8");
      }
      entries.push({ path: targetPath, name, value });
    }
  }
  return entries;
}

export function propertyValues(
  entries: readonly SvnPropertyEntry[],
  name: string
): Map<string, string> {
  return new Map(
    entries
      .filter(entry => entry.name === name)
      .map(entry => [entry.path, entry.value] as const)
  );
}
