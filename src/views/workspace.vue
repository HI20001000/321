<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import { usePreview } from "../scripts/composables/usePreview.js";
import { useTreeStore } from "../scripts/composables/useTreeStore.js";
import { useProjectsStore } from "../scripts/composables/useProjectsStore.js";
import { useAiAssistant } from "../scripts/composables/useAiAssistant.js";
import * as fileSystemService from "../scripts/services/fileSystemService.js";
import { generateReportViaDify, fetchProjectReports } from "../scripts/services/reportService.js";
import {
    buildSummaryDetailList,
    updateIssueSummaryTotals,
    buildCombinedReportPayload,
    buildCombinedReportJsonExport,
    buildIssueDistributions,
    buildSourceSummaries,
    buildAggregatedSummaryRecords,
    collectAggregatedIssues,
    collectIssueSummaryTotals
} from "../scripts/reports/combinedReport.js";
import {
    collectStaticReportIssues,
    mergeStaticReportIntoAnalysis,
    buildStaticReportDetails
} from "../scripts/reports/staticReport.js";
import {
    collectAiReviewIssues,
    mergeAiReviewReportIntoAnalysis,
    applyAiReviewResultToState,
    hydrateAiReviewStateFromRecord,
    buildAiReviewSourceSummaryConfig,
    buildAiReviewPersistencePayload,
    filterDmlIssues
} from "../scripts/reports/aiReviewReport.js";
import { exportJsonReport, normaliseJsonContent } from "../scripts/reports/exportJson.js";
import {
    isPlainObject,
    normaliseReportObject,
    normaliseAiReviewPayload,
    parseReportJson
} from "../scripts/reports/shared.js";
import { buildProjectPreviewIndex } from "../scripts/projectPreview/index.js";
import PanelRail from "../components/workspace/PanelRail.vue";
import ChatAiWindow from "../components/ChatAiWindow.vue";
import ProjectPreviewPanel from "../components/projectpreview/ProjectPreviewPanel.vue";
import SettingsPanel from "../components/setting/SettingsPanel.vue";

const workspaceLogoModules = import.meta.glob("../assets/InfoMacro_logo.jpg", {
    eager: true,
    import: "default"
});
const workspaceLogoSrc = Object.values(workspaceLogoModules)[0] ?? "";

const preview = usePreview();

const projectsStore = useProjectsStore({
    preview,
    fileSystem: fileSystemService
});

const treeStore = useTreeStore({
    getProjectRootHandleById: projectsStore.getProjectRootHandleById,
    getFileHandleByPath: fileSystemService.getFileHandleByPath,
    previewing: preview.previewing,
    isTextLike: preview.isTextLike,
    MAX_TEXT_BYTES: preview.MAX_TEXT_BYTES,
    selectedProjectId: projectsStore.selectedProjectId,
    fetchStoredFileContent: projectsStore.fetchStoredFileContent
});

projectsStore.setTreeStore(treeStore);

const aiAssistant = useAiAssistant({ treeStore, projectsStore, fileSystem: fileSystemService, preview });

const {
    showUploadModal,
    projects,
    selectedProjectId,
    supportsFS,
    loadProjectsFromDB,
    cleanupLegacyHandles,
    openProject,
    deleteProject,
    handleDrop,
    handleDragOver,
    handleFolderInput,
    pickFolderAndImport,
    updateCapabilityFlags,
    getProjectRootHandleById,
    fetchStoredFileContent,
    safeAlertFail
} = projectsStore;

const {
    tree,
    activeTreePath,
    activeTreeRevision,
    isLoadingTree,
    openNode,
    selectTreeNode,
    projectTreeUpdateEvent
} = treeStore;

const {
    open: openAssistantSession,
    close: closeAssistantSession,
    contextItems,
    messages,
    addActiveNode,
    addSnippetContext,
    removeContext,
    clearContext,
    sendUserMessage,
    isProcessing,
    isInteractionLocked: isChatLocked,
    connection,
    retryHandshake
} = aiAssistant;

const { previewing } = preview;

const previewLineItems = computed(() => {
    if (previewing.value.kind !== "text") return [];
    const text = previewing.value.text ?? "";
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length === 0) {
        return [{ number: 1, content: "\u00A0" }];
    }
    return lines.map((line, index) => ({
        number: index + 1,
        content: line === "" ? "\u00A0" : line,
        raw: line
    }));
});

const middlePaneWidth = ref(360);
const mainContentRef = ref(null);
const codeScrollRef = ref(null);
const reportViewerContentRef = ref(null);
const reportIssuesContentRef = ref(null);
const pendingReportIssueJump = ref(null);
let pendingReportIssueJumpTimer = null;
const REPORT_ISSUE_JUMP_MAX_ATTEMPTS = 40;
const REPORT_ISSUE_JUMP_INTERVAL = 180;
const codeSelection = ref(null);
let pointerDownInCode = false;
let shouldClearAfterPointerClick = false;
let lastPointerDownWasOutsideCode = false;
const showCodeLineNumbers = ref(true);
const isChatWindowOpen = ref(false);
const activeRailTool = ref("projects");
const chatWindowState = reactive({ x: 0, y: 80, width: 420, height: 520 });
const chatDragState = reactive({ active: false, offsetX: 0, offsetY: 0 });
const chatResizeState = reactive({
    active: false,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startLeft: 0,
    startTop: 0,
    edges: {
        left: false,
        right: false,
        top: false,
        bottom: false
    }
});
const hasInitializedChatWindow = ref(false);
const isTreeCollapsed = ref(false);
const isReportTreeCollapsed = ref(true);
const reportStates = reactive({});
const reportTreeCache = reactive({});
const reportBatchStates = reactive({});
const activeReportTarget = ref(null);
const pendingReportIssueFocus = ref(null);
const reportExportState = reactive({
    combined: false,
    static: false,
    ai: false
});
const isDmlReportExpanded = ref(false);

const handleToggleDmlSection = (event) => {
    if (event && typeof event.target?.open === "boolean") {
        isDmlReportExpanded.value = event.target.open;
    }
};
const isProjectToolActive = computed(() => activeRailTool.value === "projects");
const isReportToolActive = computed(() => activeRailTool.value === "reports");
const isPreviewToolActive = computed(() => activeRailTool.value === "preview");
const isSettingsToolActive = computed(() => activeRailTool.value === "settings");
const shouldPrepareReportTrees = computed(
    () => isProjectToolActive.value || isReportToolActive.value || isPreviewToolActive.value
);
const panelMode = computed(() => {
    if (isReportToolActive.value) return "reports";
    if (isPreviewToolActive.value) return "preview";
    return "projects";
});
const reportProjectEntries = computed(() => {
    const list = Array.isArray(projects.value) ? projects.value : [];
    return list.map((project) => {
        const projectKey = normaliseProjectId(project.id);
        return {
            project,
            cache: reportTreeCache[projectKey] || {
                nodes: [],
                loading: false,
                error: "",
                expandedPaths: [],
                hydratedReports: false,
                hydratingReports: false,
                reportHydrationError: ""
            }
        };
    });
});

const activePreviewTarget = computed(() => {
    const projectId = normaliseProjectId(selectedProjectId.value);
    const path = activeTreePath.value || "";
    if (!projectId || !path) return null;
    return { projectId, path };
});

const reportPanelConfig = computed(() => {
    const viewMode = isReportToolActive.value ? "reports" : "projects";
    const showProjectActions = isReportToolActive.value;
    const showIssueBadge = isReportToolActive.value;
    const showFileActions = isReportToolActive.value;
    const allowSelectWithoutReport = !isReportToolActive.value;
    const projectIssueGetter = showIssueBadge ? getProjectIssueCount : null;

    return {
        panelTitle: viewMode === "reports" ? "代碼審查" : "專案檔案",
        showProjectActions,
        showIssueBadge,
        showFileActions,
        allowSelectWithoutReport,
        entries: reportProjectEntries.value,
        normaliseProjectId,
        isNodeExpanded: isReportNodeExpanded,
        toggleNode: toggleReportNode,
        getReportState: getReportStateForFile,
        onGenerate: generateReportForFile,
        onSelect: viewMode === "reports" ? selectReport : openProjectFileFromReportTree,
        getStatusLabel,
        onReloadProject: loadReportTreeForProject,
        onGenerateProject: generateProjectReports,
        getProjectBatchState,
        getProjectIssueCount: projectIssueGetter,
        activeTarget: isReportToolActive.value
            ? activeReportTarget.value
            : activePreviewTarget.value
    };
});
const readyReports = computed(() => {
    const list = [];
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const projectMap = new Map(projectList.map((project) => [String(project.id), project]));

    Object.entries(reportStates).forEach(([key, state]) => {
        if (state.status !== "ready") return;
        const parsed = parseReportKey(key);
        const project = projectMap.get(parsed.projectId);
        if (!project || !parsed.path) return;
        list.push({
            key,
            project,
            path: parsed.path,
            state
        });
    });

    list.sort((a, b) => {
        if (a.project.name === b.project.name) return a.path.localeCompare(b.path);
        return a.project.name.localeCompare(b.project.name);
    });

    return list;
});

const projectIssueTotals = computed(() =>
    collectIssueSummaryTotals(reportStates, { parseKey: parseReportKey })
);
const projectPreviewEntries = computed(() =>
    buildProjectPreviewIndex({
        projects: projects.value,
        reportStates,
        parseKey: parseReportKey
    })
);
const isProjectPreviewLoading = computed(() => {
    const caches = Object.values(reportTreeCache);
    if (!caches.length) return false;
    return caches.some((entry) => entry.loading || entry.hydratingReports);
});
const hasReadyReports = computed(() => readyReports.value.length > 0);
const activeReport = computed(() => {
    const target = activeReportTarget.value;
    if (!target) return null;
    const key = toReportKey(target.projectId, target.path);
    if (!key) return null;
    const state = reportStates[key];
    if (
        !state ||
        (state.status !== "ready" && state.status !== "error" && state.status !== "processing")
    ) {
        return null;
    }
    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find((item) => String(item.id) === target.projectId);
    if (!project) return null;
    return {
        project,
        state,
        path: target.path
    };
});

const isActiveReportProcessing = computed(
    () => activeReport.value?.state?.status === "processing"
);

const viewerHasContent = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    return (
        report.state.status === "ready" ||
        report.state.status === "error" ||
        report.state.status === "processing"
    );
});

const activeReportIssueSources = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return {
            state: null,
            staticIssues: [],
            aiIssues: [],
            aggregatedIssues: []
        };
    }

    const state = report.state;
    return {
        state,
        staticIssues: collectStaticReportIssues(state),
        aiIssues: collectAiReviewIssues(state),
        aggregatedIssues: collectAggregatedIssues(state)
    };
});

const activeReportDetails = computed(() => {
    const report = activeReport.value;
    if (!report || report.state.status !== "ready") return null;
    const parsed = report.state.parsedReport;
    if (!parsed || typeof parsed !== "object") return null;

    const reports = parsed.reports && typeof parsed.reports === "object" ? parsed.reports : null;
    const dmlReport = reports?.dml_prompt || reports?.dmlPrompt || null;

    const aggregatedPayload = isPlainObject(parsed) ? parsed : null;
    const parseAggregatedReportsCandidate = (candidate) => {
        if (!candidate) {
            return null;
        }
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (!trimmed) {
                return null;
            }
            try {
                const parsedCandidate = JSON.parse(trimmed);
                return parsedCandidate && typeof parsedCandidate === "object" ? parsedCandidate : null;
            } catch (error) {
                console.warn("[Report] Failed to parse aggregated report payload", error);
                return null;
            }
        }
        if (typeof candidate === "object") {
            return candidate;
        }
        return null;
    };

    const aggregatedReportsSources = [];
    const combinedReportJson = normaliseJsonContent(report.state?.combinedReportJson);
    if (combinedReportJson) {
        aggregatedReportsSources.push(combinedReportJson);
    }
    if (report.state?.analysis?.aggregatedReports) {
        aggregatedReportsSources.push(report.state.analysis.aggregatedReports);
    }
    if (aggregatedPayload?.aggregated_reports) {
        aggregatedReportsSources.push(aggregatedPayload.aggregated_reports);
    }
    if (aggregatedPayload?.aggregatedReports) {
        aggregatedReportsSources.push(aggregatedPayload.aggregatedReports);
    }

    let aggregatedReports = null;
    for (const candidate of aggregatedReportsSources) {
        const resolved = parseAggregatedReportsCandidate(candidate);
        if (resolved) {
            aggregatedReports = resolved;
            break;
        }
    }

    const { staticIssues, aiIssues, aggregatedIssues: derivedAggregatedIssues } =
        activeReportIssueSources.value;
    let aggregatedIssues = Array.isArray(aggregatedReports?.issues)
        ? aggregatedReports.issues
        : Array.isArray(aggregatedPayload?.issues)
        ? aggregatedPayload.issues
        : derivedAggregatedIssues;
    if (!Array.isArray(aggregatedIssues)) {
        aggregatedIssues = [];
    }

    let summaryRecords = Array.isArray(aggregatedReports?.summary)
        ? aggregatedReports.summary
        : null;
    if (!Array.isArray(summaryRecords) || !summaryRecords.length) {
        summaryRecords = Array.isArray(aggregatedPayload?.summary) ? aggregatedPayload.summary : null;
    }
    if (!Array.isArray(summaryRecords) || !summaryRecords.length) {
        summaryRecords = buildAggregatedSummaryRecords(
            report.state,
            staticIssues,
            aiIssues,
            aggregatedIssues
        );
    }

    const toSummaryKey = (value) => (typeof value === "string" ? value.toLowerCase() : "");
    const combinedSummaryRecord = Array.isArray(summaryRecords)
        ? summaryRecords.find((record) => toSummaryKey(record?.source) === toSummaryKey("combined"))
        : null;

    const globalSummary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null;

    const {
        staticReport,
        summary,
        summaryObject,
        summaryText,
        staticSummary,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues: normalisedIssues,
        severityBreakdown,
        ruleBreakdown,
        totalIssues: staticTotalIssues,
        sourceSummaryConfig: staticSourceSummaryConfig
    } = buildStaticReportDetails({
        state: report.state,
        parsedReport: parsed,
        aggregatedIssues,
        summaryRecords,
        combinedSummaryRecord,
        globalSummary
    });

    const total = staticTotalIssues;
    const combinedSummarySource =
        (combinedSummaryRecord && typeof combinedSummaryRecord === "object"
            ? combinedSummaryRecord
            : null) || globalSummary;

    const normaliseKey = (value) => (typeof value === "string" ? value.toLowerCase() : "");
    const pickString = (...candidates) => {
        for (const candidate of candidates) {
            if (typeof candidate === "string") {
                const trimmed = candidate.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
        }
        return "";
    };
    const pickFirstValue = (...candidates) => {
        for (const candidate of candidates) {
            if (candidate !== null && candidate !== undefined && candidate !== "") {
                return candidate;
            }
        }
        return null;
    };

    const combinedSummaryDetails = buildSummaryDetailList(combinedSummarySource, {
        omitKeys: ["sources", "by_rule", "byRule", "source", "label"]
    });

    const combinedSummaryTextValue = pickString(
        combinedSummarySource?.message,
        typeof combinedSummarySource?.summary === "string" ? combinedSummarySource.summary : "",
        combinedSummarySource?.note,
        typeof combinedSummarySource === "string" ? combinedSummarySource : ""
    );

    const combinedSummaryByRule =
        (combinedSummarySource?.by_rule && typeof combinedSummarySource.by_rule === "object"
            ? combinedSummarySource.by_rule
            : null) ||
        (combinedSummarySource?.byRule && typeof combinedSummarySource.byRule === "object"
            ? combinedSummarySource.byRule
            : null);

    const combinedDistributions = buildIssueDistributions(aggregatedIssues, {
        summaryByRule: combinedSummaryByRule
    });

    let combinedTotalIssueCount = null;
    if (combinedSummarySource && typeof combinedSummarySource === "object") {
        const combinedTotalCandidate = Number(
            combinedSummarySource.total_issues ?? combinedSummarySource.totalIssues
        );
        if (Number.isFinite(combinedTotalCandidate)) {
            combinedTotalIssueCount = combinedTotalCandidate;
        }
    }
    if (!Number.isFinite(combinedTotalIssueCount)) {
        combinedTotalIssueCount = aggregatedIssues.length;
    }

    const buildSourceMetrics = (...sources) => {
        const metrics = [];
        const seen = new Set();
        const pushMetric = (label, rawValue, transform = (value) => value) => {
            if (!label || rawValue === undefined || rawValue === null) return;
            const value = transform(rawValue);
            if (value === null || value === undefined || value === "") return;
            if (seen.has(label)) return;
            seen.add(label);
            metrics.push({ label, value });
        };

        for (const source of sources) {
            if (!source || typeof source !== "object") continue;
            pushMetric(
                "問題數",
                source.total_issues ?? source.totalIssues,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
            if (source.by_rule || source.byRule) {
                const byRuleEntries = Object.entries(source.by_rule || source.byRule || {});
                pushMetric("規則數", byRuleEntries.length, (count) => Number(count) || 0);
            }
            pushMetric(
                "拆分語句",
                source.total_segments ?? source.totalSegments,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
            pushMetric(
                "已分析段數",
                source.analyzed_segments ?? source.analyzedSegments,
                (candidate) => {
                    const numeric = Number(candidate);
                    return Number.isFinite(numeric) ? numeric : Number(candidate ?? 0) || 0;
                }
            );
        }

        return metrics;
    };
    const mergeMetrics = (base, extra) => {
        if (!Array.isArray(base) || !base.length) return Array.isArray(extra) ? [...extra] : [];
        if (!Array.isArray(extra) || !extra.length) return [...base];
        const merged = [...base];
        const seen = new Set(base.map((item) => item.label));
        extra.forEach((item) => {
            if (!item || typeof item !== "object") return;
            if (seen.has(item.label)) return;
            seen.add(item.label);
            merged.push(item);
        });
        return merged;
    };

    const sourceSummaries = [];
    if (globalSummary?.sources && typeof globalSummary.sources === "object") {
        for (const [key, value] of Object.entries(globalSummary.sources)) {
            if (!value || typeof value !== "object") continue;
            const keyLower = normaliseKey(key);
            let label = key;
            if (keyLower === "static_analyzer" || keyLower === "staticanalyzer") {
                label = "靜態分析器";
            } else if (keyLower === "dml_prompt" || keyLower === "dmlprompt") {
                label = "AI審查";
            } else if (keyLower === "dify_workflow" || keyLower === "difyworkflow") {
                label = "聚合報告";
            }

            const metrics = buildSourceMetrics(value);
            const status = pickString(value.status);
            const errorMessage = pickString(value.error_message, value.errorMessage);
            const generatedAt = pickFirstValue(value.generated_at, value.generatedAt);

            sourceSummaries.push({
                key,
                keyLower,
                label,
                metrics,
                status,
                errorMessage,
                generatedAt
            });
        }
    }

    const enhanceSourceSummary = (keyLower, label, options = {}) => {
        const entry = sourceSummaries.find((item) => item.keyLower === keyLower);
        const metrics = buildSourceMetrics(...(options.metricsSources || []));
        const status = pickString(...(options.statusCandidates || []));
        const errorMessage = pickString(...(options.errorCandidates || []));
        const generatedAt = pickFirstValue(...(options.generatedAtCandidates || []));

        if (entry) {
            entry.label = label;
            if (metrics.length) {
                entry.metrics = mergeMetrics(entry.metrics, metrics);
            }
            if (!entry.status) {
                entry.status = status;
            }
            if (!entry.errorMessage) {
                entry.errorMessage = errorMessage;
            }
            if (!entry.generatedAt) {
                entry.generatedAt = generatedAt;
            }
        } else if (metrics.length || status || errorMessage || generatedAt) {
            sourceSummaries.push({
                key: options.key || keyLower,
                keyLower,
                label,
                metrics,
                status,
                errorMessage,
                generatedAt
            });
        }
    };

    const applySummaryRecords = (records) => {
        if (!Array.isArray(records)) return;
        records.forEach((record) => {
            if (!record || typeof record !== "object") return;
            const keyLower = normaliseKey(record.source);
            if (!keyLower) return;
            const label =
                typeof record.label === "string" && record.label.trim()
                    ? record.label.trim()
                    : record.source || keyLower;
            const existingIndex = sourceSummaries.findIndex((item) => item.keyLower === keyLower);
            if (existingIndex !== -1) {
                sourceSummaries.splice(existingIndex, 1);
            }
            enhanceSourceSummary(keyLower, label, {
                key: record.source || keyLower,
                metricsSources: [record],
                statusCandidates: [record.status],
                errorCandidates: [record.error_message, record.errorMessage, record.message],
                generatedAtCandidates: [record.generated_at, record.generatedAt]
            });
        });
    };

    applySummaryRecords(summaryRecords);

    if (staticSourceSummaryConfig) {
        enhanceSourceSummary("static_analyzer", "靜態分析器", staticSourceSummaryConfig);
    }

    const dmlSourceValue = globalSummary?.sources?.dml_prompt || globalSummary?.sources?.dmlPrompt || null;
    const aiSourceSummary = buildAiReviewSourceSummaryConfig({
        report: dmlReport,
        globalSource: dmlSourceValue,
        analysis: report.state?.analysis
    });
    const dmlSummary = aiSourceSummary.summary;
    const dmlDetails = aiSourceSummary.details;

    enhanceSourceSummary("dml_prompt", "AI審查", {
        metricsSources: aiSourceSummary.metricsSources,
        statusCandidates: aiSourceSummary.statusCandidates,
        errorCandidates: aiSourceSummary.errorCandidates,
        generatedAtCandidates: aiSourceSummary.generatedAtCandidates
    });

    const combinedSummarySourceValue =
        globalSummary?.sources?.dify_workflow || globalSummary?.sources?.difyWorkflow || null;
    enhanceSourceSummary("dify_workflow", "聚合報告", {
        metricsSources: [combinedSummarySourceValue, globalSummary],
        statusCandidates: [
            combinedSummarySourceValue?.status,
            globalSummary?.status,
            report.state?.analysis?.dify?.status
        ],
        errorCandidates: [
            combinedSummarySourceValue?.error_message,
            combinedSummarySourceValue?.errorMessage,
            globalSummary?.error_message,
            globalSummary?.errorMessage,
            report.state?.analysis?.difyErrorMessage,
            report.state?.difyErrorMessage
        ],
        generatedAtCandidates: [
            combinedSummarySourceValue?.generated_at,
            combinedSummarySourceValue?.generatedAt,
            globalSummary?.generated_at,
            globalSummary?.generatedAt
        ]
    });

    return {
        totalIssues: Number.isFinite(total) ? Number(total) : null,
        summary,
        summaryObject,
        summaryText,
        staticSummary,
        staticSummaryDetails,
        staticMetadata,
        staticMetadataDetails,
        issues: normalisedIssues,
        severityBreakdown,
        ruleBreakdown,
        raw: parsed,
        sourceSummaries,
        combinedSummary: combinedSummarySource,
        combinedSummaryDetails,
        combinedSummaryText: combinedSummaryTextValue,
        combinedSeverityBreakdown: combinedDistributions.severityBreakdown,
        combinedRuleBreakdown: combinedDistributions.ruleBreakdown,
        combinedTotalIssues: Number.isFinite(combinedTotalIssueCount)
            ? Number(combinedTotalIssueCount)
            : null,
        aggregatedIssues,
        staticReport,
        dmlReport: dmlDetails,
        aggregatedReports: aggregatedReports && typeof aggregatedReports === "object" ? aggregatedReports : null,
        aggregatedSummaryRecords: Array.isArray(aggregatedReports?.summary) ? aggregatedReports.summary : null,
        combinedSummaryByRule
    };
});


const hasStructuredReport = computed(() => Boolean(activeReportDetails.value));
const ruleBreakdownItems = computed(() => {
    const details = activeReportDetails.value;
    const combined = details?.combinedRuleBreakdown;
    if (Array.isArray(combined) && combined.length) {
        return combined;
    }
    const aggregatedByRule = details?.combinedSummaryByRule;
    if (aggregatedByRule && typeof aggregatedByRule === "object") {
        const fallbackItems = Object.entries(aggregatedByRule)
            .map(([rawLabel, rawCount]) => {
                const count = Number(rawCount);
                if (!Number.isFinite(count) || count <= 0) {
                    return null;
                }
                const labelValue =
                    typeof rawLabel === "string"
                        ? rawLabel.trim()
                        : String(rawLabel ?? "").trim();
                const label = labelValue || "未分類";
                return { label, count };
            })
            .filter((entry) => entry !== null);
        if (fallbackItems.length) {
            fallbackItems.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
            return fallbackItems;
        }
    }
    const items = details?.ruleBreakdown;
    return Array.isArray(items) ? items : [];
});
const severityBreakdownItems = computed(() => {
    const details = activeReportDetails.value;
    const combined = details?.combinedSeverityBreakdown;
    if (Array.isArray(combined) && combined.length) {
        return combined;
    }
    const items = details?.severityBreakdown;
    return Array.isArray(items) ? items : [];
});
const activeReportSummaryText = computed(() => {
    const text =
        activeReportDetails.value?.combinedSummaryText || activeReportDetails.value?.summaryText;
    return typeof text === "string" ? text : "";
});
const shouldShowNoIssueSummary = computed(() => {
    const details = activeReportDetails.value;
    if (!details || activeReportSummaryText.value) {
        return false;
    }
    if (Number.isFinite(details?.combinedTotalIssues)) {
        return Number(details.combinedTotalIssues) === 0;
    }
    return details?.totalIssues === 0;
});
const activeReportTotalIssuesDisplay = computed(() => {
    const details = activeReportDetails.value;
    if (!details) {
        return "—";
    }
    const combinedValue = details.combinedTotalIssues;
    if (Number.isFinite(combinedValue)) {
        return String(Number(combinedValue));
    }
    const value = details.totalIssues;
    if (value === null || value === undefined) {
        return "—";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return String(value);
});
const staticSummaryDetailsItems = computed(() => {
    const items = activeReportDetails.value?.staticSummaryDetails;
    return Array.isArray(items) ? items : [];
});
const staticMetadataDetailsItems = computed(() => {
    const items = activeReportDetails.value?.staticMetadataDetails;
    return Array.isArray(items) ? items : [];
});
const hasStaticDetailContent = computed(
    () => staticSummaryDetailsItems.value.length > 0 || staticMetadataDetailsItems.value.length > 0
);
const staticEngineName = computed(() => {
    const engine = activeReportDetails.value?.staticMetadata?.engine;
    return typeof engine === "string" ? engine : "";
});
const staticSourceName = computed(() => {
    const source = activeReportDetails.value?.staticSummary?.analysis_source;
    return typeof source === "string" ? source : "";
});
const trimLeadingWhitespace = (value) => {
    if (typeof value !== "string") return value;
    return value.replace(/^\s+/, "");
};
const dmlReportDetails = computed(() => {
    const report = activeReportDetails.value?.dmlReport;
    if (!report || typeof report !== "object") return null;

    const normalised = { ...report };

    if (typeof normalised.reportText === "string") {
        normalised.reportText = trimLeadingWhitespace(normalised.reportText);
    }

    if (Array.isArray(normalised.segments)) {
        normalised.segments = normalised.segments.map((segment) => {
            if (!isPlainObject(segment)) return segment;
            const next = { ...segment };
            if (typeof next.text === "string") {
                next.text = trimLeadingWhitespace(next.text);
            }
            if (typeof next.sql === "string") {
                next.sql = trimLeadingWhitespace(next.sql);
            }
            if (typeof next.analysis === "string") {
                next.analysis = trimLeadingWhitespace(next.analysis);
            }
            return next;
        });
    }

    if (Array.isArray(normalised.chunks)) {
        normalised.chunks = normalised.chunks.map((chunk) => {
            if (!isPlainObject(chunk)) return chunk;
            const nextChunk = { ...chunk };
            if (typeof nextChunk.report === "string") {
                nextChunk.report = trimLeadingWhitespace(nextChunk.report);
            }
            if (typeof nextChunk.summary === "string") {
                nextChunk.summary = trimLeadingWhitespace(nextChunk.summary);
            }
            return nextChunk;
        });
    }

    return normalised;
});
const dmlSegments = computed(() => {
    const segments = dmlReportDetails.value?.segments;
    return Array.isArray(segments) ? segments : [];
});
const hasDmlSegments = computed(() => dmlSegments.value.length > 0);
const dmlChunkDetails = computed(() => {
    const report = dmlReportDetails.value;
    if (!report) return [];
    const chunks = Array.isArray(report.chunks) ? report.chunks : [];
    if (!chunks.length) return [];

    const totalCandidates = chunks.map((chunk, offset) => {
        const totalCandidate = Number(chunk?.total);
        if (Number.isFinite(totalCandidate) && totalCandidate > 0) {
            return Math.floor(totalCandidate);
        }
        const indexCandidate = Number(chunk?.index);
        if (Number.isFinite(indexCandidate) && indexCandidate > 0) {
            return Math.floor(indexCandidate);
        }
        return offset + 1;
    });
    const fallbackTotal = Math.max(chunks.length, ...totalCandidates);

    const normaliseIssue = (issue) => {
        if (isPlainObject(issue)) {
            const message =
                pickFirstNonEmptyString(
                    issue.message,
                    Array.isArray(issue.messages) ? issue.messages : [],
                    issue.description,
                    issue.detail,
                    issue.summary,
                    issue.statement,
                    issue.snippet,
                    issue.text,
                    issue.report,
                    issue.reason,
                    issue.evidence
                ) || "未提供訊息";
            const severity = pickFirstNonEmptyString(
                Array.isArray(issue.severity_levels) ? issue.severity_levels : [],
                issue.severity,
                issue.level
            );
            const rule = pickFirstNonEmptyString(
                Array.isArray(issue.rule_ids) ? issue.rule_ids : [],
                Array.isArray(issue.ruleIds) ? issue.ruleIds : [],
                issue.rule_id,
                issue.ruleId,
                issue.rule
            );
            const context = pickFirstNonEmptyString(
                issue.snippet,
                issue.statement,
                issue.sql,
                issue.segment,
                issue.text,
                issue.raw
            );
            const lineMeta = ensureIssueLineMeta(issue);
            const line = lineMeta.label || null;

            return {
                message,
                severity,
                rule,
                line,
                lineStart: lineMeta.start,
                lineEnd: lineMeta.end,
                context,
                original: issue
            };
        }
        if (typeof issue === "string") {
            const trimmed = issue.trim();
            return {
                message: trimmed || "未提供訊息",
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        }
        try {
            return {
                message: JSON.stringify(issue),
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        } catch (_error) {
            return {
                message: "未提供訊息",
                severity: "",
                rule: "",
                line: null,
                context: "",
                original: issue
            };
        }
    };

    return chunks.map((chunk, offset) => {
        const indexCandidate = Number(chunk?.index);
        const index = Number.isFinite(indexCandidate) && indexCandidate > 0 ? Math.floor(indexCandidate) : offset + 1;
        const totalCandidate = Number(chunk?.total);
        const total = Number.isFinite(totalCandidate) && totalCandidate > 0
            ? Math.floor(totalCandidate)
            : Math.max(fallbackTotal, index);
        const issues = Array.isArray(chunk?.issues) ? chunk.issues : [];
        return {
            index,
            total,
            issues: issues.map(normaliseIssue)
        };
    });
});
function normaliseComparablePath(path) {
    if (!path) return "";
    return String(path)
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\/+/, "")
        .trim();
}

const activeReportSourceText = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const reportPath = normaliseComparablePath(report.path);
    const previewPath = normaliseComparablePath(previewing.value?.path);
    const previewText = previewing.value?.text;
    const previewMatchesReport = Boolean(reportPath && previewPath && previewPath === reportPath);

    if (previewMatchesReport && typeof previewText === "string" && previewText.length) {
        return previewText;
    }

    const text = report.state?.sourceText;
    if (typeof text === "string" && text.length) {
        return text;
    }

    if (previewMatchesReport && typeof previewText === "string") {
        return previewText;
    }

    return "";
});

const activeReportSourceLines = computed(() => {
    const text = activeReportSourceText.value;
    if (!text) {
        return [];
    }
    const normalised = text.replace(/\r\n?/g, "\n").split("\n");
    if (!normalised.length) {
        return [];
    }
    return normalised.map((raw, index) => ({
        number: index + 1,
        raw,
        html: escapeHtml(raw) || "&nbsp;"
    }));
});

const MAX_ISSUE_LINE_SPAN = 500;

const ISSUE_LINE_VALUE_KEYS = [
    "line",
    "line_text",
    "lineText",
    "line_number",
    "lineNumber",
    "line_no",
    "lineNo",
    "line_range",
    "lineRange",
    "line_label",
    "lineLabel",
    "range",
    "lineDisplay",
    "line_range_text",
    "lineRangeText"
];

function serialiseLineSignatureValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch (_error) {
        return "[unserialisable]";
    }
}

function buildIssueLineSignature(issue) {
    const parts = [];

    const collectFromSource = (source) => {
        if (!source || typeof source !== "object") return;
        for (const key of ISSUE_LINE_VALUE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                parts.push(`${key}:${serialiseLineSignatureValue(source[key])}`);
            }
        }
        if (Object.prototype.hasOwnProperty.call(source, "start")) {
            parts.push(`start:${serialiseLineSignatureValue(source.start)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "end")) {
            parts.push(`end:${serialiseLineSignatureValue(source.end)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "begin")) {
            parts.push(`begin:${serialiseLineSignatureValue(source.begin)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "finish")) {
            parts.push(`finish:${serialiseLineSignatureValue(source.finish)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "from")) {
            parts.push(`from:${serialiseLineSignatureValue(source.from)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "to")) {
            parts.push(`to:${serialiseLineSignatureValue(source.to)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "start_line")) {
            parts.push(`start_line:${serialiseLineSignatureValue(source.start_line)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "end_line")) {
            parts.push(`end_line:${serialiseLineSignatureValue(source.end_line)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "startLine")) {
            parts.push(`startLine:${serialiseLineSignatureValue(source.startLine)}`);
        }
        if (Object.prototype.hasOwnProperty.call(source, "endLine")) {
            parts.push(`endLine:${serialiseLineSignatureValue(source.endLine)}`);
        }
        if (source.metadata && typeof source.metadata === "object") {
            collectFromSource(source.metadata);
        }
        if (source.meta && typeof source.meta === "object") {
            collectFromSource(source.meta);
        }
    };

    collectFromSource(issue);

    if (Array.isArray(issue?.details)) {
        issue.details.forEach((detail) => collectFromSource(detail));
    }

    return parts.join("|");
}

function normaliseLineEndpoint(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return null;
    }
    return Math.floor(numeric);
}

function parseLineRangeValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number") {
        const endpoint = normaliseLineEndpoint(value);
        return endpoint ? { start: endpoint, end: endpoint } : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const rangeMatch = trimmed.match(/^(\d+)\s*[-~–]\s*(\d+)$/);
        if (rangeMatch) {
            const start = normaliseLineEndpoint(rangeMatch[1]);
            const end = normaliseLineEndpoint(rangeMatch[2]);
            if (start && end) {
                return { start: Math.min(start, end), end: Math.max(start, end) };
            }
        }
        const numeric = normaliseLineEndpoint(trimmed);
        return numeric ? { start: numeric, end: numeric } : null;
    }
    if (Array.isArray(value)) {
        const endpoints = value
            .map((entry) => normaliseLineEndpoint(entry))
            .filter((entry) => entry !== null);
        if (!endpoints.length) {
            return null;
        }
        return { start: Math.min(...endpoints), end: Math.max(...endpoints) };
    }
    if (value && typeof value === "object") {
        if (value.line !== undefined) {
            const parsed = parseLineRangeValue(value.line);
            if (parsed) {
                return parsed;
            }
        }
        const start = normaliseLineEndpoint(value.start ?? value.begin ?? value.from);
        const end = normaliseLineEndpoint(value.end ?? value.finish ?? value.to);
        if (start !== null || end !== null) {
            const safeStart = start ?? end;
            const safeEnd = end ?? start ?? safeStart;
            return safeStart ? { start: safeStart, end: safeEnd } : null;
        }
        if (typeof value.label === "string") {
            return parseLineRangeValue(value.label);
        }
    }
    return null;
}

function extractLineRangeFromIssue(issue) {
    if (!issue || typeof issue !== "object") {
        return null;
    }

    const extractRangeFromMeta = (meta) => {
        if (meta && typeof meta === "object") {
            const parsed = parseLineRangeValue(meta.line ?? meta.lineRange ?? meta.range);
            if (parsed) {
                return parsed;
            }
            const start = normaliseLineEndpoint(meta.start_line ?? meta.startLine);
            const end = normaliseLineEndpoint(meta.end_line ?? meta.endLine);
            if (start !== null || end !== null) {
                const safeStart = start ?? end;
                const safeEnd = end ?? start ?? safeStart;
                if (safeStart) {
                    return { start: safeStart, end: safeEnd };
                }
            }
        }
        return null;
    };

    const tryParseFromObject = (source) => {
        if (!source || typeof source !== "object") return null;
        for (const key of ISSUE_LINE_VALUE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                const parsed = parseLineRangeValue(source[key]);
                if (parsed) {
                    return parsed;
                }
            }
        }
        const metaCandidates = [source.metadata, source.meta];
        for (const meta of metaCandidates) {
            const parsed = extractRangeFromMeta(meta);
            if (parsed) {
                return parsed;
            }
        }
        const start = normaliseLineEndpoint(source.start_line ?? source.startLine);
        const end = normaliseLineEndpoint(source.end_line ?? source.endLine);
        if (start !== null || end !== null) {
            const safeStart = start ?? end;
            const safeEnd = end ?? start ?? safeStart;
            if (safeStart) {
                return { start: safeStart, end: safeEnd };
            }
        }
        return null;
    };

    const parsedFromIssue = tryParseFromObject(issue);
    if (parsedFromIssue) {
        return parsedFromIssue;
    }

    if (Array.isArray(issue.details)) {
        for (const detail of issue.details) {
            const parsed = tryParseFromObject(detail);
            if (parsed) {
                return parsed;
            }
        }
    }
    return null;
}

