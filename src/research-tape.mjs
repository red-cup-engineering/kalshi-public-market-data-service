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
  attention = null,
  capturedAt = new Date().toISOString(),
  source = "kalshi-public-market-data-service",
} = {}) {
  if (!nonEmpty(recordType) || !nonEmpty(source)) throw new TypeError("tape-record-type-and-source-required");
  if (!payload || typeof payload !== "object") throw new TypeError("tape-record-payload-required");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new TypeError("valid-tape-capture-time-required");
  assayNoCredentialMaterial(payload);
  if (attention !== null) {
    if (!attention || typeof attention !== "object" || Array.isArray(attention) ||
        !Number.isInteger(attention.requestCount) || attention.requestCount < 1 ||
        !Number.isFinite(attention.wallDurationMs) || attention.wallDurationMs < 0 ||
        !Number.isFinite(attention.summedRequestDurationMs) || attention.summedRequestDurationMs < 0 ||
        !Number.isSafeInteger(attention.payloadBytesEstimate) || attention.payloadBytesEstimate < 0 ||
        !attention.components || typeof attention.components !== "object" ||
        Object.keys(attention.components).length < 1 ||
        Object.keys(attention.components).length > 8)
      throw new TypeError("bounded-transport-attention-required");
    const components = Object.values(attention.components);
    if (components.some(row => !row || row.transport !== "rest" ||
        row.requestCount !== 1 || !Number.isFinite(row.durationMs) || row.durationMs < 0 ||
        !Number.isSafeInteger(row.payloadBytesEstimate) || row.payloadBytesEstimate < 0 ||
        !["accept", "http-reject", "network-error"].includes(row.outcome)) ||
        components.length !== attention.requestCount ||
        components.reduce((sum,row)=>sum + row.payloadBytesEstimate,0) !== attention.payloadBytesEstimate)
      throw new TypeError("incoherent-transport-attention-components");
    assayNoCredentialMaterial(attention);
  }

  const body = {
    type: "KalshiResearchTapeRecord",
    schemaVersion: 1,
    recordType,
    source,
    capturedAt,
    payload,
    ...(attention === null ? {} : { attention }),
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
