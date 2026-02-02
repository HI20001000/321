import fs from "fs/promises";
import path from "path";

const LOG_ROOT = path.resolve(process.cwd(), "logs");
const MAX_LOG_BYTES = Number(process.env.DB_AUDIT_LOG_MAX_BYTES || 1024 * 1024);
const MAX_DATA_ENTRIES = Number(process.env.DB_AUDIT_LOG_MAX_DATA || 50);

function padNumber(value) {
    return String(value).padStart(2, "0");
}

function formatDateStamp(date) {
    return [
        date.getFullYear(),
        padNumber(date.getMonth() + 1),
        padNumber(date.getDate())
    ].join("");
}

function formatTimestamp(date) {
    return [
        `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`,
        `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`
    ].join(" ");
}

function normaliseIp(ip) {
    if (typeof ip !== "string") {
        return "unknown";
    }
    const trimmed = ip.trim();
    if (!trimmed) {
        return "unknown";
    }
    const first = trimmed.split(",")[0]?.trim();
    if (!first) {
        return "unknown";
    }
    if (first.startsWith("::ffff:")) {
        return first.slice("::ffff:".length);
    }
    return first;
}

function normaliseDataPayload(data) {
    if (Array.isArray(data)) {
        const trimmed = data.slice(0, Math.max(0, MAX_DATA_ENTRIES));
        if (data.length > trimmed.length) {
            trimmed.push(`...+${data.length - trimmed.length}`);
        }
        return trimmed;
    }
    if (data === null || data === undefined) {
        return [];
    }
    return [data];
}

async function resolveLogFilePath(dateStamp) {
    const dirPath = path.join(LOG_ROOT, dateStamp);
    await fs.mkdir(dirPath, { recursive: true });
    let files = [];
    try {
        files = await fs.readdir(dirPath);
    } catch (_error) {
        files = [];
    }
    const batchMatches = files
        .map((filename) => {
            const match = filename.match(new RegExp(`^${dateStamp}_log_(\\d+)$`));
            if (!match) {
                return null;
            }
            return Number(match[1]);
        })
        .filter((value) => Number.isFinite(value));
    let batch = batchMatches.length ? Math.max(...batchMatches) : 1;
    const filePath = path.join(dirPath, `${dateStamp}_log_${batch}`);
    try {
        const stat = await fs.stat(filePath);
        if (stat.size >= MAX_LOG_BYTES) {
            batch += 1;
        }
    } catch (_error) {
        // Ignore missing file or stat errors and use the current batch.
    }
    return path.join(dirPath, `${dateStamp}_log_${batch}`);
}

export async function logDbMutation({ ip, action, table, data }) {
    try {
        const now = new Date();
        const dateStamp = formatDateStamp(now);
        const timestamp = formatTimestamp(now);
        const safeIp = normaliseIp(ip);
        const safeAction = action || "UNKNOWN";
        const safeTable = table || "unknown";
        const payload = normaliseDataPayload(data);
        const line = `[${timestamp}] [INFO] [SQL] ip=${safeIp} action=${safeAction} table=${safeTable} data=${JSON.stringify(payload)}`;

        console.log(line);

        const filePath = await resolveLogFilePath(dateStamp);
        await fs.appendFile(filePath, `${line}\n`);
    } catch (error) {
        console.warn("[audit] Failed to write DB audit log", error);
    }
}