function formatLineRangeLabel(range) {
    if (!range) {
        return "";
    }
    if (range.start === range.end) {
        return String(range.start);
    }
    return `${range.start}-${range.end}`;
}

function normaliseIssueLineMeta(meta) {
    if (!meta || typeof meta !== "object") {
        return { start: null, end: null, label: "" };
    }

    const parsedFromRange =
        parseLineRangeValue(meta.line ?? meta.lineRange ?? meta.range ?? meta.label) || null;

    let start =
        normaliseLineEndpoint(meta.start ?? meta.begin ?? meta.from) ?? parsedFromRange?.start ?? null;
    let end = normaliseLineEndpoint(meta.end ?? meta.finish ?? meta.to) ?? parsedFromRange?.end ?? null;

    if (Number.isFinite(start) && Number.isFinite(end) && start > end) {
        [start, end] = [end, start];
    }

    const hasStart = start !== null;
    const hasEnd = end !== null;
    const safeStart = hasStart ? start : hasEnd ? end : null;
    const safeEnd = hasEnd ? end : hasStart ? start : null;
    const label =
        (typeof meta.label === "string" && meta.label.trim()) ||
        formatLineRangeLabel(safeStart ? { start: safeStart, end: safeEnd ?? safeStart } : null);

    const signature = typeof meta.signature === "string" ? meta.signature : undefined;

    return {
        start: safeStart,
        end: safeEnd,
        label: typeof label === "string" ? label : "",
        signature
    };
}

function ensureIssueLineMeta(issue) {
    if (!issue || typeof issue !== "object") {
        return { start: null, end: null, label: "" };
    }

    const signature = buildIssueLineSignature(issue);

    if (issue.__lineMeta && typeof issue.__lineMeta === "object") {
        const cached = normaliseIssueLineMeta(issue.__lineMeta);
        const hasLabel = typeof cached.label === "string" && cached.label.trim();
        const hasRange =
            Number.isFinite(cached.start) &&
            cached.start > 0 &&
            Number.isFinite(cached.end) &&
            cached.end > 0;
        if ((hasLabel || hasRange) && cached.signature === signature) {
            issue.__lineMeta = cached;
            return cached;
        }
    }

    const range = extractLineRangeFromIssue(issue);
    const meta = normaliseIssueLineMeta({
        start: range?.start ?? null,
        end: range?.end ?? null,
        label: formatLineRangeLabel(range)
    });

    meta.signature = signature;

    issue.__lineMeta = meta;
    return meta;
}

function describeIssueLineRange(issue) {
    const meta = ensureIssueLineMeta(issue);
    return meta.label;
}

const reportIssueLines = computed(() => {
    const details = activeReportDetails.value;
    const sourceLines = activeReportSourceLines.value;
    const normalised = Array.isArray(details?.issues) ? details.issues : [];
    const aggregated = Array.isArray(details?.aggregatedIssues) ? details.aggregatedIssues : [];
    // Prefer aggregated issues when present so we retain full line ranges (e.g. "2-5")
    // instead of any normalised summaries that may have lost span information.
    const issues = aggregated.length ? aggregated : normalised.length ? normalised : [];

    const sourceLineCount = sourceLines.length;
    let maxLine = sourceLineCount;
    const issuesByLine = new Map();
    const issuesEndingByLine = new Map();
    const orphanIssues = [];

    for (const issue of issues) {
        const lineMeta = ensureIssueLineMeta(issue);
        const hasStart = Number.isFinite(lineMeta.start) && lineMeta.start > 0;
        if (!hasStart) {
            orphanIssues.push(issue);
            continue;
        }
        const startLine = Math.max(1, Math.floor(lineMeta.start));
        if (!sourceLineCount || startLine > sourceLineCount) {
            orphanIssues.push(issue);
            continue;
        }
        const hasEnd = Number.isFinite(lineMeta.end) && lineMeta.end > 0;
        const endCandidate = hasEnd ? Math.floor(lineMeta.end) : startLine;
        const effectiveEnd = Math.max(startLine, endCandidate);
        const cappedEnd = Math.min(
            effectiveEnd,
            startLine + MAX_ISSUE_LINE_SPAN - 1,
            sourceLineCount
        );
        for (let lineNumber = startLine; lineNumber <= cappedEnd; lineNumber += 1) {
            const bucket = issuesByLine.get(lineNumber) || [];
            bucket.push(issue);
            issuesByLine.set(lineNumber, bucket);
        }
        const endBucket = issuesEndingByLine.get(cappedEnd) || [];
        endBucket.push(issue);
        issuesEndingByLine.set(cappedEnd, endBucket);
        if (effectiveEnd > sourceLineCount && !orphanIssues.includes(issue)) {
            orphanIssues.push(issue);
        }
        if (cappedEnd > maxLine) {
            maxLine = cappedEnd;
        }
    }

    const result = [];

    const ensureLineEntry = (lineNumber) => {
        const index = lineNumber - 1;
        if (index < sourceLines.length) {
            return sourceLines[index];
        }
        return { number: lineNumber, raw: "", html: "&nbsp;" };
    };

    for (let lineNumber = 1; lineNumber <= Math.max(1, maxLine); lineNumber += 1) {
        const baseLine = ensureLineEntry(lineNumber);
        const lineIssues = issuesByLine.get(lineNumber) || [];
        const endingIssues = issuesEndingByLine.get(lineNumber) || [];
        const hasIssue = lineIssues.length > 0;

        result.push({
            key: `code-${lineNumber}`,
            type: "code",
            number: lineNumber,
            displayNumber: String(lineNumber),
            html: baseLine.html,
            hasIssue,
            issues: lineIssues
        });

        if (endingIssues.length) {
            const lineRanges = endingIssues
                .map((issue) => ensureIssueLineMeta(issue)?.label || "")
                .filter(Boolean);
            console.log("[codeLineContent--issueHighlight]", {
                line: lineNumber,
                range: lineRanges.join(", ") || null,
                issueCount: endingIssues.length
            });
            result.push(buildIssueMetaLine("issues", lineNumber, endingIssues));
            result.push(buildIssueMetaLine("fix", lineNumber, endingIssues));
        }
    }

    if (orphanIssues.length) {
        result.push(buildIssueMetaLine("issues", "orphan", orphanIssues, true));
        result.push(buildIssueMetaLine("fix", "orphan", orphanIssues, true));
    }

    return result;
});

const hasReportIssueLines = computed(() => reportIssueLines.value.length > 0);

const structuredReportViewMode = ref("combined");
const shouldShowDmlChunkDetails = computed(() => {
    if (!dmlChunkDetails.value.length) {
        return false;
    }
    if (!hasStructuredReport.value) {
        return true;
    }
    return structuredReportViewMode.value === "dml";
});

const canShowStructuredSummary = computed(() => Boolean(activeReportDetails.value));

const canShowStructuredStatic = computed(() => {
    const reportState = activeReport.value?.state;
    if (reportState && normaliseJsonContent(reportState.staticReportJson)) {
        return true;
    }

    const details = activeReportDetails.value;
    if (!details) return false;

    if (details.staticReport && typeof details.staticReport === "object") {
        if (Object.keys(details.staticReport).length > 0) {
            return true;
        }
    }

    if (Array.isArray(details.staticSummaryDetails) && details.staticSummaryDetails.length) {
        return true;
    }

    if (Array.isArray(details.staticMetadataDetails) && details.staticMetadataDetails.length) {
        return true;
    }

    if (details.staticSummary) {
        if (typeof details.staticSummary === "string") {
            if (details.staticSummary.trim().length) return true;
        } else if (typeof details.staticSummary === "object") {
            if (Object.keys(details.staticSummary).length) return true;
        }
    }

    if (details.staticMetadata && typeof details.staticMetadata === "object") {
        if (Object.keys(details.staticMetadata).length) {
            return true;
        }
    }

    return false;
});

const canShowStructuredDml = computed(() => {
    const reportState = activeReport.value?.state;
    if (reportState && normaliseJsonContent(reportState.aiReportJson)) {
        return true;
    }

    const report = activeReportDetails.value?.dmlReport;
    if (!report) return false;

    if (Array.isArray(report.segments) && report.segments.length) {
        return true;
    }

    if (Array.isArray(report.issues) && report.issues.length) {
        return true;
    }

    if (typeof report.aggregatedText === "string" && report.aggregatedText.trim().length) {
        return true;
    }

    if (report.aggregated && typeof report.aggregated === "object") {
        if (Object.keys(report.aggregated).length) {
            return true;
        }
    }

    if (typeof report.reportText === "string" && report.reportText.trim().length) {
        return true;
    }

    if (typeof report.error === "string" && report.error.trim().length) {
        return true;
    }

    if (typeof report.status === "string" && report.status.trim().length) {
        return true;
    }

    if (report.generatedAt) {
        return true;
    }

    return false;
});

const canExportCombinedReport = computed(() => canShowStructuredSummary.value);
const canExportStaticReport = computed(() => canShowStructuredStatic.value);
const canExportAiReport = computed(() => canShowStructuredDml.value);

const STRUCTURED_EXPORT_CONFIG = {
    combined: {
        type: "combined",
        heading: "聚合報告 JSON",
        exportLabel: "匯出聚合報告 JSON"
    },
    static: {
        type: "static",
        heading: "靜態分析 JSON",
        exportLabel: "匯出靜態分析 JSON"
    },
    dml: {
        type: "ai",
        heading: "AI 審查 JSON",
        exportLabel: "匯出 AI 審查 JSON"
    }
};

function extractAiIssuesForJsonExport(state) {
    if (!state || typeof state !== "object") {
        return [];
    }
    const reports = state.parsedReport?.reports;
    const candidates = [
        state.analysis?.dmlIssues,
        state.analysis?.dmlReport?.issues,
        state.dml?.issues,
        state.dml?.aggregated?.issues,
        reports?.dml_prompt?.issues,
        reports?.dmlPrompt?.issues
    ];
    let selected = null;
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) {
            selected = candidate;
            break;
        }
        if (!selected && Array.isArray(candidate)) {
            selected = candidate;
        }
    }
    return filterDmlIssues(Array.isArray(selected) ? selected : []);
}

function buildJsonInfo(candidate) {
    const raw = normaliseJsonContent(candidate);
    if (!raw) {
        return { raw: "", preview: "" };
    }
    let preview = raw;
    try {
        preview = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
        preview = raw;
    }
    return { raw, preview };
}

const combinedReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }

    const combinedPayload = buildCombinedReportJsonExport(report.state);
    return buildJsonInfo(combinedPayload);
});

function filterStaticIssuesForJsonExport(issues) {
    if (!Array.isArray(issues)) {
        return [];
    }
    return issues.filter((issue) => issue !== null && issue !== undefined);
}

function extractStaticIssuesForJsonExport(state) {
    if (!state || typeof state !== "object") {
        return [];
    }
    const reports = state.parsedReport?.reports;
    const staticEntry = reports?.static_analyzer || reports?.staticAnalyzer || null;
    if (staticEntry && Array.isArray(staticEntry.issues)) {
        return filterStaticIssuesForJsonExport(staticEntry.issues);
    }
    const analysisIssues = state.analysis?.staticReport?.issues;
    if (Array.isArray(analysisIssues)) {
        return filterStaticIssuesForJsonExport(analysisIssues);
    }
    return filterStaticIssuesForJsonExport(collectStaticReportIssues(state));
}

const staticReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }
    const stored = normaliseJsonContent(report.state.staticReportJson);
    if (stored) {
        return buildJsonInfo(stored);
    }
    const issues = extractStaticIssuesForJsonExport(report.state);
    return buildJsonInfo({ issues });
});

const aiReportJsonInfo = computed(() => {
    const report = activeReport.value;
    if (!report || !report.state) {
        return { raw: "", preview: "" };
    }
    const stored = normaliseJsonContent(report.state.aiReportJson);
    if (stored) {
        return buildJsonInfo(stored);
    }
    const issues = extractAiIssuesForJsonExport(report.state);
    return buildJsonInfo({ issues });
});

const structuredReportExportConfig = computed(() => {
    const mode = structuredReportViewMode.value;
    const base = STRUCTURED_EXPORT_CONFIG[mode] || STRUCTURED_EXPORT_CONFIG.combined;
    let info = combinedReportJsonInfo.value;
    let canExport = canExportCombinedReport.value;
    let busy = reportExportState.combined;

    if (mode === "static") {
        info = staticReportJsonInfo.value;
        canExport = canExportStaticReport.value;
        busy = reportExportState.static;
    } else if (mode === "dml") {
        info = aiReportJsonInfo.value;
        canExport = canExportAiReport.value;
        busy = reportExportState.ai;
    }

    return {
        ...base,
        info,
        canExport: canExport && Boolean(info.raw),
        busy
    };
});

const structuredReportJsonHeading = computed(
    () => structuredReportExportConfig.value.heading || "報告 JSON"
);
const structuredReportExportLabel = computed(
    () => structuredReportExportConfig.value.exportLabel || "匯出 JSON"
);
const structuredReportJsonPreview = computed(() => {
    const preview = structuredReportExportConfig.value.info.preview;
    return typeof preview === "string" ? trimLeadingWhitespace(preview) : preview;
});
const shouldShowStructuredExportButton = computed(
    () => structuredReportExportConfig.value.canExport
);

const hasStructuredReportToggle = computed(
    () => canShowStructuredSummary.value || canShowStructuredStatic.value || canShowStructuredDml.value
);

const canShowCodeIssues = computed(() => {
    const report = activeReport.value;
    if (!report) return false;
    if (report.state?.sourceLoading || report.state?.sourceError) {
        return true;
    }
    return hasReportIssueLines.value;
});

const activeReportAiErrorMessage = computed(() => {
    const report = activeReport.value;
    if (!report) return "";

    const direct = typeof report.state?.difyErrorMessage === "string" ? report.state.difyErrorMessage : "";
    if (direct && direct.trim()) {
        return direct.trim();
    }

    const nested = typeof report.state?.analysis?.difyErrorMessage === "string"
        ? report.state.analysis.difyErrorMessage
        : "";
    if (nested && nested.trim()) {
        return nested.trim();
    }

    return "";
});

const shouldShowAiUnavailableNotice = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return false;

    const hasStaticContent =
        canShowStructuredStatic.value ||
        (Array.isArray(details.issues) && details.issues.length > 0) ||
        Boolean(details.staticSummary) ||
        Boolean(details.staticMetadata);
    if (!hasStaticContent) {
        return false;
    }

    const aiReport = details.dmlReport;
    const hasAiContent = Boolean(
        aiReport &&
            ((Array.isArray(aiReport.issues) && aiReport.issues.length) ||
                (Array.isArray(aiReport.segments) && aiReport.segments.length) ||
                (typeof aiReport.aggregatedText === "string" && aiReport.aggregatedText.trim()) ||
                (typeof aiReport.reportText === "string" && aiReport.reportText.trim()) ||
                (aiReport.aggregated && Object.keys(aiReport.aggregated).length))
    );

    return !hasAiContent;
});

