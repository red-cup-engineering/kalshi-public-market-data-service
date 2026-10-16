import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function semanticId(value) {
  return `ni:///sha-256;${createHash("sha256").update(canonical(value)).digest("base64url")}`;
}

const FORBIDDEN_KEY = /(private.?key|access.?signature|authorization|api.?key)/i;

function assayNoCredentialMaterial(value, path = "$") {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assayNoCredentialMaterial(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError(`credential-material-forbidden-at-${path}.${key}`);
    assayNoCredentialMaterial(child, `${path}.${key}`);
  }
}

export function formTapeRecord({
  recordType,
  payload,
  capturedAt = new Date().toISOString(),
  source = "kalshi-public-market-data-service",
} = {}) {
  if (!nonEmpty(recordType) || !nonEmpty(source)) throw new TypeError("tape-record-type-and-source-required");
  if (!payload || typeof payload !== "object") throw new TypeError("tape-record-payload-required");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new TypeError("valid-tape-capture-time-required");
  assayNoCredentialMaterial(payload);

  const body = {
    type: "KalshiResearchTapeRecord",
    schemaVersion: 1,
    recordType,
    source,
    capturedAt,
    payload,
  };
  return Object.freeze({
    id: semanticId(body),
    ...body,
  });
}

export async function appendTapeRecord(filePath, record) {
  if (!nonEmpty(filePath)) throw new TypeError("tape-file-path-required");
  if (!record || record.type !== "KalshiResearchTapeRecord" || !nonEmpty(record.id)) {
    throw new TypeError("kalshi-research-tape-record-required");
  }
  assayNoCredentialMaterial(record);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return Object.freeze({ filePath, id: record.id });
}

export async function readTapeRecords(filePath) {
  if (!nonEmpty(filePath)) throw new TypeError("tape-file-path-required");
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TypeError(`invalid-tape-json-line-${index + 1}`);
    }
    if (parsed?.type !== "KalshiResearchTapeRecord" || !nonEmpty(parsed.id)) {
      throw new TypeError(`invalid-tape-record-line-${index + 1}`);
    }
    assayNoCredentialMaterial(parsed);
    const { id, ...body } = parsed;
    if (semanticId(body) !== id) throw new TypeError(`tape-content-id-mismatch-line-${index + 1}`);
    return Object.freeze(parsed);
  });
  return Object.freeze(records);
}

export function selectTapeAsOf(records, decisionAt, {
  recordType = null,
  key = null,
  value = null,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError("tape-records-array-required");
  const decisionMs = Date.parse(decisionAt);
  if (!Number.isFinite(decisionMs)) throw new TypeError("valid-decision-time-required");

  const eligible = records.filter((record) => {
    if (!record || record.type !== "KalshiResearchTapeRecord") throw new TypeError("kalshi-research-tape-record-required");
    if (Date.parse(record.capturedAt) > decisionMs) return false;
    if (recordType !== null && record.recordType !== recordType) return false;
    if (key !== null && record.payload?.[key] !== value) return false;
    return true;
  });

  eligible.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  return eligible.length > 0 ? eligible[eligible.length - 1] : null;
}
