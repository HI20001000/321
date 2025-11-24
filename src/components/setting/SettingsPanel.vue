<template>
    <div class="settingsPanel">
        <div class="panelHeader">設定工作區</div>
        <div class="settingsTabs" role="tablist" aria-label="設定分頁">
            <button
                v-for="tab in settingsTabs"
                :key="tab.key"
                type="button"
                class="settingsTabBtn"
                :class="{ active: settingsTab === tab.key }"
                role="tab"
                :aria-selected="settingsTab === tab.key"
                @click="setSettingsTab(tab.key)"
            >
                {{ tab.label }}
            </button>
        </div>

        <section v-if="settingsTab === 'aiReview'" class="settingsSection">
            <p class="settingsDescription">
                配置代碼塊切分邏輯：SQL 與 Java 都會拆分成代碼段並送往 Dify，調整下方段數即可一次輸入多個區塊
                （例如設為 3 代表同時提交三個區塊）。
            </p>
            <div class="settingsGrid">
                <div class="settingCard">
                    <div class="settingLabel">SQL 代碼段數</div>
                    <input
                        v-model.number="aiChunkConfig.sqlChunkCount"
                        type="number"
                        min="1"
                        class="settingInput"
                        aria-label="SQL 代碼段數"
                    />
                    <p class="settingHint">用於 Dify 的 SQL 區塊數，確保長查詢能被完整拆解。</p>
                </div>
                <div class="settingCard">
                    <div class="settingLabel">Java 代碼段數</div>
                    <input
                        v-model.number="aiChunkConfig.javaChunkCount"
                        type="number"
                        min="1"
                        class="settingInput"
                        aria-label="Java 代碼段數"
                    />
                    <p class="settingHint">用於 Dify 的 Java 區塊數，便於一次處理多個方法或類。</p>
                </div>
            </div>
            <div class="settingsActions">
                <button type="button" class="settingsSaveButton" @click="handleSave">保存設定</button>
            </div>
        </section>

        <section v-else class="settingsSection">
            <div class="settingsDescription">
                規則引擎配置：分別維護 SQL 與 Java 類型的檔案規則，支持調整規則 ID、嚴重度、描述與啟用狀態。請選擇要
                編輯的檔案類型（不可同時設定兩個）。
            </div>
            <div class="ruleFileTabs" role="tablist" aria-label="規則檔案類型">
                <button
                    v-for="option in fileTypeOptions"
                    :key="option.key"
                    type="button"
                    class="ruleFileTab"
                    :class="{ active: ruleFileType === option.key }"
                    role="tab"
                    :aria-selected="ruleFileType === option.key"
                    @click="selectRuleFileType(option.key)"
                >
                    {{ option.label }}
                </button>
            </div>
            <div class="ruleEngineCard">
                <div class="ruleEngineHeader">
                    <h4>{{ ruleFileType === 'sql' ? 'SQL 文件規則' : 'Java 文件規則' }}</h4>
                    <p class="ruleEngineSub">
                        針對 {{ ruleFileType.toUpperCase() }} 檔案的規則參數（Rule ID、severity_levels、規則描述、是否啟用）。
                    </p>
                </div>
                <div class="ruleTableWrapper themed-scrollbar">
                    <table class="ruleTable">
                        <thead>
                            <tr>
                                <th scope="col">規則 ID</th>
                                <th scope="col">severity_levels</th>
                                <th scope="col">規則描述</th>
                                <th scope="col">是否啟用</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(rule, index) in activeRules" :key="`${ruleFileType}-${index}`">
                                <td>
                                    <input v-model="rule.id" type="text" class="settingInput" />
                                </td>
                                <td>
                                    <input v-model="rule.severityLevels" type="text" class="settingInput" />
                                </td>
                                <td>
                                    <textarea v-model="rule.description" rows="2" class="settingTextarea"></textarea>
                                </td>
                                <td class="ruleEnabledCell">
                                    <label class="switchLabel">
                                        <input v-model="rule.enabled" type="checkbox" />
                                        <span>{{ rule.enabled ? '啟用' : '停用' }}</span>
                                    </label>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="settingsActions">
                <button type="button" class="settingsSaveButton" @click="handleSave">保存設定</button>
            </div>
        </section>
    </div>
</template>

<script setup>
import { computed, reactive, ref } from "vue";

const emit = defineEmits(["save"]);

const settingsTabs = [
    { key: "aiReview", label: "AI審查配置" },
    { key: "ruleEngine", label: "規則引擎配置" }
];

const fileTypeOptions = [
    { key: "sql", label: "SQL 文件" },
    { key: "java", label: "Java 文件" }
];