const reportAiUnavailableNotice = computed(() => {
    if (!shouldShowAiUnavailableNotice.value) return "";
    const detail = activeReportAiErrorMessage.value;
    if (detail) {
        return `無法取得 AI審查報告：${detail}。目前僅顯示靜態分析器報告。`;
    }
    return "無法取得 AI審查報告，僅顯示靜態分析器報告。";
});

const shouldShowReportIssuesSection = computed(
    () => Boolean(activeReportDetails.value) || canShowCodeIssues.value
);

const activeReportIssueCount = computed(() => {
    const details = activeReportDetails.value;
    if (!details) return null;
    if (Number.isFinite(details.combinedTotalIssues)) {
        return Number(details.combinedTotalIssues);
    }
    if (Number.isFinite(details.totalIssues)) return Number(details.totalIssues);
    const list = Array.isArray(details.issues) ? details.issues : [];
    if (Array.isArray(details.aggregatedIssues) && details.aggregatedIssues.length) {
        return details.aggregatedIssues.length;
    }
    return list.length;
});

function setStructuredReportViewMode(mode) {
    if (!mode) return;
    if (mode !== "combined" && mode !== "static" && mode !== "dml") return;
    if (mode === structuredReportViewMode.value) return;
    if (mode === "combined" && !canShowStructuredSummary.value) return;
    if (mode === "static" && !canShowStructuredStatic.value) return;
    if (mode === "dml" && !canShowStructuredDml.value) return;
    structuredReportViewMode.value = mode;
}

function ensureStructuredReportViewMode(preferred) {
    const order = [];
    if (preferred) {
        order.push(preferred);
    }
    order.push("combined", "static", "dml");

    for (const mode of order) {
        if (mode === "combined" && canShowStructuredSummary.value) {
            if (structuredReportViewMode.value !== "combined") {
                structuredReportViewMode.value = "combined";
            }
            return;
        }
        if (mode === "static" && canShowStructuredStatic.value) {
            if (structuredReportViewMode.value !== "static") {
                structuredReportViewMode.value = "static";
            }
            return;
        }
        if (mode === "dml" && canShowStructuredDml.value) {
            if (structuredReportViewMode.value !== "dml") {
                structuredReportViewMode.value = "dml";
            }
            return;
        }
    }

    if (structuredReportViewMode.value !== "combined") {
        structuredReportViewMode.value = "combined";
    }
}

watch(
    [canShowStructuredSummary, canShowStructuredStatic, canShowStructuredDml],
    () => {
        ensureStructuredReportViewMode(structuredReportViewMode.value);
    },
    { immediate: true }
);

function normaliseErrorMessage(error) {
    if (!error) return "未知錯誤";
    if (typeof error === "string") {
        return error;
    }
    if (error instanceof Error) {
        return error.message || "未知錯誤";
    }
    if (typeof error.message === "string" && error.message.trim()) {
        return error.message.trim();
    }
    return String(error);
}

function buildReportExportMetadata(type, overrides = {}) {
    const report = activeReport.value;
    const projectName = report?.project?.name ?? "";
    const filePath = report?.path ?? "";
    const updatedAt = report?.state?.updatedAt ?? null;
    const updatedAtDisplay = report?.state?.updatedAtDisplay ?? "";

    return {
        projectName,
        filePath,
        updatedAt,
        updatedAtDisplay,
        type,
        ...overrides
    };
}

async function exportCombinedReportJson() {
    if (!canExportCombinedReport.value || reportExportState.combined) {
        return;
    }
    if (!activeReportDetails.value) {
        return;
    }

    const info = combinedReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的聚合報告 JSON 內容");
        }
        return;
    }

    reportExportState.combined = true;
    try {
        const aggregatedSource = activeReportDetails.value.combinedSummary || {};
        const metadata = buildReportExportMetadata("combined", {
            generatedAt:
                aggregatedSource?.generated_at ||
                aggregatedSource?.generatedAt ||
                activeReport.value?.state?.updatedAt ||
                null,
            typeLabel: "聚合報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export combined report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出聚合報告 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.combined = false;
    }
}

async function exportStaticReportJson() {
    if (!canExportStaticReport.value || reportExportState.static) {
        return;
    }
    if (!activeReportDetails.value) {
        return;
    }

    const info = staticReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的靜態分析 JSON 內容");
        }
        return;
    }

    reportExportState.static = true;
    try {
        const metadata = buildReportExportMetadata("static", {
            typeLabel: "靜態分析報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export static report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出靜態分析 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.static = false;
    }
}

async function exportAiReportJson() {
    if (!canExportAiReport.value || reportExportState.ai) {
        return;
    }
    const dmlDetails = dmlReportDetails.value;
    if (!dmlDetails) {
        return;
    }

    const info = aiReportJsonInfo.value;
    if (!info.raw) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("尚無可匯出的 AI 審查 JSON 內容");
        }
        return;
    }

    reportExportState.ai = true;
    try {
        const metadata = buildReportExportMetadata("ai", {
            generatedAt: dmlDetails.generatedAt ?? null,
            typeLabel: "AI 審查報告",
            extension: "json"
        });
        await exportJsonReport({
            json: info.raw,
            metadata
        });
    } catch (error) {
        console.error("Failed to export AI review report JSON", error);
        if (typeof safeAlertFail === "function") {
            safeAlertFail(`匯出 AI 審查 JSON 失敗：${normaliseErrorMessage(error)}`);
        }
    } finally {
        reportExportState.ai = false;
    }
}

async function exportCurrentStructuredReportJson() {
    const config = structuredReportExportConfig.value;
    if (!config.canExport || config.busy) {
        return;
    }
    if (config.type === "static") {
        await exportStaticReportJson();
        return;
    }
    if (config.type === "ai") {
        await exportAiReportJson();
        return;
    }
    await exportCombinedReportJson();
}

watch(activeReport, (report) => {
    if (!report) {
        structuredReportViewMode.value = "combined";
        return;
    }
    ensureStructuredReportViewMode("combined");
});

watch(
    [activeReport, activeReportDetails],
    ([report, details]) => {
        if (report && details) {
            logReportDebugInfo(report, details);
        }
    },
    { flush: "post" }
);

const middlePaneStyle = computed(() => {
    const hasActiveTool = isProjectToolActive.value || isReportToolActive.value;
    const width = hasActiveTool ? middlePaneWidth.value : 0;
    const widthValue = `${width}px`;
    return {
        flex: hasActiveTool ? `0 0 ${widthValue}` : "0 0 0px",
        width: widthValue,
        maxWidth: "100%"
    };
});

const chatWindowStyle = computed(() => ({
    width: `${chatWindowState.width}px`,
    height: `${chatWindowState.height}px`,
    left: `${chatWindowState.x}px`,
    top: `${chatWindowState.y}px`
}));

const isChatToggleDisabled = computed(() => isChatLocked.value && isChatWindowOpen.value);

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}


function buildIssueMetaLine(type, keySource, issues, isOrphan = false) {
    const label = type === "fix" ? "Fix" : "Issues";
    const keySuffix = typeof keySource === "number" ? keySource : String(keySource || type);
    const html = type === "fix"
        ? buildIssueFixHtml(issues)
        : buildIssueDetailsHtml(issues, isOrphan);
    return {
        key: `${type}-${keySuffix}`,
        type,
        number: typeof keySource === "number" ? keySource : null,
        displayNumber: "",
        iconLabel: label,
        html: html || "&nbsp;",
        hasIssue: true,
        issues,
        isMeta: true,
        isOrphan: Boolean(isOrphan)
    };
}

function buildIssueLineDebugInfo(issues) {
    if (!Array.isArray(issues) || !issues.length) {
        return [];
    }

    return issues.map((issue, index) => {
        const meta = ensureIssueLineMeta(issue);
        return {
            index,
            rule: issue?.rule_id ?? issue?.ruleId ?? issue?.rule ?? "",
            title: issue?.title ?? issue?.message ?? "",
            line: meta.label,
            start: meta.start,
            end: meta.end
        };
    });
}

function logReportDebugInfo(report, details) {
    if (!report || !report.state || report.state.status !== "ready") {
        return;
    }

    const { state, path, project } = report;
    const projectId = project?.id ?? null;
    const projectName = project?.name ?? "";
    const combinedReportJson = normaliseJsonContent(state.combinedReportJson);

    const { staticIssues, aiIssues, aggregatedIssues } = activeReportIssueSources.value;
    const issueDebugEntries = buildIssueLineDebugInfo([
        ...(Array.isArray(staticIssues) ? staticIssues : []),
        ...(Array.isArray(aiIssues) ? aiIssues : []),
        ...(Array.isArray(aggregatedIssues) ? aggregatedIssues : [])
    ]);

    const payload = {
        projectId,
        projectName,
        path,
        combinedReportJson: combinedReportJson || null,
        parsedReport: state.parsedReport || null
    };

    console.groupCollapsed("[Report][Debug] Selected report payload");
    console.log(payload);
    console.groupEnd();

    if (details && details.issues) {
        console.groupCollapsed("[Report][Debug] Issue line ranges");
        console.log(issueDebugEntries);
        console.groupEnd();
    }
}

function buildIssueDetailsHtml(issues, isOrphan = false) {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    const rows = [];

    const buildSeverityRuleIssueTuples = (issue) => {
        const severityLevels = Array.isArray(issue?.severity_levels)
            ? issue.severity_levels
            : [];
        const ruleIds = Array.isArray(issue?.rule_ids) ? issue.rule_ids : [];
        const issueMessages = Array.isArray(issue?.issues) ? issue.issues : [];
        const maxLen = Math.max(severityLevels.length, ruleIds.length, issueMessages.length);

        if (!maxLen) return "";

        const tupleRows = [];

        for (let index = 0; index < maxLen; index += 1) {
            const severity = typeof severityLevels[index] === "string" ? severityLevels[index].trim() : "";
            const ruleId = typeof ruleIds[index] === "string" ? ruleIds[index].trim() : "";
            const issueText = typeof issueMessages[index] === "string" ? issueMessages[index].trim() : "";

            tupleRows.push(
                `<li class="reportIssueInlineTuple">` +
                    `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--severity">${escapeHtml(severity)}</span>` +
                    `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--rule">${escapeHtml(ruleId)}</span>` +
                    `<span class="reportIssueInlineTupleItem reportIssueInlineTupleItem--message">${escapeHtml(issueText)}</span>` +
                `</li>`
            );
        }

        return `<ul class="reportIssueInlineTupleList">${tupleRows.join("")}</ul>`;
    };

    issues.forEach((issue) => {
        const details = Array.isArray(issue?.details) && issue.details.length ? issue.details : [issue];
        const issueItems = Array.isArray(issue?.issues)
            ? issue.issues.filter((entry) => typeof entry === "string" && entry.trim())
            : [];
        details.forEach((detail, detailIndex) => {
            const lineIndex = Number(detail?.index ?? detailIndex + 1);
            const lineMeta = ensureIssueLineMeta(issue);
            const lineLabel = lineMeta.label || (Number.isFinite(lineIndex) ? `#${lineIndex}` : "");
            const badges = [];
            if (lineLabel) {
                badges.push(`<span class="reportIssueInlineLine">Line ${escapeHtml(lineLabel)}</span>`);
            }
            if (detail?.ruleId) {
                badges.push(`<span class="reportIssueInlineRule">${escapeHtml(detail.ruleId)}</span>`);
            }
            if (detail?.severityLabel) {
                const severityClass = detail.severityClass || "info";
                badges.push(
                    `<span class="reportIssueInlineSeverity reportIssueInlineSeverity--${severityClass}">${escapeHtml(
                        detail.severityLabel
                    )}</span>`
                );
            }

            const badgeBlock = badges.length
                ? `<span class="reportIssueInlineBadges">${badges.join(" ")}</span>`
                : "";

            const messageText =
                typeof detail?.message === "string" && detail.message.trim()
                    ? detail.message.trim()
                    : typeof issue?.message === "string" && issue.message.trim()
                      ? issue.message.trim()
                      : "未提供說明";
            const message = `<span class="reportIssueInlineMessage">${escapeHtml(messageText)}</span>`;

            const issueList = (() => {
                const tupleList = buildSeverityRuleIssueTuples(issue);
                if (tupleList) return tupleList;

                return issueItems.length
                    ? `<ul class="reportIssueInlineList">${issueItems
                          .map((text) => `<li>${escapeHtml(text)}</li>`)
                          .join("")}</ul>`
                    : "";
            })();

            const metaParts = [];
            if (issue?.objectName) {
                metaParts.push(`<span class="reportIssueInlineObject">${escapeHtml(issue.objectName)}</span>`);
            }
            if (Number.isFinite(detail?.column)) {
                metaParts.push(`<span class="reportIssueInlineColumn">列 ${escapeHtml(String(detail.column))}</span>`);
            }
            const meta = metaParts.length
                ? `<span class="reportIssueInlineMeta">${metaParts.join(" · ")}</span>`
                : "";

            const logLineLabel = lineLabel || (Number.isFinite(lineIndex) ? `#${lineIndex}` : "(unknown)");
            console.log("[reportIssueInlineRow]", {
                line: logLineLabel,
                detailIndex,
                isOrphan,
                hasColumn: Number.isFinite(detail?.column),
                severity: detail?.severityLabel || issue?.severityLabel || null
            });

            rows.push(`<div class="reportIssueInlineRow">${badgeBlock}${message}${issueList}${meta}</div>`);
        });
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">未檢測到問題</div>';
    }

    return rows.join("");
}

const buildIssueFixHtml = (issues) => {
    if (!Array.isArray(issues) || !issues.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    const rows = [];

    const collectRecommendations = (issue) => {
        const entries = [];
        const push = (value) => {
            if (typeof value !== "string") return;
            const trimmed = value.trim();
            if (!trimmed) return;
            entries.push(trimmed);
        };

        const pushList = (list) => {
            if (!Array.isArray(list)) return;
            list.forEach((item) => push(item));
        };

        const details = Array.isArray(issue?.details) ? issue.details : [];
        details.forEach((detail) => {
            if (typeof detail?.recommendation === "string") {
                push(detail.recommendation);
            }
            if (Array.isArray(detail?.recommendation)) {
                pushList(detail.recommendation);
            }
            if (typeof detail?.suggestion === "string") {
                push(detail.suggestion);
            }
            if (Array.isArray(detail?.suggestion)) {
                pushList(detail.suggestion);
            }
        });

        if (typeof issue?.recommendation === "string") {
            push(issue.recommendation);
        }
        if (Array.isArray(issue?.recommendation)) {
            pushList(issue.recommendation);
        }
        if (Array.isArray(issue?.recommendations)) {
            pushList(issue.recommendations);
        }
        if (typeof issue?.suggestion === "string") {
            push(issue.suggestion);
        }
        if (Array.isArray(issue?.suggestionList)) {
            pushList(issue.suggestionList);
        }

        return entries;
    };

    const extractFixedCode = (issue) => {
        const details = Array.isArray(issue?.details) ? issue.details : [];
        for (const detail of details) {
            const candidate =
                typeof detail?.fixed_code === "string"
                    ? detail.fixed_code
                    : typeof detail?.fixedCode === "string"
                      ? detail.fixedCode
                      : "";
            if (candidate && candidate.trim()) {
                return candidate.trim();
            }
        }

        if (typeof issue?.fixed_code === "string" && issue.fixed_code.trim()) {
            return issue.fixed_code.trim();
        }
        if (typeof issue?.fixedCode === "string" && issue.fixedCode.trim()) {
            return issue.fixedCode.trim();
        }
        return "";
    };

    issues.forEach((issue) => {
        const recommendations = collectRecommendations(issue);
        if (recommendations.length) {
            const items = recommendations
                .map(
                    (text) =>
                        `<li class="reportIssueInlineRow reportIssueInlineRecommendation">${escapeHtml(text)}</li>`
                )
                .join("");
            rows.push(`<ul class="reportIssueInlineRecommendationList">${items}</ul>`);
        } else {
            rows.push('<div class="reportIssueInlineRow reportIssueInlineRow--empty">&nbsp;</div>');
        }

        const fixedCode = extractFixedCode(issue);
        if (fixedCode) {
            rows.push(
                `<pre class="reportIssueInlineRow reportIssueInlineCode"><code>${escapeHtml(fixedCode)}</code></pre>`
            );
        } else {
            rows.push('<div class="reportIssueInlineRow reportIssueInlineRow--empty">&nbsp;</div>');
        }
    });

    if (!rows.length) {
        return '<div class="reportIssueInlineRow reportIssueInlineRow--empty">暫無建議</div>';
    }

    return rows.join("");
};

function renderLineContent(line) {
    const rawText = typeof line?.raw === "string" ? line.raw : (line?.content || "").replace(/ /g, " ");
    const selection = codeSelection.value;
    const safe = escapeHtml(rawText);

    if (!selection || !selection.startLine || !selection.endLine || !Number.isFinite(line?.number)) {
        return safe.length ? safe : "&nbsp;";
    }

    const lineNumber = line.number;
    if (lineNumber < selection.startLine || lineNumber > selection.endLine) {
        return safe.length ? safe : "&nbsp;";
    }

    const plain = rawText;
    const lineLength = plain.length;
    const startIndex = lineNumber === selection.startLine ? Math.max(0, (selection.startColumn ?? 1) - 1) : 0;
    const endIndex = lineNumber === selection.endLine
        ? Math.min(lineLength, selection.endColumn ?? lineLength)
        : lineLength;

    const safeBefore = escapeHtml(plain.slice(0, startIndex));
    const highlightEnd = Math.max(startIndex, endIndex);
    const middleRaw = plain.slice(startIndex, highlightEnd);
    const safeMiddle = escapeHtml(middleRaw);
    const safeAfter = escapeHtml(plain.slice(highlightEnd));

    const highlighted = `<span class="codeSelectionHighlight">${safeMiddle.length ? safeMiddle : "&nbsp;"}</span>`;
    const combined = `${safeBefore}${highlighted}${safeAfter}`;
    return combined.length ? combined : "&nbsp;";
}

function clearCodeSelection() {
    if (codeSelection.value) {
        codeSelection.value = null;
    }
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function isWithinCodeLine(target) {
    const root = codeScrollRef.value;
    if (!root || !target) return false;

    let current = target;
    while (current && current !== root) {
        if (current.classList && (current.classList.contains("codeLine") || current.classList.contains("codeLineContent") || current.classList.contains("codeLineNo"))) {
            return true;
        }
        current = current.parentNode;
    }

    return false;
}

function resolveLineInfo(node) {
    if (!node) return null;
    let current = node.nodeType === 3 ? node.parentElement : node;
    while (current && current !== codeScrollRef.value) {
        if (current.classList && current.classList.contains("codeLine")) {
            const lineNumber = Number.parseInt(current.dataset?.line || "", 10);
            const contentEl = current.querySelector(".codeLineContent");
            return {
                lineEl: current,
                contentEl,
                lineNumber: Number.isFinite(lineNumber) ? lineNumber : null
            };
        }
        current = current.parentElement;
    }
    return null;
}

function normaliseSelectionRangeText(range) {
    return range
        .toString()
        .replace(/\u00A0/g, " ")
        .replace(/\r\n|\r/g, "\n");
}

function measureColumn(lineInfo, container, offset, mode) {
    if (!lineInfo?.contentEl || typeof document === "undefined") return null;
    const targetContainer = container?.nodeType === 3 ? container : container;
    if (!lineInfo.contentEl.contains(targetContainer)) {
        if (mode === "end") {
            const fullRange = document.createRange();
            fullRange.selectNodeContents(lineInfo.contentEl);
            return normaliseSelectionRangeText(fullRange).length || null;
        }
        return 1;
    }
    const range = document.createRange();
    range.selectNodeContents(lineInfo.contentEl);
    try {
        range.setEnd(container, offset);
    } catch (error) {
        return null;
    }
    const length = normaliseSelectionRangeText(range).length;
    if (mode === "start") {
        return Math.max(1, length + 1);
    }
    return Math.max(1, length);
}

function buildSelectedSnippet() {
    if (typeof window === "undefined") return null;
    const root = codeScrollRef.value;
    if (!root) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        return null;
    }

    const rawText = normaliseSelectionRangeText(range);
    if (!rawText.trim()) return null;

    const startInfo = resolveLineInfo(range.startContainer);
    const endInfo = resolveLineInfo(range.endContainer);
    if (!startInfo || !endInfo) return null;

    const startLine = startInfo.lineNumber;
    const endLine = endInfo.lineNumber;
    const startColumn = measureColumn(startInfo, range.startContainer, range.startOffset, "start");
    const endColumn = measureColumn(endInfo, range.endContainer, range.endOffset, "end");
    const lineCount = startLine !== null && endLine !== null ? endLine - startLine + 1 : null;

    const path = previewing.value.path || treeStore.activeTreePath.value || "";
    const name = previewing.value.name || path || "選取片段";

    const snippet = {
        path,
        name,
        label: name,
        startLine,
        endLine,
        startColumn,
        endColumn,
        lineCount,
        text: rawText
    };

    codeSelection.value = snippet;
    shouldClearAfterPointerClick = false;
    return snippet;
}

function handleDocumentSelectionChange() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (previewing.value.kind !== "text") return;
    const root = codeScrollRef.value;
    if (!root) return;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    if (selection.isCollapsed) {
        return;
    }

    const snippet = buildSelectedSnippet();
    if (!snippet) {
        clearCodeSelection();
    }
}

function handleDocumentPointerUp(event) {
    const root = codeScrollRef.value;
    if (!root) {
        pointerDownInCode = false;
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
        return;
    }

    const target = event?.target || null;
    const pointerUpInside = target ? root.contains(target) : false;

    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
    const selectionInCode =
        !!selection &&
        selection.rangeCount > 0 &&
        root.contains(selection.anchorNode) &&
        root.contains(selection.focusNode);
    const hasActiveSelection = !!selectionInCode && selection && !selection.isCollapsed;

    if (hasActiveSelection) {
        // Ensure the most recent drag selection is captured even if the
        // browser collapses the native selection highlight after mouseup.
        const snippet = buildSelectedSnippet();
        if (!snippet && codeSelection.value) {
            // Re-emit the existing selection so the custom highlight remains
            // visible when the document selection collapses immediately.
            codeSelection.value = { ...codeSelection.value };
        }
        shouldClearAfterPointerClick = false;
        lastPointerDownWasOutsideCode = false;
    } else if (pointerDownInCode && pointerUpInside && shouldClearAfterPointerClick) {
        clearCodeSelection();
    } else if (lastPointerDownWasOutsideCode && !pointerUpInside) {
        // Preserve the current highlight when the interaction happens completely outside the editor
        // by re-emitting the stored selection so Vue keeps the custom highlight rendered.
        if (codeSelection.value) {
            codeSelection.value = { ...codeSelection.value };
        }
    }

    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;
    lastPointerDownWasOutsideCode = false;
}

function handleCodeScrollPointerDown(event) {
    if (event.button !== 0) return;
    if (previewing.value.kind !== "text") return;
    const target = event?.target || null;
    const withinLine = isWithinCodeLine(target);
    pointerDownInCode = withinLine;
    shouldClearAfterPointerClick = withinLine && !!codeSelection.value;
    lastPointerDownWasOutsideCode = !withinLine;
}

function handleDocumentPointerDown(event) {
    const root = codeScrollRef.value;
    if (!root) return;
    const target = event?.target || null;
    const pointerDownInside = target ? root.contains(target) : false;
    if (pointerDownInside) {
        lastPointerDownWasOutsideCode = false;
        return;
    }

    lastPointerDownWasOutsideCode = true;
    pointerDownInCode = false;
    shouldClearAfterPointerClick = false;

    if (codeSelection.value) {
        // Touching other panes should not discard the stored snippet, so keep the
        // highlight alive by nudging Vue's reactivity system.
        codeSelection.value = { ...codeSelection.value };
    }
}

let wrapMeasureFrame = null;
let codeScrollResizeObserver = null;

function runLineWrapMeasurement() {
    if (!showCodeLineNumbers.value) {
        showCodeLineNumbers.value = true;
    }
}

function scheduleLineWrapMeasurement() {
    if (typeof window === "undefined") return;
    if (wrapMeasureFrame !== null) {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    wrapMeasureFrame = window.requestAnimationFrame(() => {
        wrapMeasureFrame = null;
        runLineWrapMeasurement();
    });
}

watch(isChatWindowOpen, (visible) => {
    if (visible) {
        openAssistantSession();
        const shouldForce = connection.value.status === "error";
        retryHandshake({ force: shouldForce });
        if (!hasInitializedChatWindow.value) {
            chatWindowState.width = 420;
            chatWindowState.height = 520;
            chatWindowState.x = Math.max(20, window.innerWidth - chatWindowState.width - 40);
            chatWindowState.y = 80;
            hasInitializedChatWindow.value = true;
        } else {
            ensureChatWindowInView();
        }
        nextTick(() => {
            ensureChatWindowInView();
        });
    } else {
        closeAssistantSession();
    }
});

watch(
    () => previewing.value.kind,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => previewing.value.text,
    () => {
        scheduleLineWrapMeasurement();
    },
    { flush: "post" }
);

watch(
    () => previewLineItems.value.length,
    () => {
        scheduleLineWrapMeasurement();
    }
);

watch(
    () => reportIssueLines.value,
    () => {
        focusPendingReportIssue();
    },
    { flush: "post" }
);

watch(
    () => activeReportTarget.value,
    () => {
        focusPendingReportIssue();
    }
);

watch(
    () => codeScrollRef.value,
    (next, prev) => {
        if (codeScrollResizeObserver && prev) {
            codeScrollResizeObserver.unobserve(prev);
        }
        if (codeScrollResizeObserver && next) {
            codeScrollResizeObserver.observe(next);
        }
        scheduleLineWrapMeasurement();
    }
);

onMounted(() => {
    if (typeof window !== "undefined" && "ResizeObserver" in window) {
        codeScrollResizeObserver = new window.ResizeObserver(() => {
            scheduleLineWrapMeasurement();
        });
        if (codeScrollRef.value) {
            codeScrollResizeObserver.observe(codeScrollRef.value);
        }
    }
    scheduleLineWrapMeasurement();
});

onBeforeUnmount(() => {
    if (wrapMeasureFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(wrapMeasureFrame);
        wrapMeasureFrame = null;
    }
    if (codeScrollResizeObserver) {
        if (codeScrollRef.value) {
            codeScrollResizeObserver.unobserve(codeScrollRef.value);
        }
        if (typeof codeScrollResizeObserver.disconnect === "function") {
            codeScrollResizeObserver.disconnect();
        }
        codeScrollResizeObserver = null;
    }
});

watch(
    () => previewing.value.kind,
    (kind) => {
        if (kind !== "text") {
            clearCodeSelection();
        }
    }
);

watch(
    () => previewing.value.path,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreePath.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => activeTreeRevision.value,
    () => {
        clearCodeSelection();
    }
);

watch(
    () => previewing.value.text,
    () => {
        if (previewing.value.kind === "text") {
            clearCodeSelection();
        }
    }
);

watch(
    [pendingReportIssueJump, activeReport, reportIssueLines],
    () => {
        focusPendingReportIssue();
    },
    { deep: true, flush: "post" }
);

watch(
    [reportIssuesContentRef, reportViewerContentRef],
    () => {
        focusPendingReportIssue();
    },
    { flush: "post" }
);

async function ensureActiveProject() {
    const list = Array.isArray(projects.value) ? projects.value : [];
    if (!list.length) return;

    const selectedIdValue = selectedProjectId.value;
    if (!selectedIdValue) {
        return;
    }

    const current = list.find((project) => project.id === selectedIdValue);
    if (!current) {
        selectedProjectId.value = null;
        return;
    }

    if (!tree.value.length && !isLoadingTree.value) {
        isTreeCollapsed.value = false;
        await openProject(current);
    }
}

watch(
    [projects, selectedProjectId],
    async () => {
        await ensureActiveProject();
    },
    { immediate: true }
);

watch(selectedProjectId, (projectId) => {
    if (projectId === null || projectId === undefined) {
        isTreeCollapsed.value = false;
    }
});

function handleSelectProject(project) {
    if (!project) return;
    const currentId = selectedProjectId.value;
    const treeHasNodes = Array.isArray(tree.value) && tree.value.length > 0;
    if (currentId === project.id) {
        if (isTreeCollapsed.value) {
            isTreeCollapsed.value = false;
            if (!treeHasNodes && !isLoadingTree.value) {
                openProject(project);
            }
        } else {
            if (!isLoadingTree.value && !treeHasNodes) {
                openProject(project);
            } else {
                isTreeCollapsed.value = true;
            }
        }
        return;
    }
    isTreeCollapsed.value = false;
    openProject(project);
}

function toggleProjectTool() {
    if (isProjectToolActive.value) return;
    activeRailTool.value = "projects";
}

function toggleReportTool() {
    if (isReportToolActive.value) return;
    activeRailTool.value = "reports";
    isReportTreeCollapsed.value = true;
}

function togglePreviewTool() {
    if (isPreviewToolActive.value) return;
    activeRailTool.value = "preview";
    isReportTreeCollapsed.value = true;
}

function toggleSettingsTool() {
    if (isSettingsToolActive.value) return;
    activeRailTool.value = "settings";
    isReportTreeCollapsed.value = true;
}

function handleSettingsSave(payload) {
    console.log("[Settings] Saved configuration", payload);
}

function normaliseProjectId(projectId) {
    if (projectId === null || projectId === undefined) return "";
    return String(projectId);
}

function toggleReportTreeCollapsed() {
    isReportTreeCollapsed.value = !isReportTreeCollapsed.value;
}

function toReportKey(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return "";
    return `${projectKey}::${path}`;
}

function parseReportKey(key) {
    if (!key) return { projectId: "", path: "" };
    const index = key.indexOf("::");
    if (index === -1) {
        return { projectId: key, path: "" };
    }
    return {
        projectId: key.slice(0, index),
        path: key.slice(index + 2)
    };
}

function createDefaultReportState() {
    return {
        status: "idle",
        report: "",
        updatedAt: null,
        updatedAtDisplay: null,
        error: "",
        chunks: [],
        segments: [],
        conversationId: "",
        analysis: null,
        issueSummary: null,
        parsedReport: null,
        rawReport: "",
        dify: null,
        dml: null,
        difyErrorMessage: "",
        dmlErrorMessage: "",
        sourceText: "",
        sourceLoaded: false,
        sourceLoading: false,
        sourceError: "",
        combinedReportJson: "",
        staticReportJson: "",
        aiReportJson: ""
    };
}

function computeIssueSummary(reportText, parsedOverride = null) {
    const parsed = parsedOverride || parseReportJson(reportText);
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const summary = parsed?.summary;
    let total = null;
    if (summary && typeof summary === "object") {
        const candidate = summary.total_issues ?? summary.totalIssues;
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
            total = numeric;
        }
        if (!Number.isFinite(total) && summary.sources && typeof summary.sources === "object") {
            const staticSource = summary.sources.static_analyzer || summary.sources.staticAnalyzer;
            if (staticSource && typeof staticSource === "object") {
                const staticTotal = staticSource.total_issues ?? staticSource.totalIssues;
                const staticNumeric = Number(staticTotal);
                if (Number.isFinite(staticNumeric)) {
                    total = staticNumeric;
                }
            }
        }
    }
    if (total === null && Array.isArray(parsed?.issues)) {
        total = parsed.issues.length;
    }
    if (total === null && typeof summary === "string") {
        const normalised = summary.trim();
        if (normalised === "代码正常" || normalised === "代碼正常" || normalised === "OK") {
            total = 0;
        }
    }
    return {
        totalIssues: Number.isFinite(total) ? total : null,
        summary,
        raw: parsed
    };
}

function normaliseReportAnalysisState(state) {
    if (!state) return;

    const rawReport = typeof state.rawReport === "string" ? state.rawReport : "";
    const baseAnalysis =
        state.analysis && typeof state.analysis === "object" && !Array.isArray(state.analysis)
            ? { ...state.analysis }
            : {};
    let difyTarget =
        state.dify && typeof state.dify === "object" && !Array.isArray(state.dify) ? { ...state.dify } : null;

    if (rawReport) {
        if (typeof baseAnalysis.rawReport !== "string") {
            baseAnalysis.rawReport = rawReport;
        }
        if (typeof baseAnalysis.originalResult !== "string") {
            baseAnalysis.originalResult = rawReport;
        }
        if (typeof baseAnalysis.result !== "string") {
            baseAnalysis.result = rawReport;
        }
    }

    const parsedReport = state.parsedReport && typeof state.parsedReport === "object" ? state.parsedReport : null;
    if (parsedReport) {
        const reports =
            parsedReport.reports && typeof parsedReport.reports === "object" ? parsedReport.reports : null;
        if (reports) {
            const staticResult = mergeStaticReportIntoAnalysis({
                state,
                baseAnalysis,
                reports,
                difyTarget
            });
            difyTarget = staticResult.difyTarget;

            mergeAiReviewReportIntoAnalysis({ state, baseAnalysis, reports });

            const difyReport = reports.dify_workflow || reports.difyWorkflow;
            if (difyReport && typeof difyReport === "object") {
                if (!difyTarget) {
                    difyTarget = {};
                }
                const difyRaw = difyReport.raw;
                if (typeof difyRaw === "string" && difyRaw.trim()) {
                    if (!difyTarget.report || !difyTarget.report.trim()) {
                        difyTarget.report = difyRaw.trim();
                    }
                } else if (difyRaw && typeof difyRaw === "object") {
                    difyTarget.raw = difyRaw;
                    if (!difyTarget.report || !difyTarget.report.trim()) {
                        try {
                            difyTarget.report = JSON.stringify(difyRaw);
                        } catch (error) {
                            console.warn("[Report] Failed to stringify dify raw payload", error);
                        }
                    }
                } else if (!difyTarget.report || !difyTarget.report.trim()) {
                    try {
                        const fallback = { ...difyReport };
                        delete fallback.raw;
                        difyTarget.report = JSON.stringify(fallback);
                    } catch (error) {
                        console.warn("[Report] Failed to stringify dify workflow report", error);
                    }
                }
                if (!difyTarget.summary && difyReport.summary && typeof difyReport.summary === "object") {
                    difyTarget.summary = difyReport.summary;
                }
                if (!difyTarget.issues && Array.isArray(difyReport.issues)) {
                    difyTarget.issues = difyReport.issues;
                }
                if (!difyTarget.metadata && difyReport.metadata && typeof difyReport.metadata === "object") {
                    difyTarget.metadata = difyReport.metadata;
                }
            }
        }

        const aiPersistencePatch = buildAiReviewPersistencePayload(state);
        if (aiPersistencePatch) {
            Object.assign(baseAnalysis, aiPersistencePatch);
        }

        const parsedSummaryData =
            parsedReport.summary && typeof parsedReport.summary === "object" ? parsedReport.summary : null;
        if (!state.difyErrorMessage && parsedSummaryData) {
            const sources =
                parsedSummaryData.sources && typeof parsedSummaryData.sources === "object"
                    ? parsedSummaryData.sources
                    : null;
            if (sources) {
                const difySource = sources.dify_workflow || sources.difyWorkflow;
                const difyError =
                    typeof difySource?.error_message === "string"
                        ? difySource.error_message
                        : typeof difySource?.errorMessage === "string"
                        ? difySource.errorMessage
                        : "";
                if (difyError && difyError.trim()) {
                    state.difyErrorMessage = difyError.trim();
                }
            }
        }
    }

    if (difyTarget) {
        const hasReport = typeof difyTarget.report === "string" && difyTarget.report.trim().length > 0;
        if (!hasReport && difyTarget.raw && typeof difyTarget.raw === "object") {
            try {
                difyTarget.report = JSON.stringify(difyTarget.raw);
            } catch (error) {
                console.warn("[Report] Failed to stringify dify raw object for state", error);
            }
        }
        const filteredKeys = Object.keys(difyTarget).filter((key) => {
            const value = difyTarget[key];
            if (value === null || value === undefined) return false;
            if (typeof value === "string") return value.trim().length > 0;
            if (Array.isArray(value)) return value.length > 0;
            if (typeof value === "object") return Object.keys(value).length > 0;
            return true;
        });
        if (filteredKeys.length > 0) {
            state.dify = difyTarget;
        } else {
            state.dify = null;
        }
    } else if (!state.dify) {
        state.dify = null;
    }

    state.analysis = Object.keys(baseAnalysis).length ? baseAnalysis : null;
}

function ensureReportTreeEntry(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportTreeCache, key)) {
        reportTreeCache[key] = {
            nodes: [],
            loading: false,
            error: "",
            expandedPaths: [],
            hydratedReports: false,
            hydratingReports: false,
            reportHydrationError: ""
        };
    }
    return reportTreeCache[key];
}

function ensureProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportBatchStates, key)) {
        reportBatchStates[key] = {
            running: false,
            processed: 0,
            total: 0
        };
    }
    return reportBatchStates[key];
}

function getProjectBatchState(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    return reportBatchStates[key] || null;
}

function getProjectIssueCount(projectId) {
    const key = normaliseProjectId(projectId);
    if (!key) return null;
    const totals = projectIssueTotals.value;
    if (!totals.has(key)) return null;
    return totals.get(key);
}

function ensureFileReportState(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return null;
    if (!Object.prototype.hasOwnProperty.call(reportStates, key)) {
        reportStates[key] = createDefaultReportState();
    }
    return reportStates[key];
}

function getReportStateForFile(projectId, path) {
    return ensureFileReportState(projectId, path) || createDefaultReportState();
}

function getStatusLabel(status) {
    switch (status) {
        case "processing":
            return "處理中";
        case "ready":
            return "已完成";
        case "error":
            return "失敗";
        default:
            return "待生成";
    }
}

function isReportNodeExpanded(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return false;
    if (!path) return true;
    return entry.expandedPaths.includes(path);
}

function toggleReportNode(projectId, path) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || !path) return;
    const set = new Set(entry.expandedPaths);
    if (set.has(path)) {
        set.delete(path);
    } else {
        set.add(path);
    }
    entry.expandedPaths = Array.from(set);
}

function collectFileNodes(nodes, bucket = []) {
    for (const node of nodes || []) {
        if (node.type === "file") {
            bucket.push(node);
        } else if (node.children && node.children.length) {
            collectFileNodes(node.children, bucket);
        }
    }
    return bucket;
}

function findTreeNodeByPath(nodes, targetPath) {
    if (!targetPath) return null;
    for (const node of nodes || []) {
        if (!node) continue;
        if (node.path === targetPath) {
            return node;
        }
        if (node.children && node.children.length) {
            const found = findTreeNodeByPath(node.children, targetPath);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

function ensureStatesForProject(projectId, nodes) {
    const fileNodes = collectFileNodes(nodes);
    const validPaths = new Set();
    for (const node of fileNodes) {
        if (!node?.path) continue;
        ensureFileReportState(projectId, node.path);
        validPaths.add(node.path);
    }

    Object.keys(reportStates).forEach((key) => {
        const parsed = parseReportKey(key);
        if (parsed.projectId !== normaliseProjectId(projectId)) return;
        if (parsed.path && !validPaths.has(parsed.path)) {
            if (activeReportTarget.value &&
                activeReportTarget.value.projectId === parsed.projectId &&
                activeReportTarget.value.path === parsed.path) {
                activeReportTarget.value = null;
            }
            delete reportStates[key];
        }
    });
}

function parseHydratedTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed);
        }
    }
    return null;
}

function normaliseHydratedReportText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (error) {
            console.warn("[Report] Failed to stringify hydrated report payload", error, value);
            return "";
        }
    }
    return String(value);
}

function normaliseHydratedString(value) {
    return typeof value === "string" ? value : "";
}

function pickFirstNonEmptyString(...candidates) {
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const resolved = pickFirstNonEmptyString(...candidate);
            if (resolved) {
                return resolved;
            }
            continue;
        }
        if (candidate === null || candidate === undefined) {
            continue;
        }
        const value = typeof candidate === "string" ? candidate : String(candidate);
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return "";
}

async function hydrateReportsForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry) return;
    if (entry.hydratedReports || entry.hydratingReports) return;
    entry.hydratingReports = true;
    entry.reportHydrationError = "";
    try {
        const records = await fetchProjectReports(projectId);
        for (const record of records) {
            if (!record || !record.path) continue;
            const state = ensureFileReportState(projectId, record.path);
            if (!state) continue;
            const hydratedStatus = normaliseHydratedString(record.status).trim();
            const hydratedReportText = normaliseHydratedReportText(record.report);
            const trimmedReportText = typeof hydratedReportText === "string" ? hydratedReportText.trim() : "";
            const combinedJson = normaliseHydratedString(record.combinedReportJson).trim();
            const staticJson = normaliseHydratedString(record.staticReportJson).trim();
            const aiJson = normaliseHydratedString(record.aiReportJson).trim();
            const hasStoredSnapshots = Boolean(combinedJson || staticJson || aiJson);

            state.status =
                hydratedStatus ||
                (trimmedReportText || hasStoredSnapshots ? "ready" : "idle");
            state.report = hydratedReportText;
            state.error = normaliseHydratedString(record.error);
            state.chunks = Array.isArray(record.chunks) ? record.chunks : [];
            state.segments = Array.isArray(record.segments) ? record.segments : [];
            state.combinedReportJson = normaliseHydratedString(record.combinedReportJson);
            state.staticReportJson = normaliseHydratedString(record.staticReportJson);
            state.aiReportJson = normaliseHydratedString(record.aiReportJson);
            state.conversationId = normaliseHydratedString(record.conversationId);
            state.analysis =
                record.analysis && typeof record.analysis === "object" && !Array.isArray(record.analysis)
                    ? record.analysis
                    : null;
            const hydratedRawReport = normaliseHydratedString(record.rawReport);
            const analysisResult = normaliseHydratedString(record.analysis?.result);
            const analysisOriginal = normaliseHydratedString(record.analysis?.originalResult);
            state.rawReport = hydratedRawReport || analysisResult || analysisOriginal || "";
            state.dify = normaliseReportObject(record.dify);
            if (!state.dify) {
                state.dify = normaliseReportObject(record.analysis?.dify);
            }
            state.dml = normaliseAiReviewPayload(record.dml);
            if (!state.dml) {
                state.dml = normaliseAiReviewPayload(record.analysis?.dmlReport);
            }
            state.difyErrorMessage = normaliseHydratedString(record.difyErrorMessage);
            if (!state.difyErrorMessage) {
                state.difyErrorMessage = normaliseHydratedString(record.analysis?.difyErrorMessage);
            }
            state.parsedReport = parseReportJson(state.report);
            if ((!state.parsedReport || typeof state.parsedReport !== "object") && hasStoredSnapshots) {
                state.parsedReport = { summary: null, reports: {} };
            }
            state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
            hydrateAiReviewStateFromRecord(state, record);
            normaliseReportAnalysisState(state);
            updateIssueSummaryTotals(state);
            const timestamp = parseHydratedTimestamp(record.generatedAt || record.updatedAt || record.createdAt);
            state.updatedAt = timestamp;
            state.updatedAtDisplay = timestamp ? timestamp.toLocaleString() : null;
            if (typeof state.sourceText !== "string") {
                state.sourceText = "";
            }
            state.sourceLoaded = Boolean(state.sourceText);
            state.sourceLoading = false;
            state.sourceError = "";
        }
        entry.hydratedReports = true;
    } catch (error) {
        console.error("[Report] Failed to hydrate saved reports", { projectId, error });
        entry.reportHydrationError = error?.message ? String(error.message) : String(error);
    } finally {
        entry.hydratingReports = false;
    }
}

async function loadReportTreeForProject(projectId) {
    const entry = ensureReportTreeEntry(projectId);
    if (!entry || entry.loading) return;
    entry.loading = true;
    entry.error = "";
    try {
        const nodes = await treeStore.loadTreeFromDB(projectId);
        entry.nodes = nodes;
        ensureStatesForProject(projectId, nodes);
        await hydrateReportsForProject(projectId);
        const nextExpanded = new Set(entry.expandedPaths);
        for (const node of nodes) {
            if (node.type === "dir") {
                nextExpanded.add(node.path);
            }
        }
        entry.expandedPaths = Array.from(nextExpanded);
    } catch (error) {
        console.error("[Report] Failed to load tree for project", projectId, error);
        entry.error = error?.message ? String(error.message) : String(error);
    } finally {
        entry.loading = false;
    }
}

function selectReport(projectId, path) {
    const key = toReportKey(projectId, path);
    if (!key) return;
    const state = reportStates[key];
    if (!state || state.status !== "ready") return;
    activeReportTarget.value = {
        projectId: normaliseProjectId(projectId),
        path
    };
}

function resolveReportIssuesContainer() {
    const containers = [];

    if (reportViewerContentRef.value) {
        containers.push(reportViewerContentRef.value);
    }

    if (typeof document !== "undefined") {
        const docViewer = document.querySelector(".reportViewerContent");
        if (docViewer && !containers.includes(docViewer)) {
            containers.push(docViewer);
        }
    }

    if (reportIssuesContentRef.value) {
        containers.push(reportIssuesContentRef.value);
    }

    if (typeof document !== "undefined") {
        const documentContainer = document.querySelector(".reportIssuesContent");
        if (documentContainer && !containers.includes(documentContainer)) {
            containers.push(documentContainer);
        }
    }

    for (const el of containers) {
        if (el && el.scrollHeight - el.clientHeight > 4) {
            return el;
        }
    }

    return containers[0] || null;
}

function findReportIssueLineElement(lineStart, lineEnd) {
    const selectors = [];
    if (Number.isFinite(lineEnd) && lineEnd !== lineStart) {
        const endLine = Math.max(1, Math.floor(lineEnd));
        selectors.push(`.codeLine[data-line="${endLine}"]`);
        selectors.push(`.codeLine--meta[data-line="${endLine}"]`);
        selectors.push(`.codeLine--fixMeta[data-line="${endLine}"]`);
        selectors.push(`.codeLineNo[data-line="${endLine}"]`);
        selectors.push(`.codeLine--meta .codeLineNo[data-line="${endLine}"]`);
        selectors.push(`.codeLine--fixMeta .codeLineNo[data-line="${endLine}"]`);
    }
    if (Number.isFinite(lineStart)) {
        const startLine = Math.max(1, Math.floor(lineStart));
        selectors.push(`.codeLine[data-line="${startLine}"]`);
        selectors.push(`.codeLine--meta[data-line="${startLine}"]`);
        selectors.push(`.codeLine--fixMeta[data-line="${startLine}"]`);
        selectors.push(`.codeLineNo[data-line="${startLine}"]`);
        selectors.push(`.codeLine--meta .codeLineNo[data-line="${startLine}"]`);
        selectors.push(`.codeLine--fixMeta .codeLineNo[data-line="${startLine}"]`);
    }

    const roots = [];
    if (reportViewerContentRef.value) roots.push(reportViewerContentRef.value);
    if (reportIssuesContentRef.value) roots.push(reportIssuesContentRef.value);
    if (typeof document !== "undefined") roots.push(document);

    for (const root of roots) {
        for (const selector of selectors) {
            const found = root.querySelector(selector);
            if (found) {
                return found.closest(".codeLine") || found;
            }
        }
    }
    return null;
}

function scrollReportIssuesToLine(targetEl, containerEl) {
    if (!targetEl || !containerEl) return false;

    const lineEl = targetEl.closest(".codeLine") || targetEl;
    const containerRect = containerEl.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    const workspaceRect =
        typeof document !== "undefined"
            ? document.querySelector(".workspace--reports")?.getBoundingClientRect() || null
            : null;
    const visibleTop = workspaceRect
        ? Math.max(containerRect.top, workspaceRect.top)
        : containerRect.top;
    const visibleBottom = workspaceRect
        ? Math.min(containerRect.bottom, workspaceRect.bottom)
        : containerRect.bottom;
    const visibleHeight = Math.max(0, visibleBottom - visibleTop) || containerEl.clientHeight;
    const offsetTop = lineRect.top - containerRect.top + containerEl.scrollTop;
    const desiredTop = Math.max(0, offsetTop - visibleHeight + lineRect.height);

    containerEl.scrollTo({ top: desiredTop, behavior: "smooth" });
    return true;
}

function focusPendingReportIssue() {
    if (!pendingReportIssueJump.value) return;
    schedulePendingReportIssueJump(0);
}

function schedulePendingReportIssueJump(delay = REPORT_ISSUE_JUMP_INTERVAL) {
    if (pendingReportIssueJumpTimer) {
        clearTimeout(pendingReportIssueJumpTimer);
    }
    pendingReportIssueJumpTimer = setTimeout(() => {
        pendingReportIssueJumpTimer = null;
        attemptPendingReportIssueJump();
    }, delay);
}

function attemptPendingReportIssueJump() {
    const pending = pendingReportIssueJump.value;
    if (!pending) return;

    const active = activeReport.value;
    const activeProjectId = normaliseProjectId(active?.project?.id);
    if (!active || activeProjectId !== pending.projectId || active.path !== pending.path) {
        schedulePendingReportIssueJump();
        return;
    }

    if (!reportIssueLines.value.length) {
        schedulePendingReportIssueJump();
        return;
    }

    const container = resolveReportIssuesContainer();
    const lineEl = findReportIssueLineElement(pending.lineStart, pending.lineEnd);
    if (container && lineEl && scrollReportIssuesToLine(lineEl, container)) {
        pendingReportIssueJump.value = null;
        return;
    }

    if ((pending.attempts ?? 0) + 1 >= REPORT_ISSUE_JUMP_MAX_ATTEMPTS) {
        pendingReportIssueJump.value = null;
        return;
    }

    pendingReportIssueJump.value = {
        ...pending,
        attempts: (pending.attempts ?? 0) + 1
    };
    schedulePendingReportIssueJump();
}

function handlePreviewIssueSelect(payload) {
    const projectId = normaliseProjectId(payload?.projectId);
    const path = typeof payload?.path === "string" ? payload.path : "";
    const lineStart = Number(payload?.lineStart ?? payload?.lineEnd ?? NaN);
    const lineEnd = Number(payload?.lineEnd ?? payload?.lineStart ?? NaN);

    if (!projectId || !path || !Number.isFinite(lineStart)) {
        return;
    }

    activeRailTool.value = "reports";
    isReportTreeCollapsed.value = true;
    selectReport(projectId, path);

    pendingReportIssueJump.value = {
        projectId,
        path,
        lineStart: Math.max(1, Math.floor(lineStart)),
        lineEnd: Number.isFinite(lineEnd) ? Math.max(1, Math.floor(lineEnd)) : Math.max(1, Math.floor(lineStart)),
        attempts: 0
    };

    schedulePendingReportIssueJump(0);
}

async function openProjectFileFromReportTree(projectId, path) {
    const projectKey = normaliseProjectId(projectId);
    if (!projectKey || !path) return;

    const projectList = Array.isArray(projects.value) ? projects.value : [];
    const project = projectList.find(
        (item) => normaliseProjectId(item.id) === projectKey
    );
    if (!project) return;

    if (isTreeCollapsed.value) {
        isTreeCollapsed.value = false;
    }

    if (selectedProjectId.value !== project.id) {
        await openProject(project);
    } else if (!Array.isArray(tree.value) || tree.value.length === 0) {
        await openProject(project);
    }

    const entry = ensureReportTreeEntry(project.id);
    if (entry && !entry.nodes.length && !entry.loading) {
        loadReportTreeForProject(project.id);
    }

    const searchNodes = (entry && entry.nodes && entry.nodes.length)
        ? entry.nodes
        : tree.value;
    let targetNode = findTreeNodeByPath(searchNodes, path);
    if (!targetNode) {
        const name = path.split("/").pop() || path;
        targetNode = { type: "file", path, name, mime: "" };
    }

    treeStore.selectTreeNode(path);
    try {
        await treeStore.openNode(targetNode);
    } catch (error) {
        console.error("[Workspace] Failed to preview file from report tree", {
            projectId: project.id,
            path,
            error
        });
    }
}

async function loadTextContentForNode(project, node) {
    try {
        const root = await getProjectRootHandleById(project.id);
        const fileHandle = await fileSystemService.getFileHandleByPath(root, node.path);
        const file = await fileHandle.getFile();
        const mime = node.mime || file.type || "";
        if (!preview.isTextLike(node.name, mime)) {
            throw new Error("目前僅支援純文字或程式碼檔案的審查");
        }
        const text = await file.text();
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }
        return { text, mime, size: file.size };
    } catch (error) {
        if (error?.code !== "external-handle-missing") {
            throw error;
        }
        const record = await fetchStoredFileContent(project.id, node.path);
        if (!record || typeof record.content !== "string") {
            throw new Error("無法從資料庫讀取檔案內容，請重新匯入資料夾。");
        }
        const mime = record.mime || node.mime || "text/plain";
        if (!preview.isTextLike(node.name, mime)) {
            throw new Error("目前僅支援純文字或程式碼檔案的審查");
        }
        const text = record.content;
        if (!text.trim()) {
            throw new Error("檔案內容為空");
        }
        return { text, mime, size: Number(record.size) || text.length };
    }
}

