import { generateReportViaDify } from "../services/reportService.js";

function flattenMethodBlocks(classMethods = []) {
    if (!Array.isArray(classMethods)) {
        return [];
    }
    const blocks = [];
    classMethods.forEach(({ className, methods }) => {
        const classLabel = className || "UnknownClass";
        if (!Array.isArray(methods)) return;
        methods.forEach(({ signature, block }) => {
            if (!block) return;
            blocks.push({
                className: classLabel,
                signature: signature || "(anonymous)",
                block
            });
        });
    });
    return blocks;
}

function extractReportText(result) {
    if (!result) return "";
    if (typeof result.report === "string") {
        return result.report;
    }
    if (typeof result.rawReport === "string") {
        return result.rawReport;
    }
    if (typeof result.analysis?.result === "string") {
        return result.analysis.result;
    }
    if (typeof result === "string") {
        return result;
    }
    return "";
}

function buildBlockHeading(className, signature) {
    const safeClass = className || "UnknownClass";
    const safeSignature = signature || "(anonymous)";
    return `【${safeClass}::${safeSignature}】`;
}

/**
 * Send individual Java method blocks to Dify and aggregate the returned report chunks.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.projectName
 * @param {string} params.path
 * @param {Array<{ className: string, methods: Array<{ signature: string, block: string }> }>} params.classMethods
 * @returns {Promise<{ blocks: Array<{ className: string, signature: string, block: string, report: string, raw?: any }>, combinedReport: string }>}
 */
export async function processJavaBlocksWithDify({
    projectId,
    projectName,
    path,
    classMethods = []
} = {}) {
    const methodBlocks = flattenMethodBlocks(classMethods);
    if (!methodBlocks.length) {
        return { blocks: [], combinedReport: "" };
    }

    const processedBlocks = [];

    for (const entry of methodBlocks) {
        const payload = {
            projectId,
            projectName,
            path,
            content: entry.block
        };

        try {
            const result = await generateReportViaDify(payload);
            processedBlocks.push({
                ...entry,
                report: extractReportText(result),
                raw: result
            });
        } catch (error) {
            const message = error?.message ? String(error.message) : String(error);
            processedBlocks.push({
                ...entry,
                report: `Error: ${message}`
            });
        }
    }

    const combinedReport = processedBlocks
        .map(({ className, signature, report }) => `${buildBlockHeading(className, signature)}\n${report || ""}`)
        .join("\n\n")
        .trim();

    if (combinedReport) {
        console.log("[Java Dify] Aggregated report blocks:\n", combinedReport);
    } else {
        console.log("[Java Dify] No Java report blocks generated.");
    }

    return {
        blocks: processedBlocks,
        combinedReport
    };
}

export default processJavaBlocksWithDify;