const settingsTab = ref("aiReview");
const ruleFileType = ref("sql");

const aiChunkConfig = reactive({
    sqlChunkCount: 3,
    javaChunkCount: 3
});

const ruleEngineConfigs = reactive({
    sql: [
        {
            id: "SQL-001",
            severityLevels: "critical",
            description: "避免未帶條件的刪除或更新語句，防止全表操作",
            enabled: true
        },
        {
            id: "SQL-002",
            severityLevels: "medium",
            description: "強制使用參數化查詢以避免 SQL 注入風險",
            enabled: true
        }
    ],
    java: [
        {
            id: "JAVA-001",
            severityLevels: "medium",
            description: "避免在敏感資訊處理時記錄純文字日誌",
            enabled: true
        },
        {
            id: "JAVA-002",
            severityLevels: "low",
            description: "鼓勵為公開 API 方法添加 JavaDoc 說明",
            enabled: false
        }
    ]
});

const activeRules = computed(() => ruleEngineConfigs[ruleFileType.value] ?? []);

function setSettingsTab(tab) {
    settingsTab.value = tab;
}

function selectRuleFileType(type) {
    ruleFileType.value = type;
}

function handleSave() {
    emit("save", {
        activeTab: settingsTab.value,
        ruleFileType: ruleFileType.value,
        aiChunkConfig: {
            sqlChunkCount: aiChunkConfig.sqlChunkCount,
            javaChunkCount: aiChunkConfig.javaChunkCount
        },
        ruleEngineConfigs: {
            sql: ruleEngineConfigs.sql.map((rule) => ({ ...rule })),
            java: ruleEngineConfigs.java.map((rule) => ({ ...rule }))
        }
    });
}
</script>

<style scoped>
.settingsPanel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
    height: 100%;
}

.panelHeader {
    font-weight: 700;
    color: #cbd5e1;
    font-size: 14px;
}

.settingsTabs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
}

.settingsTabBtn {
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(148, 163, 184, 0.16);
    color: #e2e8f0;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.settingsTabBtn.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(59, 130, 246, 0.6);
    color: #f8fafc;
}

.settingsSection {
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.settingsDescription {
    margin: 0;
    color: #cbd5e1;
    line-height: 1.6;
}

.settingsGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
}

.settingCard {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.settingLabel {
    font-weight: 600;
    color: #e2e8f0;
}

.settingInput,
.settingTextarea {
    width: 100%;
    border: 1px solid #334155;
    border-radius: 6px;
    background: #111827;
    color: #e2e8f0;
    padding: 8px 10px;
    font-size: 14px;
    box-sizing: border-box;
}

.settingInput:focus,
.settingTextarea:focus {
    outline: 2px solid #60a5fa;
    border-color: #60a5fa;
}

.settingTextarea {
    resize: vertical;
    min-height: 60px;
}

.settingHint {
    margin: 0;
    color: #94a3b8;
    font-size: 13px;
}

.ruleFileTabs {
    display: inline-flex;
    gap: 8px;
}

.ruleFileTab {
    border: 1px solid rgba(148, 163, 184, 0.4);
    background: rgba(148, 163, 184, 0.16);
    color: #e2e8f0;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.ruleFileTab.active {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.25));
    border-color: rgba(59, 130, 246, 0.6);
    color: #f8fafc;
}

.ruleEngineCard {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.ruleEngineHeader h4 {
    margin: 0;
    color: #e2e8f0;
}

.ruleEngineSub {
    margin: 4px 0 0;
    color: #94a3b8;
    font-size: 13px;
}

.ruleTableWrapper {
    overflow-x: auto;
    border: 1px solid #1e293b;
    border-radius: 8px;
}

.ruleTable {
    width: 100%;
    border-collapse: collapse;
    min-width: 520px;
}

.ruleTable th,
.ruleTable td {
    border-bottom: 1px solid #1f2937;
    padding: 10px;
    text-align: left;
    color: #e2e8f0;
    font-size: 13px;
}

.ruleTable th {
    background: #111827;
    position: sticky;
    top: 0;
    z-index: 1;
}

.ruleTable tr:nth-child(even) {
    background: rgba(148, 163, 184, 0.04);
}

.ruleEnabledCell {
    text-align: center;
    white-space: nowrap;
}

.switchLabel {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.settingsActions {
    display: flex;
    justify-content: flex-end;
}

.settingsSaveButton {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.4), rgba(14, 165, 233, 0.4));
    border: 1px solid rgba(59, 130, 246, 0.7);
    color: #f8fafc;
    padding: 10px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.settingsSaveButton:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px rgba(59, 130, 246, 0.25);
}
</style>