async function generateReportForFile(project, node, options = {}) {
    const { autoSelect = true, silent = false } = options;
    if (!project || !node || node.type !== "file") {
        return { status: "skipped" };
    }
    const projectId = normaliseProjectId(project.id);
    const state = ensureFileReportState(projectId, node.path);
    if (!state || state.status === "processing") {
        return { status: "processing" };
    }

    state.status = "processing";
    state.error = "";
    state.report = "";
    state.chunks = [];
    state.segments = [];
    state.conversationId = "";
    state.analysis = null;
    state.issueSummary = null;
    state.parsedReport = null;
    state.rawReport = "";
    state.dify = null;
    state.dml = null;
    state.difyErrorMessage = "";
    state.dmlErrorMessage = "";
    state.sourceText = "";
    state.sourceLoaded = false;
    state.sourceLoading = false;
    state.sourceError = "";
    state.combinedReportJson = "";
    state.staticReportJson = "";
    state.aiReportJson = "";

    try {
        const { text } = await loadTextContentForNode(project, node);

        state.sourceText = text;
        state.sourceLoaded = true;
        state.sourceLoading = false;
        state.sourceError = "";

        const payload = await generateReportViaDify({
            projectId,
            projectName: project.name,
            path: node.path,
            content: text
        });

        const completedAt = payload?.generatedAt ? new Date(payload.generatedAt) : new Date();
        state.status = "ready";
        state.updatedAt = completedAt;
        state.updatedAtDisplay = completedAt.toLocaleString();
        state.report = payload?.report || "";
        state.chunks = Array.isArray(payload?.chunks) ? payload.chunks : [];
        state.segments = Array.isArray(payload?.segments) ? payload.segments : [];
        state.conversationId = payload?.conversationId || "";
        state.rawReport = typeof payload?.rawReport === "string" ? payload.rawReport : "";
        state.dify = normaliseReportObject(payload?.dify);
        if (!state.dify) {
            state.dify = normaliseReportObject(payload?.analysis?.dify);
        }
        state.dml = normaliseAiReviewPayload(payload?.dml);
        if (!state.dml) {
            state.dml = normaliseAiReviewPayload(payload?.analysis?.dmlReport);
        }
        state.difyErrorMessage = typeof payload?.difyErrorMessage === "string" ? payload.difyErrorMessage : "";
        state.analysis = payload?.analysis || null;
        applyAiReviewResultToState(state, payload);
        state.parsedReport = parseReportJson(state.report);
        state.issueSummary = computeIssueSummary(state.report, state.parsedReport);
        normaliseReportAnalysisState(state);
        updateIssueSummaryTotals(state);
        state.error = "";
        state.combinedReportJson = typeof payload?.combinedReportJson === "string" ? payload.combinedReportJson : "";
        state.staticReportJson = typeof payload?.staticReportJson === "string" ? payload.staticReportJson : "";
        state.aiReportJson = typeof payload?.aiReportJson === "string" ? payload.aiReportJson : "";

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        return { status: "ready" };
    } catch (error) {
        const message = error?.message ? String(error.message) : String(error);
        state.status = "error";
        state.error = message;
        state.report = "";
        state.chunks = [];
        state.segments = [];
        state.conversationId = "";
        state.analysis = null;
        state.issueSummary = null;
        state.parsedReport = null;
        state.rawReport = "";
        state.dify = null;
        state.dml = null;
        state.difyErrorMessage = "";
        state.dmlErrorMessage = "";
        state.sourceLoading = false;
        if (!state.sourceText) {
            state.sourceLoaded = false;
        }
        state.combinedReportJson = "";
        state.staticReportJson = "";
        state.aiReportJson = "";
        const now = new Date();
        state.updatedAt = now;
        state.updatedAtDisplay = now.toLocaleString();

        if (autoSelect) {
            activeReportTarget.value = {
                projectId,
                path: node.path
            };
        }

        if (!silent) {
            if (error?.name === "SecurityError" || error?.name === "NotAllowedError" || error?.name === "TypeError") {
                await safeAlertFail("生成報告失敗", error);
            } else {
                alert(`生成報告失敗：${message}`);
            }
        }

        return { status: "error", error };
    }
}

async function generateProjectReports(project) {
    if (!project) return;
    const projectId = normaliseProjectId(project.id);
    const batchState = ensureProjectBatchState(projectId);
    if (!batchState || batchState.running) return;

    const entry = ensureReportTreeEntry(project.id);
    if (!entry.nodes.length) {
        await loadReportTreeForProject(project.id);
    }

    if (entry.loading) {
        await new Promise((resolve) => {
            const stop = watch(
                () => entry.loading,
                (loading) => {
                    if (!loading) {
                        stop();
                        resolve();
                    }
                }
            );
        });
    }

    if (entry.error) {
        console.warn("[Report] Cannot start batch generation due to tree error", entry.error);
        alert(`無法生成報告：${entry.error}`);
        return;
    }

    const nodes = collectFileNodes(entry.nodes);
    if (!nodes.length) {
        alert("此專案尚未索引可供審查的檔案");
        return;
    }

    batchState.running = true;
    batchState.processed = 0;
    batchState.total = nodes.length;

    try {
        for (const node of nodes) {
            await generateReportForFile(project, node, { autoSelect: false, silent: true });
            batchState.processed += 1;
        }
    } finally {
        batchState.running = false;
        if (nodes.length) {
            activeReportTarget.value = {
                projectId,
                path: nodes[nodes.length - 1].path
            };
        }
    }
}

watch(
    projects,
    (list) => {
        const projectList = Array.isArray(list) ? list : [];
        const currentIds = new Set(projectList.map((project) => normaliseProjectId(project.id)));

        projectList.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (shouldPrepareReportTrees.value && entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (
                shouldPrepareReportTrees.value &&
                entry &&
                !entry.hydratedReports &&
                !entry.hydratingReports
            ) {
                hydrateReportsForProject(project.id);
            }
        });

        Object.keys(reportTreeCache).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportTreeCache[projectId];
            }
        });

        Object.keys(reportBatchStates).forEach((projectId) => {
            if (!currentIds.has(projectId)) {
                delete reportBatchStates[projectId];
            }
        });

        Object.keys(reportStates).forEach((key) => {
            const parsed = parseReportKey(key);
            if (!currentIds.has(parsed.projectId)) {
                if (activeReportTarget.value &&
                    activeReportTarget.value.projectId === parsed.projectId &&
                    activeReportTarget.value.path === parsed.path) {
                    activeReportTarget.value = null;
                }
                delete reportStates[key];
            }
        });
    },
    { immediate: true, deep: true }
);

watch(
    () => projectTreeUpdateEvent.value,
    (event) => {
        const projectKey = normaliseProjectId(event?.projectId);
        if (!projectKey) {
            return;
        }
        const entry = ensureReportTreeEntry(projectKey);
        if (!entry) {
            return;
        }
        entry.nodes = [];
        entry.loading = false;
        entry.error = "";
        entry.hydratedReports = false;
        entry.hydratingReports = false;
        if (shouldPrepareReportTrees.value) {
            loadReportTreeForProject(projectKey);
        }
    },
    { deep: false }
);

watch(
    shouldPrepareReportTrees,
    (active) => {
        if (!active) return;
        const list = Array.isArray(projects.value) ? projects.value : [];
        list.forEach((project) => {
            const entry = ensureReportTreeEntry(project.id);
            if (entry && !entry.nodes.length && !entry.loading) {
                loadReportTreeForProject(project.id);
            }
            if (entry && !entry.hydratedReports && !entry.hydratingReports) {
                hydrateReportsForProject(project.id);
            }
        });
    }
);

watch(
    readyReports,
    (list) => {
        if (!list.length) {
            activeReportTarget.value = null;
            return;
        }
        const target = activeReportTarget.value;
        const hasActive = target
            ? list.some((entry) => normaliseProjectId(entry.project.id) === target.projectId && entry.path === target.path)
            : false;
        if (!hasActive) {
            const next = list[0];
            activeReportTarget.value = {
                projectId: normaliseProjectId(next.project.id),
                path: next.path
            };
        }
    },
    { immediate: true }
);

watch(
    activeReport,
    async (report) => {
        if (!report) return;
        const state = report.state;
        if (state.sourceLoaded || state.sourceLoading) {
            return;
        }
        state.sourceLoading = true;
        state.sourceError = "";
        try {
            const root = await getProjectRootHandleById(report.project.id);
            if (!root) {
                throw new Error("找不到專案根目錄，無法載入檔案內容");
            }
            const fileHandle = await fileSystemService.getFileHandleByPath(root, report.path);
            if (!fileHandle) {
                throw new Error("找不到對應的檔案");
            }
            const file = await fileHandle.getFile();
            const text = await file.text();
            state.sourceText = typeof text === "string" ? text : "";
            state.sourceLoaded = true;
            state.sourceError = "";
        } catch (error) {
            const record = await fetchStoredFileContent(report.project.id, report.path);
            if (record && typeof record.content === "string") {
                state.sourceText = record.content;
                state.sourceLoaded = true;
                state.sourceError = "";
            } else {
                state.sourceText = "";
                state.sourceLoaded = false;
                const baseMessage = error?.message ? String(error.message) : "無法載入檔案內容";
                state.sourceError = `${baseMessage}，且無法從資料庫讀取備份內容。`;
            }
        } finally {
            state.sourceLoading = false;
        }
    },
    { immediate: true }
);

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function shouldIgnoreMouseEvent(event) {
    return (
        event?.type === "mousedown" &&
        typeof window !== "undefined" &&
        "PointerEvent" in window
    );
}

function startPreviewResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = middlePaneWidth.value;
    const containerEl = mainContentRef.value;
    const workspaceEl = containerEl?.querySelector(".workSpace");
    if (!workspaceEl) return;

    const minWidth = 260;
    const workspaceMinWidth = 320;
    const workspaceRect = workspaceEl.getBoundingClientRect();
    const maxAdditional = Math.max(0, workspaceRect.width - workspaceMinWidth);
    const maxWidth = Math.max(minWidth, startWidth + maxAdditional);

    const handleMove = (pointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        middlePaneWidth.value = clamp(startWidth + delta, minWidth, maxWidth);
    };

    const stop = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
}

function clampReportSidebarWidth() {
    const containerEl = mainContentRef.value;
    if (!containerEl) return;

    const navEl = containerEl.querySelector(".toolColumn");
    const availableWidth = containerEl.clientWidth - (navEl?.clientWidth ?? 0);
    if (availableWidth <= 0) return;

    const workspaceMinWidth = 320;
    const minRailWidthDefault = 260;
    const maxRailWidth = Math.max(0, availableWidth - workspaceMinWidth);

    if (maxRailWidth === 0) {
        middlePaneWidth.value = 0;
        return;
    }

    const minRailWidth = Math.min(minRailWidthDefault, maxRailWidth);
    middlePaneWidth.value = clamp(middlePaneWidth.value, minRailWidth, maxRailWidth);
}

async function handleAddActiveContext() {
    const added = await addActiveNode();
    if (added) {
        openChatWindow();
    }
}

function handleAddSelectionContext() {
    let snippet = buildSelectedSnippet();
    if (!snippet) {
        snippet = codeSelection.value ? { ...codeSelection.value } : null;
    }
    if (!snippet) {
        if (typeof safeAlertFail === "function") {
            safeAlertFail("請先在程式碼預覽中選取想加入的內容。");
        }
        return;
    }
    const added = addSnippetContext({ ...snippet });
    if (added) {
        openChatWindow();
        clearCodeSelection();
        if (typeof window !== "undefined") {
            const selection = window.getSelection?.();
            if (selection?.removeAllRanges) {
                selection.removeAllRanges();
            }
        }
    }
}

async function handleSendMessage(content) {
    const text = (content || "").trim();
    if (!text) return;
    openChatWindow();
    await sendUserMessage(text);
}

function openChatWindow() {
    if (!isChatWindowOpen.value) {
        isChatWindowOpen.value = true;
    }
}

function closeChatWindow() {
    if (isChatWindowOpen.value) {
        isChatWindowOpen.value = false;
        stopChatDrag();
        stopChatResize();
    }
}

function toggleChatWindow() {
    if (isChatWindowOpen.value) return;
    if (!isChatToggleDisabled.value) {
        openChatWindow();
    }
}

function ensureChatWindowInView() {
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(chatWindowState.x, 0, maxX);
    chatWindowState.y = clamp(chatWindowState.y, 0, maxY);
}

function startChatDrag(event) {
    if (shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    chatDragState.active = true;
    chatDragState.offsetX = event.clientX - chatWindowState.x;
    chatDragState.offsetY = event.clientY - chatWindowState.y;
    window.addEventListener("pointermove", handleChatDrag);
    window.addEventListener("pointerup", stopChatDrag);
    window.addEventListener("pointercancel", stopChatDrag);
}

function handleChatDrag(event) {
    if (!chatDragState.active) return;
    event.preventDefault();
    const maxX = Math.max(0, window.innerWidth - chatWindowState.width);
    const maxY = Math.max(0, window.innerHeight - chatWindowState.height);
    chatWindowState.x = clamp(event.clientX - chatDragState.offsetX, 0, maxX);
    chatWindowState.y = clamp(event.clientY - chatDragState.offsetY, 0, maxY);
}

function stopChatDrag() {
    chatDragState.active = false;
    window.removeEventListener("pointermove", handleChatDrag);
    window.removeEventListener("pointerup", stopChatDrag);
    window.removeEventListener("pointercancel", stopChatDrag);
}

function startChatResize(payload) {
    const event = payload?.originalEvent ?? payload;
    const edges = payload?.edges ?? { right: true, bottom: true };
    if (!event || shouldIgnoreMouseEvent(event)) return;
    if (event.button !== 0) return;
    if (!edges.left && !edges.right && !edges.top && !edges.bottom) return;

    event.preventDefault();
    chatResizeState.active = true;
    chatResizeState.startX = event.clientX;
    chatResizeState.startY = event.clientY;
    chatResizeState.startWidth = chatWindowState.width;
    chatResizeState.startHeight = chatWindowState.height;
    chatResizeState.startLeft = chatWindowState.x;
    chatResizeState.startTop = chatWindowState.y;
    chatResizeState.edges.left = !!edges.left;
    chatResizeState.edges.right = !!edges.right;
    chatResizeState.edges.top = !!edges.top;
    chatResizeState.edges.bottom = !!edges.bottom;

    window.addEventListener("pointermove", handleChatResize);
    window.addEventListener("pointerup", stopChatResize);
    window.addEventListener("pointercancel", stopChatResize);
}

function handleChatResize(event) {
    if (!chatResizeState.active) return;
    event.preventDefault();
    const deltaX = event.clientX - chatResizeState.startX;
    const deltaY = event.clientY - chatResizeState.startY;
    const minWidth = 320;
    const minHeight = 320;

    if (chatResizeState.edges.left) {
        const proposedLeft = chatResizeState.startLeft + deltaX;
        const maxLeft = chatResizeState.startLeft + chatResizeState.startWidth - minWidth;
        const clampedLeft = clamp(proposedLeft, 0, Math.max(0, maxLeft));
        const widthFromLeft = chatResizeState.startWidth + (chatResizeState.startLeft - clampedLeft);
        const maxWidthFromViewport = Math.max(minWidth, window.innerWidth - clampedLeft);
        chatWindowState.x = clampedLeft;
        chatWindowState.width = clamp(widthFromLeft, minWidth, maxWidthFromViewport);
    }

    if (chatResizeState.edges.top) {
        const proposedTop = chatResizeState.startTop + deltaY;
        const maxTop = chatResizeState.startTop + chatResizeState.startHeight - minHeight;
        const clampedTop = clamp(proposedTop, 0, Math.max(0, maxTop));
        const heightFromTop = chatResizeState.startHeight + (chatResizeState.startTop - clampedTop);
        const maxHeightFromViewport = Math.max(minHeight, window.innerHeight - clampedTop);
        chatWindowState.y = clampedTop;
        chatWindowState.height = clamp(heightFromTop, minHeight, maxHeightFromViewport);
    }

    if (chatResizeState.edges.right) {
        const maxWidth = Math.max(minWidth, window.innerWidth - chatWindowState.x);
        chatWindowState.width = clamp(chatResizeState.startWidth + deltaX, minWidth, maxWidth);
    }

    if (chatResizeState.edges.bottom) {
        const maxHeight = Math.max(minHeight, window.innerHeight - chatWindowState.y);
        chatWindowState.height = clamp(chatResizeState.startHeight + deltaY, minHeight, maxHeight);
    }
}

function stopChatResize() {
    chatResizeState.active = false;
    chatResizeState.edges.left = false;
    chatResizeState.edges.right = false;
    chatResizeState.edges.top = false;
    chatResizeState.edges.bottom = false;
    window.removeEventListener("pointermove", handleChatResize);
    window.removeEventListener("pointerup", stopChatResize);
    window.removeEventListener("pointercancel", stopChatResize);
}

onMounted(async () => {
    await cleanupLegacyHandles();
    updateCapabilityFlags();
    await loadProjectsFromDB();
    clampReportSidebarWidth();
    window.addEventListener("resize", ensureChatWindowInView);
    window.addEventListener("resize", clampReportSidebarWidth);
    if (typeof document !== "undefined") {
        document.addEventListener("pointerdown", handleDocumentPointerDown, true);
        document.addEventListener("selectionchange", handleDocumentSelectionChange);
        document.addEventListener("mouseup", handleDocumentPointerUp);
    }
});

onBeforeUnmount(() => {
    window.removeEventListener("resize", ensureChatWindowInView);
    window.removeEventListener("resize", clampReportSidebarWidth);
    stopChatDrag();
    stopChatResize();
    if (pendingReportIssueJumpTimer) {
        clearTimeout(pendingReportIssueJumpTimer);
    }
    if (typeof document !== "undefined") {
        document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
        document.removeEventListener("selectionchange", handleDocumentSelectionChange);
        document.removeEventListener("mouseup", handleDocumentPointerUp);
    }
});
</script>



<template>
    <div class="page page--light">
        <div class="topBar">
            <div class="topBar_left">
                <h1 class="topBar_title">
                    <img :src="workspaceLogoSrc" alt="Workspace" class="topBar_logo" />
                </h1>
            </div>
            <div class="topBar_spacer"></div>
            <div class="topBar_right">
                <div class="topBar_addProject" @click="showUploadModal = true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                        <path d="M256,0C114.6,0,0,114.6,0,256s114.6,256,256,256s256-114.6,256-256S397.4,0,256,0z M405.3,277.3c0,11.8-9.5,21.3-21.3,21.3h-85.3V384c0,11.8-9.5,21.3-21.3,21.3h-42.7c-11.8,0-21.3-9.6-21.3-21.3v-85.3H128c-11.8,0-21.3-9.6-21.3-21.3v-42.7c0-11.8,9.5-21.3,21.3-21.3h85.3V128c0-11.8,9.5-21.3,21.3-21.3h42.7c11.8,0,21.3,9.6,21.3,21.3v85.3H384c11.8,0,21.3,9.6,21.3,21.3V277.3z" />
                    </svg>
                    <p>新增專案</p>
                </div>
            </div>
        </div>

        <div class="mainContent themed-scrollbar" ref="mainContentRef">
            <nav class="toolColumn">
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isProjectToolActive }"
                    @click="toggleProjectTool"
                    :aria-pressed="isProjectToolActive"
                    title="專案列表"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" opacity="0.18" />
                        <path
                            d="M5 7h5l1.5 2H19v8H5V7Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isPreviewToolActive }"
                    @click="togglePreviewTool"
                    :aria-pressed="isPreviewToolActive"
                    title="報告預覽"
                >
                    <svg viewBox="0 0 1920 1920" aria-hidden="true">
                        <path
                            d="M960 282c529.355 0 960 430.758 960 960 0 77.139-8.922 153.148-26.541 225.882l-10.504 43.144h-560.188c-27.106 74.88-79.85 140.838-155.52 181.045-47.887 25.185-101.647 38.625-155.633 38.625-123.445 0-236.047-67.651-293.76-176.64-5.873-11.18-11.859-25.75-17.845-43.03H37.045l-10.504-43.144C8.922 1395.148 0 1319.14 0 1242c0-529.242 430.645-960 960-960Zm168.17 1229.026c47.66-49.355 61.214-125.139 27.331-189.064-42.24-79.51-403.765-413.59-403.765-413.59s73.638 486.776 115.765 566.287c7.341 13.892 16.941 25.525 27.219 36.367h-.904c2.033 2.146 4.518 3.614 6.551 5.534 4.63 4.405 9.374 8.47 14.344 12.198 3.727 2.823 7.68 5.308 11.52 7.68 5.195 3.162 10.39 6.098 15.924 8.81 4.292 1.92 8.584 3.726 13.101 5.42 5.422 1.92 10.956 3.727 16.716 5.083a159.91 159.91 0 0 0 14.23 3.049c5.76.904 11.407 1.468 17.167 1.694 2.824.113 5.535.79 8.245.79 1.92 0 3.84-.677 5.76-.677 8.245-.226 16.377-1.355 24.508-2.936 3.727-.791 7.567-1.13 11.294-2.146 11.746-3.163 23.266-7.229 34.335-13.214h.338v-.113c15.7-8.245 28.687-19.2 40.32-31.172Zm361.524-625.807 112.715-112.715-119.717-119.831-112.828 112.715 119.83 119.83Zm-614.4-254.457h169.412V471.29H875.294v159.473ZM430.306 885.22l119.83-119.83-112.715-112.716-119.83 119.83L430.306 885.22Z"
                            fill="currentColor"
                            fill-rule="evenodd"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn"
                    :class="{ active: isReportToolActive }"
                    @click="toggleReportTool"
                    :aria-pressed="isReportToolActive"
                    title="報告審查"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="9" fill="currentColor" opacity="0.18" />
                        <path
                            d="M14.8 13.4a4.5 4.5 0 1 0-1.4 1.4l3.5 3.5 1.4-1.4-3.5-3.5Zm-3.8.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn toolColumn_btn--chat"
                    :class="{ active: isChatWindowOpen }"
                    :disabled="isChatToggleDisabled"
                    @click="toggleChatWindow"
                    :aria-pressed="isChatWindowOpen"
                    title="Chat AI"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9A1.5 1.5 0 0 1 18.5 16H7l-3 3Z"
                            fill="currentColor"
                            opacity="0.12"
                        ></path>
                        <path
                            d="M6.5 7A.5.5 0 0 0 6 7.5v6a.5.5 0 0 0 .5.5h8.69L17 16.81V7.5a.5.5 0 0 0-.5-.5h-10Z"
                            fill="currentColor"
                        ></path>
                    </svg>
                </button>
                <button
                    type="button"
                    class="toolColumn_btn toolColumn_btn--settings"
                    :class="{ active: isSettingsToolActive }"
                    @click="toggleSettingsTool"
                    :aria-pressed="isSettingsToolActive"
                    title="設定"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M14.1361 3.36144L15.1312 3.26194L14.1361 3.36144ZM13.9838 2.54161L13.095 3V3L13.9838 2.54161ZM14.4311 4.81793L15.2261 4.21141L15.2261 4.21141L14.4311 4.81793ZM15.3595 5.20248L15.2261 4.21141L15.3595 5.20248ZM16.5979 4.38113L17.2311 5.15509L17.2311 5.15509L16.5979 4.38113ZM17.2853 3.90918L17.5896 4.86175L17.2853 3.90918ZM17.9872 3.94419L18.3848 3.02663L18.3848 3.02663L17.9872 3.94419ZM18.6243 4.4822L17.9172 5.1893L17.9172 5.18931L18.6243 4.4822ZM19.5178 5.37567L20.2249 4.66856L20.2249 4.66856L19.5178 5.37567ZM20.0558 6.01275L20.9733 5.61517L20.9733 5.61516L20.0558 6.01275ZM20.0908 6.71464L21.0434 7.01895L21.0434 7.01894L20.0908 6.71464ZM19.6188 7.4021L18.8449 6.76886L18.8449 6.76886L19.6188 7.4021ZM18.7975 8.64056L17.8064 8.50724L17.8064 8.50725L18.7975 8.64056ZM19.182 9.56893L18.5755 10.364L18.5755 10.364L19.182 9.56893ZM20.6385 9.86385L20.738 8.86882L20.6385 9.86385ZM21.4584 10.0162L21.9168 9.1275L21.9168 9.1275L21.4584 10.0162ZM21.9299 10.5373L22.8599 10.1696L22.8599 10.1696L21.9299 10.5373ZM21.93 13.4626L21 13.095L21 13.095L21.93 13.4626ZM21.4583 13.9838L21.9166 14.8726L21.9166 14.8726L21.4583 13.9838ZM20.6386 14.1361L20.5391 13.1411L20.5065 13.1444L20.4742 13.1497L20.6386 14.1361ZM20.6386 14.1361L20.7381 15.1312L20.7707 15.1279L20.803 15.1225L20.6386 14.1361ZM19.1825 14.4309L18.5762 13.6357L18.5762 13.6357L19.1825 14.4309ZM18.7979 15.3596L17.8068 15.4931V15.4931L18.7979 15.3596ZM19.619 16.5976L18.845 17.2308H18.845L19.619 16.5976ZM20.0908 17.2848L19.1383 17.5892V17.5892L20.0908 17.2848ZM20.0558 17.9869L19.1383 17.5892L19.1383 17.5892L20.0558 17.9869ZM19.5179 18.6238L20.225 19.3309H20.225L19.5179 18.6238ZM18.6243 19.5174L17.9172 18.8102L17.9172 18.8103L18.6243 19.5174ZM17.9873 20.0554L18.3849 20.9729L18.3849 20.9729L17.9873 20.0554ZM17.2854 20.0904L16.981 21.0429L16.981 21.0429L17.2854 20.0904ZM16.5979 19.6184L17.2312 18.8444L17.2226 18.8376L16.5979 19.6184ZM16.5979 19.6184L15.9646 20.3924L15.9732 20.3993L16.5979 19.6184ZM15.3595 18.7971L15.4928 17.806H15.4928L15.3595 18.7971ZM14.4311 19.1816L15.2262 19.7882L15.2262 19.7881L14.4311 19.1816ZM14.1362 20.6383L13.1411 20.5388V20.5388L14.1362 20.6383ZM13.9837 21.4585L13.095 21L13.095 21L13.9837 21.4585ZM13.4628 21.9299L13.095 21L13.095 21L13.4628 21.9299ZM10.5373 21.9299L10.905 21L10.5373 21.9299ZM10.0162 21.4584L10.905 21H10.905L10.0162 21.4584ZM9.86385 20.6385L8.86882 20.7381V20.7381L9.86385 20.6385ZM9.56892 19.182L8.77387 19.7885L8.77387 19.7885L9.56892 19.182ZM8.64057 18.7975L8.50728 17.8064H8.50727L8.64057 18.7975ZM7.40208 19.6189L6.76884 18.8449L6.753 18.8579L6.73771 18.8714L7.40208 19.6189ZM7.40206 19.6189L8.0353 20.3928L8.05113 20.3799L8.06643 20.3663L7.40206 19.6189ZM6.71458 20.0908L7.01887 21.0434H7.01887L6.71458 20.0908ZM6.01272 20.0558L5.61515 20.9734H5.61515L6.01272 20.0558ZM5.37561 19.5178L6.08271 18.8107H6.08271L5.37561 19.5178ZM4.48217 18.6243L3.77506 19.3315L3.77506 19.3315L4.48217 18.6243ZM3.94414 17.9873L4.86171 17.5897L4.86171 17.5897L3.94414 17.9873ZM3.90913 17.2854L4.86171 17.5897L4.86171 17.5897L3.90913 17.2854ZM4.3811 16.5979L5.15506 17.2311H5.15506L4.3811 16.5979ZM5.20247 15.3594L6.19355 15.4928L5.20247 15.3594ZM4.81792 14.4311L5.42445 13.636L5.42445 13.636L4.81792 14.4311ZM3.36143 14.1361L3.26193 15.1312H3.26193L3.36143 14.1361ZM2.54161 13.9838L3 13.095H3L2.54161 13.9838ZM2.07005 13.4627L1.14009 13.8304L1.14009 13.8304L2.07005 13.4627ZM2.07008 10.5372L1.14017 10.1694L1.14017 10.1694L2.07008 10.5372ZM2.54152 10.0163L2.08305 9.12757L2.08305 9.12757L2.54152 10.0163ZM3.36155 9.86384V8.86384H3.31167L3.26205 8.86881L3.36155 9.86384ZM3.36156 9.86384V10.8638H3.41143L3.46106 10.8589L3.36156 9.86384ZM4.81842 9.56881L4.21178 8.77383L4.21177 8.77383L4.81842 9.56881ZM5.20287 8.64066L6.19396 8.50749L6.19396 8.50749L5.20287 8.64066ZM4.38128 7.40182L5.15523 6.76858H5.15523L4.38128 7.40182ZM3.90914 6.71405L4.86175 6.40988L4.86175 6.40988L3.90914 6.71405ZM3.94413 6.01243L3.02651 5.61498L3.02651 5.61498L3.94413 6.01243ZM4.48233 5.37509L5.18944 6.0822H5.18944L4.48233 5.37509ZM5.37565 4.48177L4.66855 3.77466V3.77466L5.37565 4.48177ZM6.01277 3.94373L5.6152 3.02615L5.6152 3.02616L6.01277 3.94373ZM6.71463 3.90872L7.01892 2.95614V2.95614L6.71463 3.90872ZM7.4022 4.38076L8.03543 3.60681V3.60681L7.4022 4.38076ZM8.64044 5.20207L8.77391 4.21101L8.64044 5.20207ZM9.56907 4.81742L8.77391 4.21101L8.77391 4.21101L9.56907 4.81742ZM9.86387 3.36131L10.8589 3.46081V3.46081L9.86387 3.36131ZM10.0162 2.5417L9.12739 2.08341L9.12739 2.08341L10.0162 2.5417ZM10.5374 2.07001L10.905 3L10.905 3L10.5374 2.07001ZM13.4627 2.07005L13.8304 1.1401V1.1401L13.4627 2.07005ZM15.1312 3.26194C15.1108 3.05831 15.0912 2.85693 15.0626 2.6868C15.0324 2.50684 14.9828 2.29705 14.8725 2.08322L13.095 3C13.0721 2.95549 13.0769 2.93878 13.0902 3.01798C13.1052 3.10701 13.1181 3.23089 13.1411 3.46094L15.1312 3.26194ZM15.2261 4.21141C15.2894 4.29433 15.2693 4.33101 15.2342 4.13595C15.2008 3.95045 15.1739 3.68915 15.1312 3.26194L13.1411 3.46094C13.1805 3.85459 13.2152 4.20895 13.2658 4.49017C13.3147 4.76184 13.4009 5.11633 13.636 5.42445L15.2261 4.21141ZM15.2261 4.21141L15.2261 4.21141L13.636 5.42444C14.0718 5.99575 14.7806 6.28935 15.4928 6.19355L15.2261 4.21141ZM15.9646 3.60717C15.6323 3.87905 15.4286 4.04481 15.2738 4.15238C15.1111 4.26548 15.1228 4.22531 15.2261 4.21141L15.4928 6.19355C15.8768 6.14188 16.1885 5.95223 16.4152 5.7947C16.6498 5.63163 16.9249 5.4056 17.2311 5.15509L15.9646 3.60717ZM16.981 2.95661C16.7518 3.02983 16.5684 3.14308 16.4198 3.24897C16.2793 3.34907 16.123 3.47759 15.9646 3.60717L17.2311 5.15509C17.41 5.00869 17.5068 4.93022 17.5803 4.87784C17.6457 4.83124 17.6373 4.84651 17.5896 4.86175L16.981 2.95661ZM18.3848 3.02663C17.9408 2.83421 17.442 2.80934 16.981 2.95661L17.5896 4.86175L17.5896 4.86175L18.3848 3.02663ZM19.3314 3.77509C19.1867 3.6304 19.044 3.48696 18.9142 3.37338C18.7768 3.25323 18.6056 3.12228 18.3848 3.02663L17.5896 4.86175C17.5437 4.84184 17.5369 4.82581 17.5973 4.87869C17.6653 4.93813 17.7537 5.02583 17.9172 5.1893L19.3314 3.77509ZM20.2249 4.66856L19.3314 3.77509L17.9172 5.18931L18.8107 6.08277L20.2249 4.66856ZM20.9733 5.61516C20.8777 5.39441 20.7467 5.22316 20.6266 5.08581C20.513 4.95597 20.3696 4.81326 20.2249 4.66856L18.8106 6.08277C18.9741 6.24626 19.0618 6.33469 19.1213 6.40264C19.1742 6.46308 19.1581 6.45629 19.1382 6.41034L20.9733 5.61516ZM21.0434 7.01894C21.1906 6.55797 21.1658 6.05922 20.9733 5.61517L19.1382 6.41034L19.1382 6.41034L21.0434 7.01894ZM20.3928 8.03534C20.5224 7.87696 20.6509 7.72069 20.751 7.58019C20.8569 7.43156 20.9701 7.24814 21.0434 7.01895L19.1382 6.41033C19.1535 6.36263 19.1687 6.35427 19.1221 6.41968C19.0697 6.4932 18.9913 6.58992 18.8449 6.76886L20.3928 8.03534ZM19.7885 8.77387C19.7746 8.87723 19.7345 8.88894 19.8476 8.72619C19.9551 8.57141 20.1209 8.36764 20.3928 8.03534L18.8449 6.76886C18.5943 7.07506 18.3683 7.35016 18.2052 7.58481C18.0477 7.81148 17.8581 8.12317 17.8064 8.50724L19.7885 8.77387ZM19.7885 8.77387V8.77386L17.8064 8.50725C17.7106 9.21938 18.0042 9.92816 18.5755 10.364L19.7885 8.77387ZM20.738 8.86882C20.3108 8.82609 20.0495 8.79922 19.864 8.76584C19.6689 8.73073 19.7056 8.7106 19.7885 8.77387L18.5755 10.364C18.8836 10.599 19.2381 10.6853 19.5098 10.7342C19.791 10.7848 20.1454 10.8195 20.539 10.8589L20.738 8.86882ZM21.9168 9.1275C21.703 9.01721 21.4932 8.96759 21.3132 8.93737C21.1431 8.9088 20.9417 8.88918 20.738 8.86882L20.539 10.8589C20.7691 10.8819 20.893 10.8948 20.982 10.9098C21.0612 10.9231 21.0445 10.9279 21 10.905L21.9168 9.1275ZM22.8599 10.1696C22.682 9.71957 22.3469 9.34933 21.9168 9.1275L21 10.905L21 10.905L22.8599 10.1696ZM23 11.3682C23 11.1636 23.0005 10.9613 22.989 10.7891C22.9769 10.607 22.9484 10.3933 22.8599 10.1696L21 10.905C20.9816 10.8584 20.9881 10.8423 20.9935 10.9224C20.9995 11.0125 21 11.137 21 11.3682H23ZM23 12.6319V11.3682H21V12.6319H23ZM22.86 13.8302C22.9484 13.6065 22.9769 13.3929 22.989 13.2108C23.0005 13.0388 23 12.8365 23 12.6319H21C21 12.863 20.9995 12.9875 20.9935 13.0776C20.9881 13.1577 20.9816 13.1416 21 13.095L22.86 13.8302ZM21.9166 14.8726C22.3469 14.6507 22.682 14.2804 22.86 13.8302L21 13.095V13.095L21.9166 14.8726ZM20.7381 15.1312C20.9417 15.1108 21.1431 15.0912 21.3132 15.0626C21.4931 15.0324 21.7028 14.9828 21.9166 14.8726L21 13.095C21.0445 13.0721 21.0612 13.077 20.982 13.0902C20.893 13.1052 20.7691 13.1181 20.5391 13.1411L20.7381 15.1312ZM20.803 15.1225L20.803 15.1225L20.4742 13.1497L20.4742 13.1497L20.803 15.1225ZM19.7889 15.2261C19.706 15.2893 19.6693 15.2692 19.8644 15.2341C20.0498 15.2007 20.311 15.1739 20.7381 15.1312L20.5391 13.1411C20.1456 13.1805 19.7913 13.2151 19.5102 13.2657C19.2386 13.3146 18.8842 13.4008 18.5762 13.6357L19.7889 15.2261ZM19.7889 15.2261L19.7889 15.2261L18.5762 13.6357C18.0046 14.0716 17.7108 14.7807 17.8068 15.4931L19.7889 15.2261ZM20.3929 15.9643C20.1212 15.6322 19.9555 15.4285 19.8479 15.2738C19.7348 15.1111 19.775 15.1228 19.7889 15.2261L17.8068 15.4931C17.8585 15.877 18.0481 16.1886 18.2056 16.4152C18.3686 16.6497 18.5946 16.9247 18.845 17.2308L20.3929 15.9643ZM21.0433 16.9803C20.9701 16.7513 20.8569 16.5679 20.751 16.4193C20.651 16.2789 20.5225 16.1227 20.3929 15.9643L18.845 17.2308C18.9914 17.4097 19.0698 17.5064 19.1222 17.5799C19.1688 17.6453 19.1535 17.6369 19.1383 17.5892L21.0433 16.9803ZM20.9733 18.3846C21.1658 17.9404 21.1907 17.4415 21.0433 16.9803L19.1383 17.5892L19.1383 17.5892L20.9733 18.3846ZM20.225 19.3309C20.3697 19.1862 20.5131 19.0436 20.6266 18.9138C20.7467 18.7765 20.8776 18.6053 20.9733 18.3846L19.1383 17.5892C19.1582 17.5433 19.1742 17.5365 19.1213 17.5969C19.0619 17.6648 18.9742 17.7532 18.8108 17.9167L20.225 19.3309ZM19.3314 20.2245L20.225 19.3309L18.8108 17.9167L17.9172 18.8102L19.3314 20.2245ZM18.3849 20.9729C18.6056 20.8773 18.7769 20.7463 18.9142 20.6262C19.044 20.5126 19.1867 20.3692 19.3314 20.2245L17.9172 18.8103C17.7537 18.9737 17.6653 19.0614 17.5974 19.1209C17.5369 19.1737 17.5437 19.1577 17.5897 19.1378L18.3849 20.9729ZM16.981 21.0429C17.442 21.1902 17.9408 21.1653 18.3849 20.9729L17.5897 19.1378H17.5897L16.981 21.0429ZM15.9647 20.3924C16.1231 20.522 16.2793 20.6505 16.4198 20.7506C16.5684 20.8565 16.7519 20.9697 16.981 21.0429L17.5897 19.1378C17.6374 19.153 17.6457 19.1683 17.5803 19.1217C17.5068 19.0693 17.4101 18.9909 17.2312 18.8445L15.9647 20.3924ZM15.9732 20.3993L15.9732 20.3993L17.2226 18.8376L17.2226 18.8375L15.9732 20.3993ZM15.2262 19.7881C15.1228 19.7742 15.1111 19.7341 15.2738 19.8472C15.4286 19.9547 15.6324 20.1205 15.9647 20.3924L17.2311 18.8445C16.925 18.5939 16.6499 18.3679 16.4152 18.2048C16.1886 18.0473 15.8769 17.8577 15.4928 17.806L15.2262 19.7881ZM15.2262 19.7881H15.2262L15.4928 17.806C14.7807 17.7102 14.0719 18.0038 13.636 18.5751L15.2262 19.7881ZM15.1312 20.7378C15.1739 20.3105 15.2008 20.0492 15.2342 19.8636C15.2693 19.6685 15.2894 19.7052 15.2262 19.7882L13.636 18.5751C13.401 18.8832 13.3147 19.2378 13.2658 19.5094C13.2152 19.7907 13.1805 20.1451 13.1411 20.5388L15.1312 20.7378ZM14.8724 21.917C14.9828 21.7031 15.0324 21.4932 15.0626 21.3132C15.0912 21.143 15.1108 20.9415 15.1312 20.7378L13.1411 20.5388C13.1181 20.769 13.1052 20.8929 13.0902 20.982C13.0769 21.0612 13.072 21.0445 13.095 21L14.8724 21.917ZM13.8306 22.8598C14.2805 22.6819 14.6506 22.3469 14.8724 21.917L13.095 21L13.095 21L13.8306 22.8598ZM12.6316 23C12.8363 23 13.0387 23.0005 13.2109 22.989C13.393 22.9768 13.6068 22.9483 13.8306 22.8598L13.095 21C13.1416 20.9816 13.1577 20.9881 13.0776 20.9935C12.9875 20.9995 12.8629 21 12.6316 21V23ZM11.3682 23H12.6316V21H11.3682V23ZM10.1696 22.8599C10.3933 22.9484 10.607 22.9769 10.7891 22.989C10.9613 23.0005 11.1636 23 11.3682 23V21C11.137 21 11.0125 20.9995 10.9224 20.9935C10.8423 20.9881 10.8584 20.9816 10.905 21L10.1696 22.8599ZM9.1275 21.9168C9.34933 22.3469 9.71958 22.682 10.1696 22.8599L10.905 21L9.1275 21.9168ZM8.86882 20.7381C8.88918 20.9417 8.9088 21.1431 8.93737 21.3132C8.96759 21.4932 9.01721 21.703 9.1275 21.9168L10.905 21C10.9279 21.0445 10.9231 21.0612 10.9098 20.982C10.8948 20.893 10.8819 20.7691 10.8589 20.539L8.86882 20.7381ZM8.77387 19.7885C8.7106 19.7056 8.73073 19.6689 8.76584 19.864C8.79922 20.0495 8.82609 20.3108 8.86882 20.7381L10.8589 20.539C10.8195 20.1454 10.7848 19.791 10.7342 19.5098C10.6853 19.2381 10.599 18.8836 10.364 18.5755L8.77387 19.7885ZM8.77387 19.7885L10.364 18.5755C9.92815 18.0042 9.21939 17.7106 8.50728 17.8064L8.77387 19.7885ZM8.03531 20.3928C8.36763 20.1209 8.5714 19.9551 8.72619 19.8476C8.88895 19.7345 8.87724 19.7746 8.77387 19.7885L8.50727 17.8064C8.12318 17.858 7.81149 18.0477 7.58481 18.2052C7.35015 18.3683 7.07504 18.5944 6.76884 18.8449L8.03531 20.3928ZM8.06643 20.3663L8.06644 20.3663L6.73771 18.8714L6.7377 18.8715L8.06643 20.3663ZM7.01887 21.0434C7.24807 20.9702 7.4315 20.8569 7.58013 20.751C7.72064 20.6509 7.87691 20.5224 8.0353 20.3928L6.76883 18.8449C6.58988 18.9913 6.49316 19.0698 6.41963 19.1222C6.35422 19.1688 6.36258 19.1535 6.41029 19.1383L7.01887 21.0434ZM5.61515 20.9734C6.05919 21.1658 6.55791 21.1907 7.01887 21.0434L6.41029 19.1383L6.41029 19.1383L5.61515 20.9734ZM4.6685 20.2249C4.81321 20.3696 4.95592 20.513 5.08577 20.6266C5.22313 20.7468 5.39438 20.8777 5.61515 20.9734L6.41029 19.1383C6.45624 19.1582 6.46304 19.1742 6.40259 19.1213C6.33464 19.0619 6.2462 18.9742 6.08271 18.8107L4.6685 20.2249ZM3.77506 19.3315L4.6685 20.2249L6.08271 18.8107L5.18927 17.9172L3.77506 19.3315ZM3.02657 18.3848C3.12223 18.6056 3.25318 18.7768 3.37333 18.9142C3.48692 19.044 3.63036 19.1868 3.77506 19.3315L5.18928 17.9172C5.02579 17.7538 4.93809 17.6653 4.87864 17.5974C4.82577 17.5369 4.8418 17.5437 4.86171 17.5897L3.02657 18.3848ZM2.95656 16.9811C2.8093 17.4421 2.83417 17.9408 3.02657 18.3848L4.86171 17.5897V17.5897L2.95656 16.9811ZM3.60715 15.9647C3.47756 16.123 3.34903 16.2793 3.24892 16.4198C3.14303 16.5684 3.02977 16.7519 2.95656 16.9811L4.86171 17.5897C4.84647 17.6374 4.83119 17.6457 4.87779 17.5803C4.93018 17.5068 5.00865 17.4101 5.15506 17.2311L3.60715 15.9647ZM4.2114 15.2261C4.2253 15.1228 4.26548 15.1111 4.15237 15.2738C4.0448 15.4286 3.87903 15.6324 3.60715 15.9647L5.15506 17.2311C5.40558 16.9249 5.63162 16.6498 5.79469 16.4152C5.95222 16.1885 6.14188 15.8768 6.19355 15.4928L4.2114 15.2261ZM4.2114 15.2261L4.2114 15.2261L6.19355 15.4928C6.28934 14.7806 5.99575 14.0718 5.42445 13.636L4.2114 15.2261ZM3.26193 15.1312C3.68915 15.1739 3.95044 15.2008 4.13595 15.2342C4.33101 15.2693 4.29432 15.2894 4.2114 15.2261L5.42445 13.636C5.11633 13.4009 4.76184 13.3147 4.49017 13.2658C4.20894 13.2152 3.85458 13.1805 3.46093 13.1411L3.26193 15.1312ZM2.08323 14.8725C2.29705 14.9828 2.50683 15.0324 2.6868 15.0626C2.85693 15.0912 3.05831 15.1108 3.26193 15.1312L3.46094 13.1411C3.23089 13.1181 3.10701 13.1052 3.01798 13.0902C2.93878 13.0769 2.95549 13.0721 3 13.095L2.08323 14.8725ZM1.14009 13.8304C1.31803 14.2804 1.65311 14.6507 2.08323 14.8725L3 13.095H3L1.14009 13.8304ZM1 12.6318C1 12.8364 0.999483 13.0387 1.01098 13.2109C1.02314 13.393 1.05163 13.6066 1.14009 13.8304L3 13.095C3.01841 13.1416 3.01188 13.1577 3.00653 13.0776C3.00052 12.9875 3 12.863 3 12.6318H1ZM1 11.3683V12.6318H3V11.3683H1ZM1.14017 10.1694C1.05166 10.3932 1.02315 10.607 1.01098 10.7891C0.999483 10.9613 1 11.1637 1 11.3683H3C3 11.1371 3.00052 11.0125 3.00654 10.9224C3.01189 10.8423 3.01842 10.8584 3 10.905L1.14017 10.1694ZM2.08305 9.12757C1.65308 9.34939 1.3181 9.71954 1.14017 10.1694L3 10.905L3 10.905L2.08305 9.12757ZM3.26205 8.86881C3.05837 8.88917 2.85694 8.9088 2.68677 8.93737C2.50676 8.9676 2.29692 9.01724 2.08305 9.12757L3 10.905C2.95548 10.928 2.93877 10.9231 3.01798 10.9098C3.10704 10.8948 3.23094 10.8819 3.46105 10.8589L3.26205 8.86881ZM3.36155 8.86384H3.36155V10.8638H3.36155V8.86384ZM3.36156 8.86384H3.36155V10.8638H3.36156V8.86384ZM4.21177 8.77383C4.29471 8.71055 4.33141 8.73069 4.1363 8.7658C3.95075 8.7992 3.68939 8.82607 3.26205 8.86881L3.46106 10.8589C3.85482 10.8195 4.20927 10.7848 4.49056 10.7342C4.76231 10.6853 5.1169 10.5989 5.42506 10.3638L4.21177 8.77383ZM4.21177 8.77383L4.21178 8.77383L5.42506 10.3638C5.99613 9.92801 6.28962 9.21944 6.19396 8.50749L4.21177 8.77383ZM3.60732 8.03506C3.87929 8.36746 4.04511 8.5713 4.15272 8.72614C4.26586 8.88895 4.22567 8.87724 4.21177 8.77383L6.19396 8.50749C6.14234 8.1233 5.95263 7.81151 5.79506 7.58478C5.63195 7.35006 5.40584 7.07487 5.15523 6.76858L3.60732 8.03506ZM2.95652 7.01822C3.02973 7.24751 3.14303 7.43102 3.24896 7.5797C3.3491 7.72027 3.47768 7.8766 3.60732 8.03506L5.15523 6.76858C5.00876 6.58956 4.93026 6.49279 4.87785 6.41923C4.83123 6.35379 4.84651 6.36215 4.86175 6.40988L2.95652 7.01822ZM3.02651 5.61498C2.83424 6.05887 2.80938 6.5574 2.95652 7.01822L4.86175 6.40988L3.02651 5.61498ZM3.77523 4.66798C3.63047 4.81274 3.48698 4.9555 3.37335 5.08539C3.25316 5.2228 3.12217 5.39412 3.02651 5.61498L4.86175 6.40988C4.84184 6.45585 4.8258 6.46265 4.8787 6.40219C4.93816 6.33421 5.02589 6.24574 5.18944 6.0822L3.77523 4.66798ZM4.66855 3.77466L3.77523 4.66798L5.18944 6.0822L6.08276 5.18888L4.66855 3.77466ZM4.66855 3.77466L4.66855 3.77466L6.08276 5.18888L6.08276 5.18887L4.66855 3.77466ZM5.6152 3.02616C5.39443 3.12181 5.22317 3.25276 5.08582 3.37292C4.95597 3.48651 4.81325 3.62995 4.66855 3.77466L6.08276 5.18887C6.24625 5.02538 6.33469 4.93768 6.40264 4.87824C6.46309 4.82536 6.45629 4.84139 6.41034 4.8613L5.6152 3.02616ZM7.01892 2.95614C6.55795 2.80889 6.05923 2.83377 5.6152 3.02615L6.41033 4.8613H6.41034L7.01892 2.95614ZM8.03543 3.60681C7.87702 3.47719 7.72073 3.34865 7.58021 3.24853C7.43158 3.14264 7.24813 3.02936 7.01892 2.95614L6.41034 4.8613C6.36262 4.84606 6.35426 4.83078 6.41969 4.8774C6.49324 4.9298 6.58999 5.00829 6.76896 5.15472L8.03543 3.60681ZM8.77391 4.21101C8.87727 4.22493 8.88897 4.26509 8.72621 4.15198C8.57144 4.04441 8.36769 3.87865 8.03543 3.60681L6.76896 5.15472C7.07512 5.40521 7.35018 5.63122 7.58477 5.79427C7.81138 5.95176 8.123 6.14141 8.50697 6.19312L8.77391 4.21101ZM8.77391 4.21101L8.77391 4.21101L8.50697 6.19312C9.21932 6.28905 9.92836 5.99536 10.3642 5.42382L8.77391 4.21101ZM8.86883 3.2618C8.82612 3.6889 8.79926 3.95012 8.76589 4.13558C8.7308 4.33059 8.71068 4.29392 8.77391 4.21101L10.3642 5.42382C10.5992 5.11576 10.6854 4.76136 10.7343 4.48976C10.7849 4.20861 10.8196 3.85435 10.8589 3.46081L8.86883 3.2618ZM9.12739 2.08341C9.01716 2.29719 8.96756 2.50692 8.93736 2.68683C8.9088 2.85692 8.88919 3.05824 8.86883 3.2618L10.8589 3.46081C10.8819 3.23082 10.8948 3.10698 10.9098 3.01798C10.923 2.9388 10.9279 2.9555 10.905 3L9.12739 2.08341ZM10.1698 1.14002C9.71962 1.31796 9.34924 1.65315 9.12739 2.08341L10.905 3L10.905 3L10.1698 1.14002ZM11.3681 1C11.1635 1 10.9612 0.999483 10.7892 1.01097C10.6071 1.02313 10.3935 1.05161 10.1698 1.14002L10.905 3C10.8584 3.0184 10.8423 3.01188 10.9224 3.00653C11.0125 3.00052 11.137 3 11.3681 3V1ZM12.6318 1H11.3681V3H12.6318V1ZM13.8304 1.1401C13.6066 1.05163 13.393 1.02314 13.2109 1.01098C13.0387 0.999483 12.8364 1 12.6318 1V3C12.863 3 12.9875 3.00052 13.0776 3.00653C13.1577 3.01188 13.1416 3.01841 13.095 3L13.8304 1.1401ZM14.8725 2.08322C14.6507 1.65312 14.2804 1.31803 13.8304 1.1401L13.095 3L13.095 3L14.8725 2.08322ZM15 12C15 13.6569 13.6569 15 12 15V17C14.7614 17 17 14.7614 17 12H15ZM12 9C13.6569 9 15 10.3431 15 12H17C17 9.23858 14.7614 7 12 7V9ZM9 12C9 10.3431 10.3431 9 12 9V7C9.23858 7 7 9.23858 7 12H9ZM12 15C10.3431 15 9 13.6569 9 12H7C7 14.7614 9.23858 17 12 17V15Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
            </nav>
            <PanelRail
                :style-width="middlePaneStyle"
                :mode="panelMode"
                :projects="projects"
                :selected-project-id="selectedProjectId"
                :on-select-project="handleSelectProject"
                :on-delete-project="deleteProject"
                :is-tree-collapsed="isTreeCollapsed"
                :is-report-tree-collapsed="isReportTreeCollapsed"
                :show-content="isProjectToolActive || isReportToolActive || isPreviewToolActive"
                :tree="tree"
                :active-tree-path="activeTreePath"
                :is-loading-tree="isLoadingTree"
                :open-node="openNode"
                :select-tree-node="selectTreeNode"
                :report-config="reportPanelConfig"
                :toggle-report-tree="toggleReportTreeCollapsed"
                @resize-start="startPreviewResize"
            >
                <template v-if="isPreviewToolActive" #default>
                    <ProjectPreviewPanel
                        :previews="projectPreviewEntries"
                        :loading="isProjectPreviewLoading"
                        :compact="true"
                        @select-issue="handlePreviewIssueSelect"
                    />
                </template>
            </PanelRail>

            <section
                class="workSpace"
                :class="{ 'workSpace--reports': isReportToolActive, 'workSpace--settings': isSettingsToolActive }"
            >
                <template v-if="isSettingsToolActive">
                    <SettingsPanel @save="handleSettingsSave" />
                </template>
                <template v-else-if="isReportToolActive">
                    <div class="panelHeader">報告檢視</div>
                    <template v-if="hasReadyReports || viewerHasContent">
                        <div
                            class="reportViewerContent"
                            :class="{ 'reportViewerContent--loading': isActiveReportProcessing }"
                            ref="reportViewerContentRef"
                            :aria-busy="isActiveReportProcessing ? 'true' : 'false'"
                        >
                            <div
                                v-if="isActiveReportProcessing"
                                class="reportViewerProcessingOverlay reportViewerLoading"
                                role="status"
                                aria-live="polite"
                            >
                                <span class="reportViewerSpinner" aria-hidden="true"></span>
                                <p class="reportViewerProcessingText">正在透過 Dify 執行 AI審查，請稍候…</p>
                            </div>
                            <template v-if="activeReport">
                                <div class="reportViewerHeader">
                                    <h3 class="reportTitle">{{ activeReport.project.name }} / {{ activeReport.path }}</h3>
                                    <p class="reportViewerTimestamp">更新於 {{ activeReport.state.updatedAtDisplay || '-' }}</p>
                                </div>
                                <div v-if="activeReport.state.status === 'error'" class="reportErrorPanel">
                                    <p class="reportErrorText">生成失敗：{{ activeReport.state.error || '未知原因' }}</p>
                                    <p class="reportErrorHint">請檢查檔案權限、Dify 設定或稍後再試。</p>
                                </div>
                                <template v-else>
                                    <div v-if="hasStructuredReport" class="reportStructured">
                                        <div
                                            v-if="hasStructuredReportToggle"
                                            class="reportStructuredToggle"
                                            role="group"
                                            aria-label="報告來源"
                                        >
                                            <div class="reportStructuredToggleButtons">
                                                <button
                                                    type="button"
                                                    class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'combined' }"
                                                    :disabled="!canShowStructuredSummary"
                                                    @click="setStructuredReportViewMode('combined')"
                                                >
                                                    總報告
                                                </button>
                                                <button
                                                    type="button"
                                                    class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'static' }"
                                                    :disabled="!canShowStructuredStatic"
                                                    @click="setStructuredReportViewMode('static')"
                                                >
                                                    靜態分析器
                                                </button>
                                                <button
                                                    type="button"
                                                    class="reportStructuredToggleButton"
                                                    :class="{ active: structuredReportViewMode === 'dml' }"
                                                    :disabled="!canShowStructuredDml"
                                                    @click="setStructuredReportViewMode('dml')"
                                                >
                                                    AI審查
                                                </button>
                                            </div>
                                            <button
                                                v-if="shouldShowStructuredExportButton"
                                                type="button"
                                                class="reportExportButton reportStructuredToggleExport"
                                                :disabled="structuredReportExportConfig.busy"
                                                :aria-busy="structuredReportExportConfig.busy ? 'true' : 'false'"
                                                @click="exportCurrentStructuredReportJson"
                                            >
                                                <span v-if="structuredReportExportConfig.busy">匯出中…</span>
                                                <span v-else>{{ structuredReportExportLabel }}</span>
                                            </button>
                                        </div>
                                        <section
                                            v-if="structuredReportViewMode === 'combined' && canShowStructuredSummary"
                                            class="reportSummaryGrid"
                                        >
                                            <div class="reportSummaryCard reportSummaryCard--total">
                                                <span class="reportSummaryLabel">問題</span>
                                                <span class="reportSummaryValue">{{ activeReportTotalIssuesDisplay }}</span>
                                            </div>
                                            <div
                                                v-if="activeReportSummaryText"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">{{ activeReportSummaryText }}</p>
                                            </div>
                                            <div
                                                v-else-if="shouldShowNoIssueSummary"
                                                class="reportSummaryCard reportSummaryCard--span"
                                            >
                                                <span class="reportSummaryLabel">摘要</span>
                                                <p class="reportSummaryText">未檢測到問題。</p>
                                            </div>
                                            <div
                                                v-if="ruleBreakdownItems.length"
                                                class="reportSummaryCard"
                                            >
                                                <span class="reportSummaryLabel">規則分佈</span>
                                                <ul class="reportSummaryList">
                                                    <li
                                                        v-for="item in ruleBreakdownItems"
                                                        :key="`${item.label}-${item.count}`"
                                                    >
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div
                                                v-if="severityBreakdownItems.length"
                                                class="reportSummaryCard"
                                            >
                                                <span class="reportSummaryLabel">嚴重度</span>
                                                <ul class="reportSummaryList">
                                                    <li
                                                        v-for="item in severityBreakdownItems"
                                                        :key="`${item.label}-${item.count}`"
                                                    >
                                                        <span class="reportSummaryItemLabel">{{ item.label }}</span>
                                                        <span class="reportSummaryItemValue">{{ item.count }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                        </section>

                                        <section
                                            v-if="structuredReportViewMode === 'static' && hasStaticDetailContent"
                                            class="reportStaticSection"
                                        >
                                            <div class="reportStaticHeader">
                                                <h4>靜態分析器</h4>
                                                <span v-if="staticEngineName" class="reportStaticEngine">
                                                    引擎：{{ staticEngineName }}
                                                </span>
                                                <span v-else-if="staticSourceName" class="reportStaticEngine">
                                                    來源：{{ staticSourceName }}
                                                </span>
                                            </div>
                                            <div
                                                v-if="staticSummaryDetailsItems.length"
                                                class="reportStaticBlock"
                                            >
                                                <h5>摘要資訊</h5>
                                                <ul class="reportStaticList">
                                                    <li
                                                        v-for="item in staticSummaryDetailsItems"
                                                        :key="`static-summary-${item.label}-${item.value}`"
                                                    >
                                                        <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                        <span class="reportStaticItemValue">{{ item.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                            <div
                                                v-if="staticMetadataDetailsItems.length"
                                                class="reportStaticBlock"
                                            >
                                                <h5>中繼資料</h5>
                                                <ul class="reportStaticList">
                                                    <li
                                                        v-for="item in staticMetadataDetailsItems"
                                                        :key="`static-metadata-${item.label}-${item.value}`"
                                                    >
                                                        <span class="reportStaticItemLabel">{{ item.label }}</span>
                                                        <span class="reportStaticItemValue">{{ item.value }}</span>
                                                    </li>
                                                </ul>
                                            </div>
                                        </section>

                                        <section
                                            v-if="structuredReportViewMode === 'dml' && dmlReportDetails"
                                            class="reportDmlSection"
                                        >
                                            <details
                                                class="reportDmlDetails"
                                                :open="isDmlReportExpanded"
                                                @toggle="handleToggleDmlSection"
                                            >
                                                <summary class="reportDmlSummaryToggle">
                                                    <div class="reportDmlHeader">
                                                        <h4>區塊拆分</h4>
                                                        <span
                                                            v-if="dmlReportDetails.status"
                                                            class="reportDmlStatus"
                                                        >
                                                            {{ dmlReportDetails.status }}
                                                        </span>
                                                        <span
                                                            v-if="dmlReportDetails.generatedAt"
                                                            class="reportDmlTimestamp"
                                                        >
                                                            產生於 {{ dmlReportDetails.generatedAt }}
                                                        </span>
                                                    </div>
                                                </summary>
                                                <div class="reportDmlContent">
                                                    <p v-if="dmlReportDetails.error" class="reportDmlError">
                                                        {{ dmlReportDetails.error }}
                                                    </p>
                                                    <div v-if="hasDmlSegments" class="reportDmlSegments">
                                                        <details
                                                            v-for="segment in dmlSegments"
                                                            :key="segment.key"
                                                            class="reportDmlSegment"
                                                        >
                                                            <summary>
                                                                第 {{ segment.index }} 段
                                                                <span v-if="segment.startLine">
                                                                    （第 {{ segment.startLine }} 行起
                                                                    <span v-if="segment.endLine"
                                                                        >，至第 {{ segment.endLine }} 行止</span
                                                                    >
                                                                    ）
                                                                </span>
                                                            </summary>
                                                            <pre
                                                                v-if="segment.text || segment.sql"
                                                                class="reportDmlSql codeScroll themed-scrollbar"
                                                                v-text="segment.text || segment.sql"
                                                            ></pre>
                                                            <pre
                                                                v-if="segment.analysis"
                                                                class="reportDmlAnalysis codeScroll themed-scrollbar"
                                                                v-text="segment.analysis"
                                                            ></pre>
                                                        </details>
                                                    </div>
                                                    <p v-else class="reportDmlEmpty">尚未取得 AI審查拆分結果。</p>
                                                    <pre
                                                        v-if="dmlReportDetails.reportText"
                                                        class="reportDmlSummary codeScroll themed-scrollbar"
                                                        v-text="dmlReportDetails.reportText"
                                                    ></pre>
                                                </div>
                                            </details>
                                        </section>
                                        <section
                                            v-if="structuredReportJsonPreview"
                                            class="reportJsonPreviewSection"
                                        >
                                            <details class="reportJsonPreviewDetails">
                                                <summary class="reportJsonPreviewSummary">
                                                    {{ structuredReportJsonHeading }}
                                                </summary>
                                                <pre
                                                    class="reportJsonPreview codeScroll themed-scrollbar"
                                                    v-text="structuredReportJsonPreview"
                                                ></pre>
                                            </details>
                                        </section>
                                        <section
                                            v-if="shouldShowReportIssuesSection"
                                            class="reportIssuesSection"
                                        >
                                            <div class="reportIssuesHeader">
                                                <div class="reportIssuesHeaderInfo">
                                                    <h4>問題清單</h4>
                                                    <span class="reportIssuesTotal">
                                                        <template v-if="activeReportIssueCount !== null">
                                                            共 {{ activeReportIssueCount }} 項
                                                        </template>
                                                        <template v-else>—</template>
                                                    </span>
                                                </div>
                                            </div>
                                            <div class="reportIssuesContent" ref="reportIssuesContentRef">
                                                <template v-if="activeReportDetails">
                                                    <div
                                                        v-if="activeReport.state.sourceLoading"
                                                        class="reportIssuesNotice"
                                                    >
                                                        正在載入原始碼…
                                                    </div>
                                                    <div
                                                        v-else-if="activeReport.state.sourceError"
                                                        class="reportIssuesNotice reportIssuesNotice--error"
                                                    >
                                                        無法載入檔案內容：{{ activeReport.state.sourceError }}
                                                    </div>
                                                    <template v-else>
                                                        <div
                                                            v-if="shouldShowAiUnavailableNotice"
                                                            class="reportIssuesNotice reportIssuesNotice--warning"
                                                        >
                                                            {{ reportAiUnavailableNotice }}
                                                        </div>
                                                        <div
                                                            v-if="hasReportIssueLines"
                                                            class="reportRow reportIssuesRow"
                                                        >
                                                            <div class="reportRowContent codeScroll themed-scrollbar">
                                                                <div class="codeEditor">
                                                                    <div
                                                                        v-for="line in reportIssueLines"
                                                                        :key="line.key"
                                                                        class="codeLine"
                                                                        :data-line="line.number != null ? line.number : undefined"
                                                                        :class="{
                                                                            'codeLine--issue': line.type === 'code' && line.hasIssue,
                                                                            'codeLine--meta': line.type !== 'code',
                                                                            'codeLine--issuesMeta': line.type === 'issues',
                                                                            'codeLine--fixMeta': line.type === 'fix'
                                                                        }"
                                                                    >
                                                                        <span
                                                                            class="codeLineNo"
                                                                            :class="{
                                                                                'codeLineNo--issue': line.type === 'code' && line.hasIssue,
                                                                                'codeLineNo--meta': line.type !== 'code',
                                                                                'codeLineNo--issues': line.type === 'issues',
                                                                                'codeLineNo--fix': line.type === 'fix'
                                                                            }"
                                                                            :data-line="line.number != null ? line.displayNumber : ''"
                                                                            :aria-label="line.type !== 'code' ? line.iconLabel : null"
                                                                            :aria-hidden="line.type === 'code'"
                                                                        >
                                                                            <svg
                                                                                v-if="line.type === 'issues'"
                                                                                class="codeLineNoIcon codeLineNoIcon--warning"
                                                                                viewBox="0 0 20 20"
                                                                                focusable="false"
                                                                                aria-hidden="true"
                                                                            >
                                                                                <path
                                                                                    d="M10.447 2.105a1 1 0 00-1.894 0l-7 14A1 1 0 002.447 18h15.106a1 1 0 00.894-1.447l-7-14zM10 6a1 1 0 01.993.883L11 7v4a1 1 0 01-1.993.117L9 11V7a1 1 0 011-1zm0 8a1 1 0 110 2 1 1 0 010-2z"
                                                                                />
                                                                            </svg>
                                                                            <svg
                                                                                v-else-if="line.type === 'fix'"
                                                                                class="codeLineNoIcon codeLineNoIcon--fix"
                                                                                viewBox="0 0 20 20"
                                                                                focusable="false"
                                                                                aria-hidden="true"
                                                                            >
                                                                                <path
                                                                                    d="M17.898 2.102a1 1 0 00-1.517.127l-2.156 2.873-1.21-.403a1 1 0 00-1.043.24l-4.95 4.95a1 1 0 000 1.414l1.775 1.775-5.189 5.189a1 1 0 001.414 1.414l5.189-5.189 1.775 1.775a1 1 0 001.414 0l4.95-4.95a1 1 0 00.24-1.043l-.403-1.21 2.873-2.156a1 1 0 00.127-1.517l-.489-.489z"
                                                                                />
                                                                            </svg>
                                                                        </span>
                                                                        <span
                                                                            class="codeLineContent"
                                                                            :class="{
                                                                                'codeLineContent--issueHighlight': line.type === 'code' && line.hasIssue,
                                                                                'codeLineContent--issues': line.type === 'issues',
                                                                                'codeLineContent--fix': line.type === 'fix'
                                                                            }"
                                                                            v-html="line.html"
                                                                        ></span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                                    </template>
                                                </template>
                                                <p v-else class="reportIssuesEmpty">尚未能載入完整的代碼內容。</p>
                                            </div>
                                            </section>
                                        <section
                                            v-else
                                            class="reportIssuesSection reportIssuesSection--empty"
                                        >
                                            <p class="reportIssuesEmpty">未檢測到任何問題。</p>
                                        </section>

                                    </div>
                                    <pre v-else class="reportBody codeScroll themed-scrollbar">{{ activeReport.state.report }}</pre>
                                    <details v-if="shouldShowDmlChunkDetails" class="reportChunks">
                                        <summary>AI 審查段落（{{ dmlChunkDetails.length }}）</summary>
                                        <ol class="reportChunkList reportChunkList--issues">
                                            <li
                                                v-for="chunk in dmlChunkDetails"
                                                :key="`chunk-${chunk.index}-${chunk.total}`"
                                            >
                                                <h4 class="reportChunkTitle">第 {{ chunk.index }} 段</h4>
                                                <template v-if="chunk.issues.length">
                                                    <ul class="reportChunkIssues">
                                                        <li
                                                            v-for="(issue, issueIndex) in chunk.issues"
                                                            :key="`chunk-${chunk.index}-issue-${issueIndex}`"
                                                            class="reportChunkIssue"
                                                        >
                                                            <p class="reportChunkIssueMessage">{{ issue.message }}</p>
                                                            <p v-if="issue.rule" class="reportChunkIssueMeta">規則：{{ issue.rule }}</p>
                                                            <p v-if="issue.severity" class="reportChunkIssueMeta">
                                                                嚴重度：{{ issue.severity }}
                                                            </p>
                                                            <p
                                                                v-if="describeIssueLineRange(issue)"
                                                                class="reportChunkIssueMeta"
                                                            >
                                                                行數：第 {{ describeIssueLineRange(issue) }} 行
                                                            </p>
                                                            <p v-if="issue.context" class="reportChunkIssueContext">
                                                                {{ issue.context }}
                                                            </p>
                                                        </li>
                                                    </ul>
                                                </template>
                                                <p v-else class="reportChunkEmpty">未檢測到任何問題。</p>
                                            </li>
                                        </ol>
                                    </details>
                                </template>
                            </template>
                            <template v-else>
                                <div class="reportViewerPlaceholder">請從左側選擇檔案報告。</div>
                            </template>
                        </div>
                    </template>
            <p v-else class="reportViewerPlaceholder">尚未生成任何報告，請先於左側檔案中啟動生成。</p>
        </template>
        <template v-else-if="isPreviewToolActive">
            <ProjectPreviewPanel
                :previews="projectPreviewEntries"
                :loading="isProjectPreviewLoading"
                :show-summary="true"
                @select-issue="handlePreviewIssueSelect"
                    />
                </template>
                <template v-else-if="previewing.kind && previewing.kind !== 'error'">
                    <div class="pvHeader">
                        <div class="pvName">{{ previewing.name }}</div>
                        <div class="pvMeta">{{ previewing.mime || '-' }} | {{ (previewing.size / 1024).toFixed(1) }} KB</div>
                    </div>

                    <template v-if="previewing.kind === 'text'">
                        <div class="pvBox codeBox">
                            <div
                                class="codeScroll themed-scrollbar"
                                :class="{ 'codeScroll--wrapped': !showCodeLineNumbers }"
                                ref="codeScrollRef"
                                @pointerdown="handleCodeScrollPointerDown"
                            >
                                <div class="codeEditor">
                                    <div
                                        v-for="line in previewLineItems"
                                        :key="line.number"
                                        class="codeLine"
                                        :data-line="line.number"
                                    >
                                        <span
                                            class="codeLineNo"
                                            :data-line="line.number"
                                            aria-hidden="true"
                                        ></span>
                                        <span class="codeLineContent" v-html="renderLineContent(line)"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </template>

                    <div v-else-if="previewing.kind === 'image'" class="pvBox imgBox">
                        <img :src="previewing.url" :alt="previewing.name" />
                    </div>

                    <div v-else-if="previewing.kind === 'pdf'" class="pvBox pdfBox">
                        <iframe :src="previewing.url" title="PDF Preview" style="width:100%;height:100%;border:none;"></iframe>
                    </div>

                    <div v-else class="pvBox">
                        <a class="btn" :href="previewing.url" download>Download file</a>
                        <a class="btn outline" :href="previewing.url" target="_blank">Open in new window</a>
                    </div>
                </template>

                <template v-else-if="previewing.kind === 'error'">
                    <div class="pvError">
                        Cannot preview: {{ previewing.error }}
                    </div>
                </template>

                <template v-else>
                    <div class="pvPlaceholder">請選擇檔案以在此預覽。</div>
                </template>
            </section>
        </div>

        <Teleport to="body">
            <ChatAiWindow
                :visible="isChatWindowOpen"
                :floating-style="chatWindowStyle"
                :context-items="contextItems"
                :messages="messages"
                :loading="isProcessing"
                :disabled="isChatLocked"
                :connection="connection"
                @add-active="handleAddActiveContext"
                @add-selection="handleAddSelectionContext"
                @clear-context="clearContext"
                @remove-context="removeContext"
                @send-message="handleSendMessage"
                @close="closeChatWindow"
                @drag-start="startChatDrag"
                @resize-start="startChatResize"
            />
        </Teleport>

        <div v-if="showUploadModal" class="modalBackdrop" @click.self="showUploadModal = false">
            <div class="modalCard">
                <h3>Import Project Folder</h3>
                <p>Drag a folder here or use the buttons below to import a project. External directories and OPFS are supported.</p>

                <div class="dropZone" @drop="handleDrop" @dragover="handleDragOver">Drop a folder here to import</div>

                <div class="modalBtns">
                    <button class="btn" v-if="supportsFS" @click="pickFolderAndImport">Select folder</button>
                    <label class="btn outline" v-else>Fallback import<input type="file" webkitdirectory directory multiple style="display:none" @change="handleFolderInput"></label>
                    <button class="btn ghost" @click="showUploadModal = false">Cancel</button>
                </div>
                <p class="hint" v-if="!supportsFS">Your browser does not support showDirectoryPicker. Use the fallback input instead.</p>
            </div>
        </div>
    </div>
</template>
<style>
/* 讓 100% 有依據 */
html,
body,
#app {
    height: 100%;
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #e5e7eb;
}

.page {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background-color: #1e1e1e;
    overflow: hidden;
}

/* 頂欄 */
.topBar {
    box-sizing: border-box;
    height: 60px;
    padding: 0 16px;
    background: linear-gradient(90deg, #2c2c2c, #252526);
    border-bottom: 1px solid #3d3d3d;
    display: flex;
    align-items: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}

.topBar_left {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_title {
    margin: 0;
    padding: 0;
    font-size: 0;
    line-height: 1;
}

.topBar_logo {
    display: block;
    height: 36px;
    width: auto;
    object-fit: contain;
}

.topBar_spacer {
    flex: 1 1 auto;
}

.topBar_right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.topBar_iconBtn {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid #3d3d3d;
    background: #2b2b2b;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.topBar_iconBtn svg {
    width: 20px;
    height: 20px;
}

.topBar_iconBtn:hover:not(:disabled) {
    background: #343434;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.topBar_iconBtn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(14, 165, 233, 0.3));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.topBar_addProject {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-radius: 6px;
    background-color: #007acc;
    transition: all 0.25s ease;
}

.topBar_addProject p {
    margin: 0;
    color: white;
    font-weight: 600;
    font-size: 15px;
}

.topBar_addProject svg {
    height: 20px;
    fill: white;
    transition: transform 0.25s ease, fill 0.25s ease;
}

.topBar_addProject:hover {
    background-color: #0288d1;
    transform: translateY(-2px) scale(1.03);
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.topBar_addProject:active {
    transform: scale(0.96);
}


.mainContent {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    flex: 1 1 auto;
    min-height: 0;
    background-color: #1e1e1e;
    padding: 0;
    width: 100%;
    box-sizing: border-box;
    column-gap: 0;
    row-gap: 0;
    height: calc(100vh - 60px);
    max-height: calc(100vh - 60px);
    overflow: hidden;
}

.workSpace {
    flex: 1 1 480px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    min-width: 0;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    height: 100%;
    max-height: 100%;
    overflow-y: auto;
}

.workSpace--reports {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
}

.workSpace--settings {
    gap: 12px;
}

.toolColumn {
    flex: 0 0 64px;
    width: 64px;
    background: #252526;
    border-right: 1px solid #323232;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px 10px;
    box-sizing: border-box;
    max-height: 100%;
    overflow-y: auto;
    scrollbar-width: none;
}

.toolColumn::-webkit-scrollbar {
    display: none;
}

.toolColumn_btn {
    width: 44px;
    height: 44px;
    border: 1px solid #3d3d3d;
    background: #262626;
    color: #cbd5f5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
    padding: 0;
}

.toolColumn_btn svg {
    width: 33px;
    height: 33px;
}

.toolColumn_btn--settings {
    background: #1f2937;
}

.toolColumn_btn--chat {
    margin-top: auto;
}

.toolColumn_btn:hover {
    background: #2f2f2f;
    border-color: #4b5563;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(14, 165, 233, 0.6);
    color: #e0f2fe;
}

.toolColumn_btn:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.mainContent > * {
    min-height: 0;
    min-width: 0;
}

@media (max-width: 900px) {
    .mainContent {
        flex-direction: column;
    }
    .toolColumn {
        flex-direction: row;
        width: 100%;
        flex: 0 0 auto;
        border-right: none;
        border-bottom: 1px solid #323232;
        justify-content: flex-start;
    }
    .toolColumn_btn {
        transform: none;
    }
    .toolColumn_btn--chat {
        margin-top: 0;
        margin-left: auto;
    }
    .workSpace {
        width: 100%;
        flex: 1 1 auto;
    }
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.reportViewerContent {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    background: #191919;
    border: 1px solid #323232;
    border-radius: 0;
    padding: 16px;
    box-sizing: border-box;
    min-width: 0;
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
}

.reportViewerContent--loading > :not(.reportViewerProcessingOverlay) {
    filter: blur(1px);
    pointer-events: none;
}

.reportViewerProcessingOverlay {
    position: absolute;
    inset: 0;
    background: rgba(15, 23, 42, 0.78);
    backdrop-filter: blur(2px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 32px 16px;
    z-index: 10;
    pointer-events: all;
}

.reportViewerProcessingOverlay .reportViewerSpinner {
    width: 48px;
    height: 48px;
}

.reportViewerProcessingText {
    margin: 0;
    font-size: 14px;
    color: #cbd5f5;
}

.reportViewerLoading {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 40px 16px;
    text-align: center;
    color: #e2e8f0;
}

.reportViewerSpinner {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid rgba(148, 163, 184, 0.35);
    border-top-color: #60a5fa;
    animation: reportViewerSpin 1s linear infinite;
}

.reportViewerLoadingText {
    margin: 0;
    font-size: 14px;
    color: #cbd5f5;
}

@keyframes reportViewerSpin {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}

.reportViewerHeader {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reportTitle {
    margin: 0;
    font-size: 18px;
    color: #f9fafb;
}

.reportViewerTimestamp {
    margin: 0;
    font-size: 12px;
    color: #a5b4fc;
}

.reportBody {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    background: #1b1b1b;
    border: 1px solid #2f2f2f;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportStructured {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1 1 auto;
    min-height: 0;
}

.reportStructured > * {
    align-self: stretch;
}

.reportStructuredPrimary {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 0;
}

.reportStructuredSecondary {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 0;
}

.reportStructuredToggle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    justify-content: space-between;
}

.reportStructuredToggleButtons {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reportStructuredToggleButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportStructuredToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.28), rgba(14, 165, 233, 0.28));
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportStructuredToggleButton:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.reportStructuredToggleExport {
    margin-left: auto;
}

.reportJsonPreviewSection {
    margin-top: 12px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    flex: 0 0 auto;
    min-height: auto;
}

.reportJsonPreviewDetails {
    border: 1px solid #334155;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.65);
    overflow: hidden;
    max-width: 100%;
}

.reportJsonPreviewSummary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #bfdbfe;
    list-style: none;
    cursor: pointer;
}

.reportJsonPreviewSummary::-webkit-details-marker {
    display: none;
}

.reportJsonPreviewDetails[open] .reportJsonPreviewSummary {
    border-bottom: 1px solid rgba(59, 130, 246, 0.35);
}

.reportJsonPreviewDetails:not([open]) .reportJsonPreviewSummary::after,
.reportJsonPreviewDetails[open] .reportJsonPreviewSummary::after {
    content: "";
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
    border-left: 0;
    border-top: 0;
    transform: rotate(45deg);
    margin-left: auto;
    transition: transform 0.2s ease;
}

.reportJsonPreviewDetails[open] .reportJsonPreviewSummary::after {
    transform: rotate(225deg);
}

.reportJsonPreview {
    margin: 0;
    padding: 12px;
    border-top: 1px solid rgba(59, 130, 246, 0.35);
    background: rgba(15, 23, 42, 0.45);
    color: #e2e8f0;
    font-size: 12px;
    max-width: 100%;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportExportButton {
    border: 1px solid #3d3d3d;
    background: #1f2937;
    color: #cbd5f5;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.reportExportButton:hover:not(:disabled) {
    background: #374151;
    border-color: #60a5fa;
    color: #e0f2fe;
    transform: translateY(-1px);
}

.reportExportButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.reportExportButton:focus-visible {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
}

.reportSummaryGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    width: 100%;
    flex: 0 0 auto;
    min-height: auto;
}

.reportSummaryCard {
    border: 1px solid #2f2f2f;
    background: #1f1f1f;
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    word-break: break-word;
}

.reportSummaryCard--total {
    background: #1f1f1f;
    border-color: #2f2f2f;
}

.reportSummaryCard--span {
    grid-column: 1 / -1;
}

@media (max-width: 720px) {
    .reportSummaryCard--span {
        grid-column: span 1;
    }
}

.reportSummaryLabel {
    font-size: 12px;
    font-weight: 600;
    color: #cbd5f5;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.reportSummaryValue {
    font-size: 28px;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1;
}

.reportSummaryText {
    margin: 0;
    font-size: 13px;
    color: #e2e8f0;
    line-height: 1.5;
}

.reportSummaryList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportSummaryItemLabel {
    font-weight: 600;
    margin-right: 6px;
}

.reportSummaryItemValue {
    color: #cbd5f5;
}

.reportStaticSection {
    margin-top: 24px;
    padding: 16px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    background: rgba(30, 41, 59, 0.32);
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportStaticHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}

.reportStaticHeader h4 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #f8fafc;
}

.reportStaticEngine {
    font-size: 12px;
    color: #94a3b8;
}

.reportStaticBlock {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.reportStaticBlock h5 {
    margin: 0;
    font-size: 13px;
    color: #cbd5f5;
    text-transform: none;
    letter-spacing: 0.02em;
}

.reportStaticList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: #e2e8f0;
}

.reportStaticItemLabel {
    font-weight: 600;
    margin-right: 6px;
    color: #cbd5f5;
}

.reportStaticItemValue {
    color: #cbd5f5;
}


.reportDmlSection {
    margin-top: 24px;
}

.reportDmlDetails {
    border: 1px solid #334155;
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.65);
    color: #e2e8f0;
    overflow: hidden;
}

.reportDmlSummaryToggle {
    display: flex;
    align-items: center;
    cursor: pointer;
    gap: 6px;
    list-style: none;
    margin: 0;
    padding: 10px 12px;
    box-sizing: border-box;
    transition: background 0.2s ease, color 0.2s ease;
    color: #bfdbfe;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    background: transparent;
}

.reportDmlSummaryToggle::-webkit-details-marker {
    display: none;
}

.reportDmlSummaryToggle::after {
    content: "";
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
    border-left: 0;
    border-top: 0;
    transform: rotate(45deg);
    margin-left: auto;
    transition: transform 0.2s ease;
}

.reportDmlDetails[open] .reportDmlSummaryToggle::after {
    transform: rotate(225deg);
}

.reportDmlDetails:not([open]) .reportDmlSummaryToggle:hover {
    color: #e2e8f0;
}

.reportDmlDetails[open] .reportDmlSummaryToggle:hover {
    background: rgba(148, 163, 184, 0.18);
}

.reportDmlDetails[open] .reportDmlSummaryToggle {
    border-bottom: 1px solid rgba(59, 130, 246, 0.35);
    border-radius: 6px 6px 0 0;
}

.reportDmlContent {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
}

.reportDmlHeader {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.reportDmlHeader h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: inherit;
}

.reportDmlStatus {
    font-size: 12px;
    font-weight: 600;
    color: #22d3ee;
    text-transform: uppercase;
}

.reportDmlTimestamp {
    font-size: 12px;
    color: #94a3b8;
}

.reportDmlError {
    margin: 0;
    color: #f87171;
    font-size: 13px;
}

.reportDmlSegments {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportDmlSegment {
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 6px;
    background: rgba(15, 23, 42, 0.35);
}

.reportDmlSegment summary {
    cursor: pointer;
    padding: 8px 12px;
    font-weight: 600;
    color: #e2e8f0;
}

.reportDmlSegment pre {
    margin: 0;
    padding: 12px;
    font-size: 13px;
}

.reportDmlSql {
    background: rgba(15, 23, 42, 0.55);
    color: #e0f2fe;
}

.reportDmlAnalysis {
    background: rgba(8, 47, 73, 0.55);
    color: #fef9c3;
}

.reportDmlSummary {
    margin: 0;
    font-size: 13px;
    background: rgba(15, 23, 42, 0.65);
    color: #cbd5f5;
    border-radius: 6px;
    padding: 12px;
}

.reportDmlEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}


.reportIssuesSection {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1 1 auto;
    min-height: 0;
    align-self: stretch;
}

.reportIssuesSection--empty {
    padding-top: 12px;
    flex: 0 0 auto;
}


.reportIssuesHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.reportIssuesHeaderInfo {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.reportIssuesContent {
    flex: 0 0 auto;
    min-height: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid rgba(148, 163, 184, 0.28);
    border-radius: 8px;
    padding: 12px 12px 0;
    background: rgba(15, 23, 42, 0.02);
    overflow: auto;
}

.reportIssuesHeader h4 {
    margin: 0;
    font-size: 16px;
    color: #0b1120;
}

.reportIssuesTotal {
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesNotice {
    padding: 10px 14px;
    border-radius: 6px;
    background: rgba(148, 163, 184, 0.12);
    color: #e2e8f0;
    font-size: 13px;
}

.reportIssuesNotice--error {
    background: rgba(248, 113, 113, 0.12);
    color: #fda4af;
}

.reportIssuesNotice--warning {
    background: rgba(250, 204, 21, 0.12);
    color: #facc15;
}

.reportRow {
    flex: 0 0 auto;
    min-height: auto;
    border-radius: 6px;
    background: #1b1b1b;
    display: flex;
    flex-direction: column;
    overflow: visible;
}

.reportRowActions {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px 0;
    gap: 8px;
}

.reportRowActionButton {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    background: rgba(148, 163, 184, 0.14);
    color: #e2e8f0;
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.reportRowActionButton:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
    border-color: rgba(59, 130, 246, 0.5);
    color: #f8fafc;
}

.reportRowActionButton:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.reportRowContent {
    flex: 1 1 auto;
    margin: 0;
    padding: 16px;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #e2e8f0;
    background: transparent;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 0;
}

.reportRowContent.codeScroll {
    overflow: visible;
    max-height: none;
}

.reportRowNotice {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 12px;
    color: #94a3b8;
}

.reportIssuesRow .reportRowContent {
    padding: 0;
}

.reportIssuesRow .reportRowContent.codeScroll {
    display: flex;
    flex-direction: column;
    overflow: auto;
    max-height: none;
}

.reportIssuesRow .codeEditor {
    padding: 4px 0 0;
}

.reportIssuesRow .codeLine {
    border-left: 3px solid transparent;
    padding: 2px 0;
}

.reportIssuesRow .codeLine--issue {
    background: rgba(248, 113, 113, 0.12);
    border-left-color: rgba(248, 113, 113, 0.65);
    padding-top: 0;
    padding-bottom: 0;
}

.codeLineNo--issue {
    color: #b91c1c;
}

.codeLineContent--issueHighlight {
    color: #7f1d1d;
    background: rgba(248, 113, 113, 0.18);
}

.reportIssuesRow .codeLine--meta {
    background: rgba(226, 232, 240, 0.75);
    border-left-color: rgba(148, 163, 184, 0.6);
}

.reportIssuesRow .codeLine--issuesMeta {
    background: rgba(251, 146, 60, 0.24);
    border-left-color: rgba(251, 146, 60, 0.6);
}

.reportIssuesRow .codeLine--fixMeta {
    background: rgba(56, 189, 248, 0.2);
    border-left-color: rgba(56, 189, 248, 0.55);
}

.codeLineNo--meta {
    color: #1f2937;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-right: 0;
}

.codeLineNo--meta::before {
    content: "";
}

.codeLineNo--issues {
    color: #c2410c;
}

.codeLineNo--fix {
    color: #0284c7;
}

.codeLineNoIcon {
    width: 16px;
    height: 16px;
    fill: currentColor;
    display: block;
}

.codeLineNoIcon--warning {
    color: inherit;
}

.codeLineContent--issues,
.codeLineContent--fix {
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
}

.codeLineContent--issues {
    color: #9a3412;
}

.codeLineContent--fix {
    color: #0369a1;
}

.reportIssueInlineRow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
    margin: 0 0 6px;
    color: #1e3a8a;
}

.reportIssueInlineRow:last-child {
    margin-bottom: 0;
}

.reportIssueInlineRow--empty {
    color: #475569;
    font-style: italic;
}

.reportIssueInlineRecommendationList {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding-left: 0;
    margin: 0 0 8px;
    list-style: none;
}

.reportIssueInlineRecommendation {
    background: #e0f2fe;
    border-radius: 8px;
    padding: 8px 10px;
}

.reportIssueInlineList {
    padding-left: 18px;
    margin: 4px 0 0;
    color: inherit;
}

.reportIssueInlineList li {
    margin: 2px 0;
}

.reportIssueInlineTupleList {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding-left: 0;
    margin: 4px 0 0;
    list-style: none;
}

.reportIssueInlineTuple {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.6);
    color: #0f172a;
    border: 1px solid rgba(148, 163, 184, 0.35);
}

.reportIssueInlineTupleItem {
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
    text-align: left;
}

.reportIssueInlineTupleItem--severity {
    font-weight: 700;
    color: #9a3412;
}

.reportIssueInlineTupleItem--rule {
    font-weight: 600;
    color: #9a3412;
}

.reportIssueInlineTupleItem--message {
    color: #0b1120;
    flex: 1 1 auto;
    min-width: 0;
}

.reportIssueInlineCode {
    width: 100%;
    background: #eff6ff;
    border: 1px solid #93c5fd;
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--code-font, "JetBrains Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    color: #1d4ed8;
    background-clip: padding-box;
}

.reportIssueInlineCode code {
    font-family: inherit;
}

.reportIssueInlineBadges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #cbd5f5;
}

.reportIssueInlineIndex {
    color: #1e3a8a;
}

.reportIssueInlineRule {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(59, 130, 246, 0.15);
    color: #1d4ed8;
    font-weight: 600;
}

.reportIssueInlineSeverity {
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 600;
    border: 1px solid transparent;
    color: #0f172a;
}

.reportIssueInlineSeverity--error {
    background: rgba(248, 113, 113, 0.22);
    color: #991b1b;
    border-color: rgba(248, 113, 113, 0.45);
}

.reportIssueInlineSeverity--warn {
    background: rgba(234, 179, 8, 0.24);
    color: #92400e;
    border-color: rgba(234, 179, 8, 0.45);
}

.reportIssueInlineSeverity--info {
    background: rgba(59, 130, 246, 0.2);
    color: #1d4ed8;
    border-color: rgba(59, 130, 246, 0.45);
}

.reportIssueInlineSeverity--muted {
    background: rgba(148, 163, 184, 0.24);
    color: #1f2937;
    border-color: rgba(148, 163, 184, 0.45);
}

.reportIssueInlineLine {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(154, 52, 18, 0.14);
    color: #9a3412;
    font-weight: 600;
}

.reportIssueInlineMessage {
    flex: 1 1 220px;
    min-width: 200px;
    font-weight: 600;
    color: #0b1120;
}

.reportIssueInlineMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: #334155;
}

.reportIssueInlineObject {
    font-weight: 600;
}

.reportIssueInlineColumn {
    color: #1f2937;
}

.reportIssuesEmpty {
    margin: 0;
    font-size: 13px;
    color: #94a3b8;
}

.reportRaw {
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    background: #111827;
    padding: 10px 14px;
}

.reportRaw > summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    color: #cbd5f5;
}

.reportRaw > summary::marker {
    color: #94a3b8;
}

.reportErrorPanel {
    margin: 0;
    padding: 16px;
    border-radius: 6px;
    border: 1px solid rgba(248, 113, 113, 0.3);
    background: rgba(248, 113, 113, 0.08);
    color: #fda4af;
}

.reportErrorText {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.reportErrorHint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #fecaca;
}

.reportChunks {
    margin-top: 16px;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    background: #111827;
    padding: 12px 16px;
    color: #e2e8f0;
}

.reportChunks > summary {
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
}

.reportChunkList {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reportChunkList--issues {
    gap: 16px;
}

.reportChunkTitle {
    margin: 0 0 6px;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkIssues {
    margin: 0;
    padding-left: 20px;
    list-style: disc;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.reportChunkIssue {
    margin: 0;
}

.reportChunkIssueMessage {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #f8fafc;
}

.reportChunkIssueMeta {
    margin: 4px 0 0;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkIssueContext {
    margin: 6px 0 0;
    font-size: 12px;
    color: #cbd5f5;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportChunkEmpty {
    margin: 6px 0 0;
    font-size: 12px;
    color: #94a3b8;
}

.reportChunkBody {
    margin: 0;
    padding: 12px;
    border-radius: 4px;
    border: 1px solid #2f2f2f;
    background: #1b1b1b;
    color: #d1d5db;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
}

.reportViewerPlaceholder {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.pvHeader {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    line-height: 1.2;
}

.pvName {
    font-size: 16px;
    font-weight: 600;
    color: #f3f4f6;
    word-break: break-all;
}

.pvMeta {
    font-size: 12px;
    color: #94a3b8;
}

.pvBox {
    flex: 1 1 auto;
    background: #1b1b1b;
    border-radius: 6px;
    border: 1px solid #2f2f2f;
    padding: 12px;
    display: flex;
    overflow: auto;
}

.pvBox.codeBox {
    padding: 12px;
    overflow: auto;
}

.pvBox.codeBox.reportIssuesBox,
.pvBox.codeBox.reportIssuesBox .codeScroll {
    overflow: auto;
}

.codeScroll {
    flex: 1 1 auto;
    font-family: Consolas, "Courier New", monospace;
    font-size: 13px;
    line-height: 1.45;
    color: #1f2937;
    background: #f8fafc;
    cursor: text;
    overflow: auto;
    max-height: 100%;
}

.reportBody.codeScroll,
.reportChunkBody.codeScroll {
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeEditor {
    display: block;
    width: 100%;
    min-width: 0;
    outline: none;
    caret-color: transparent;
}

.codeEditor:focus {
    outline: none;
}

.codeLine {
    display: flex;
    align-items: flex-start;
    width: 100%;
}

.codeLineNo {
    position: relative;
    flex: 0 0 auto;
    width: 5ch;
    min-width: 5ch;
    padding: 0 12px 0 0;
    text-align: right;
    color: #4b5563;
    font-variant-numeric: tabular-nums;
    user-select: none;
}

.codeLineNo::before {
    content: attr(data-line);
    display: block;
}

.codeLineContent {
    flex: 1 1 auto;
    display: block;
    width: 100%;
    padding: 0 12px;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    min-width: 0;
    -webkit-user-select: text;
    -moz-user-select: text;
    -ms-user-select: text;
    user-select: text;
}

.codeSelectionHighlight {
    background: rgba(59, 130, 246, 0.25);
    color: #1f2937;
    border-radius: 2px;
}

.reportBody::selection,
.reportBody *::selection,
.reportChunkBody::selection,
.reportChunkBody *::selection,
.codeScroll::selection,
.codeScroll *::selection,
.codeLineContent::selection,
.codeLineContent *::selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}

.reportBody::-moz-selection,
.reportBody *::-moz-selection,
.reportChunkBody::-moz-selection,
.reportChunkBody *::-moz-selection,
.codeScroll::-moz-selection,
.codeScroll *::-moz-selection,
.codeLineContent::-moz-selection,
.codeLineContent *::-moz-selection {
    background: rgba(59, 130, 246, 0.45);
    color: #f8fafc;
}


.modalBackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, .5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
}

.modalCard {
    width: 520px;
    max-width: 90vw;
    background: #252526;
    color: #e5e7eb;
    border: 1px solid #3d3d3d;
    border-radius: 10px;
    padding: 18px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .6);
}

.modalCard h3 {
    margin: 0 0 6px;
}

.modalCard p {
    margin: 6px 0 12px;
    opacity: .9;
}

.dropZone {
    border: 2px dashed #3d3d3d;
    border-radius: 10px;
    height: 160px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    user-select: none;
}

.dropZone:hover {
    background: #2a2a2a;
}

.modalBtns {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3d3d3d;
    background: #007acc;
    color: #fff;
    cursor: pointer;
}

.btn:hover {
    filter: brightness(1.1);
}

.btn.ghost {
    background: transparent;
    color: #e5e7eb;
}

.btn.outline {
    background: transparent;
    color: #e5e7eb;
    border-color: #4b5563;
}

/* Light theme overrides */
.page--light {
    background-color: #f8fafc;
    color: #1f2937;
    --panel-surface: #ffffff;
    --panel-surface-alt: #f8fafc;
    --panel-border: #e2e8f0;
    --panel-border-strong: #cbd5f5;
    --panel-divider: rgba(148, 163, 184, 0.35);
    --panel-heading: #0f172a;
    --panel-muted: #64748b;
    --panel-accent: #2563eb;
    --panel-accent-soft: rgba(37, 99, 235, 0.12);
    --tree-row-hover: rgba(148, 163, 184, 0.18);
    --tree-row-active: rgba(59, 130, 246, 0.18);
    --tree-text: #1f2937;
    --tree-icon: #475569;
    --tree-connector: rgba(148, 163, 184, 0.4);
    --tree-badge-text: #1f2937;
    --tree-badge-idle: rgba(148, 163, 184, 0.24);
    --tree-badge-processing: rgba(234, 179, 8, 0.35);
    --tree-badge-ready: rgba(34, 197, 94, 0.28);
    --tree-badge-error: rgba(239, 68, 68, 0.32);
    --scrollbar-track: #e2e8f0;
    --scrollbar-thumb: #cbd5f5;
    --scrollbar-thumb-hover: #93c5fd;
}

.page--light .topBar {
    background: linear-gradient(90deg, #ffffff, #f1f5f9);
    border-bottom: 1px solid #cbd5f5;
    box-shadow: 0 2px 6px rgba(148, 163, 184, 0.35);
    color: #0f172a;
}

.page--light .topBar_iconBtn {
    background: #ffffff;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .topBar_iconBtn:hover:not(:disabled) {
    background: #e2e8f0;
    border-color: #93c5fd;
    color: #1d4ed8;
}

.page--light .topBar_iconBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(14, 165, 233, 0.18));
    color: #1d4ed8;
}

.page--light .topBar_addProject {
    background-color: #2563eb;
    box-shadow: 0 4px 12px rgba(148, 163, 184, 0.35);
}

.page--light .topBar_addProject:hover {
    background-color: #1d4ed8;
}

.page--light .mainContent {
    background-color: #f8fafc;
}

.page--light .workSpace {
    background: #ffffff;
    border-color: #e2e8f0;
}

.page--light .toolColumn {
    background: #e2e8f0;
    border-right: 1px solid #cbd5f5;
}

.page--light .toolColumn_btn {
    background: #ffffff;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .toolColumn_btn:hover {
    background: #e2e8f0;
    border-color: #93c5fd;
    color: #1d4ed8;
}

.page--light .toolColumn_btn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(14, 165, 233, 0.18));
    color: #1d4ed8;
}

.page--light .panelHeader {
    color: #475569;
}

.page--light .reportViewerContent {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportViewerProcessingOverlay {
    background: rgba(148, 163, 184, 0.35);
}

.page--light .reportViewerProcessingText {
    color: #1f2937;
}

.page--light .reportViewerPlaceholder {
    color: #64748b;
}

.page--light .reportTitle {
    color: #0f172a;
}

.page--light .reportViewerTimestamp {
    color: #64748b;
}

.page--light .reportBody {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportStructuredToggleButton {
    background: #e2e8f0;
    border-color: #cbd5f5;
    color: #1f2937;
}

.page--light .reportStructuredToggleButton.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(14, 165, 233, 0.2));
    color: #1d4ed8;
}

.page--light .reportJsonPreviewDetails {
    background: #f8fafc;
    border-color: #cbd5f5;
}

.page--light .reportJsonPreviewSummary {
    color: #1d4ed8;
}

.page--light .reportJsonPreview {
    background: #ffffff;
    border-top-color: rgba(59, 130, 246, 0.2);
    color: #1f2937;
}

.page--light .reportExportButton {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
}

.page--light .reportExportButton:hover:not(:disabled) {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: #ffffff;
}

.page--light .reportExportButton:disabled {
    background: #e2e8f0;
    border-color: #cbd5f5;
    color: #94a3b8;
}

.page--light .reportSummaryCard {
    background: #f1f5f9;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportSummaryLabel {
    color: #475569;
}

.page--light .reportSummaryList {
    color: #1f2937;
}

.page--light .reportSummaryItemLabel {
    color: #0f172a;
}

.page--light .reportSummaryText {
    color: #1f2937;
}

.page--light .reportSummaryValue {
    color: #0f172a;
}

.page--light .reportSummaryItemValue {
    color: #1d4ed8;
}

.page--light .reportStaticSection,
.page--light .reportDmlDetails {
    background: #f8fafc;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportStaticHeader h4 {
    color: #0f172a;
}

.page--light .reportDmlHeader h4 {
    color: inherit;
}

.page--light .reportStaticEngine,
.page--light .reportDmlTimestamp,
.page--light .reportDmlEmpty {
    color: #64748b;
}

.page--light .reportStaticBlock h5 {
    color: #1f2937;
}

.page--light .reportStaticItemLabel {
    color: #0f172a;
}

.page--light .reportStaticItemValue {
    color: #1d4ed8;
}

.page--light .reportDmlStatus {
    color: #1d4ed8;
}

.page--light .reportDmlSummaryToggle {
    color: #1d4ed8;
}

.page--light .reportDmlDetails:not([open]) .reportDmlSummaryToggle:hover {
    color: #1f2937;
}

.page--light .reportDmlDetails[open] .reportDmlSummaryToggle:hover {
    background: rgba(148, 163, 184, 0.32);
}

.page--light .reportDmlSegment {
    background: #f1f5f9;
    border-color: #e2e8f0;
}

.page--light .reportDmlSegment summary {
    color: #1f2937;
}

.page--light .reportDmlSegment pre {
    background: #ffffff;
    color: #1f2937;
}

.page--light .reportDmlSql {
    background: rgba(59, 130, 246, 0.12);
    color: #1d4ed8;
}

.page--light .reportDmlAnalysis {
    background: rgba(14, 165, 233, 0.12);
    color: #0f172a;
}

.page--light .reportDmlSummary {
    background: #f1f5f9;
    color: #1f2937;
}

.page--light .reportErrorPanel {
    background: rgba(248, 113, 113, 0.12);
    border-color: rgba(248, 113, 113, 0.35);
    color: #b91c1c;
}

.page--light .reportErrorHint {
    color: #b91c1c;
}

.page--light .reportChunks {
    background: #f8fafc;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .reportChunkTitle,
.page--light .reportChunkIssueMeta,
.page--light .reportChunkEmpty {
    color: #64748b;
}

.page--light .reportChunkIssueMessage {
    color: #0f172a;
}

.page--light .reportChunkIssueContext {
    color: #1d4ed8;
}

.page--light .reportChunkBody {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .pvName {
    color: #0f172a;
}

.page--light .pvMeta {
    color: #64748b;
}

.page--light .pvBox {
    background: #ffffff;
    border-color: #e2e8f0;
    color: #1f2937;
}

.page--light .codeScroll {
    background: #f8fafc;
    color: #1f2937;
}

.page--light .codeLineNo {
    color: #94a3b8;
}

.page--light .codeSelectionHighlight {
    background: rgba(59, 130, 246, 0.18);
    color: #1d4ed8;
}

.page--light .modalBackdrop {
    background: rgba(148, 163, 184, 0.35);
}

.page--light .modalCard {
    background: #ffffff;
    color: #1f2937;
    border-color: #e2e8f0;
    box-shadow: 0 16px 32px rgba(148, 163, 184, 0.4);
}

.page--light .dropZone {
    border-color: #cbd5f5;
    background: #f8fafc;
    color: #64748b;
}

.page--light .dropZone:hover {
    background: #e2e8f0;
}

.page--light .btn {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
}

.page--light .btn.ghost {
    background: transparent;
    color: #1d4ed8;
}

.page--light .btn.outline {
    background: transparent;
    border-color: #93c5fd;
    color: #1d4ed8;
}

</style>






































































