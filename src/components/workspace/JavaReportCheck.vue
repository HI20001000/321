<script setup>
import { computed } from "vue";

const props = defineProps({
    blocks: {
        type: Array,
        default: () => []
    },
    combinedReport: {
        type: String,
        default: ""
    }
});

const hasBlocks = computed(() => Array.isArray(props.blocks) && props.blocks.length > 0);
</script>

<template>
    <section class="javaReportSection">
        <header class="javaReportHeader">
            <h4>Java 報告檢查</h4>
            <p class="javaReportSubtext" v-if="hasBlocks">共 {{ blocks.length }} 個方法區塊</p>
            <p class="javaReportSubtext" v-else>尚未取得任何 Java 分析區塊</p>
        </header>

        <ul v-if="hasBlocks" class="javaReportList">
            <li v-for="(block, index) in blocks" :key="`${block.className}-${block.signature}-${index}`" class="javaReportItem">
                <div class="javaReportItemHeader">
                    <span class="javaReportBadge">{{ block.className }}</span>
                    <span class="javaReportSignature">{{ block.signature || "(anonymous)" }}</span>
                </div>
                <pre class="javaReportBody codeScroll themed-scrollbar" v-text="block.report || '無回應'" />
            </li>
        </ul>

        <details v-if="combinedReport" class="javaReportCombined">
            <summary class="javaReportCombinedSummary">聚合結果</summary>
            <pre class="javaReportCombinedBody codeScroll themed-scrollbar" v-text="combinedReport" />
        </details>
    </section>
</template>

<style scoped>
.javaReportSection {
    margin: 16px 0 0;
    padding: 16px;
    border: 1px solid #d9d9d9;
    border-radius: 12px;
    background: #fdfdfd;
}

.javaReportHeader {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 12px;
}

.javaReportHeader h4 {
    margin: 0;
    font-size: 16px;
}

.javaReportSubtext {
    margin: 0;
    color: #666;
    font-size: 12px;
}

.javaReportList {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.javaReportItem {
    border: 1px solid #e5e5e5;
    border-radius: 10px;
    padding: 12px;
    background: #fff;
}

.javaReportItemHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}

.javaReportBadge {
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    background: #eef4ff;
    color: #2a4b8d;
    border-radius: 6px;
    font-weight: 600;
    font-size: 12px;
}

.javaReportSignature {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 12px;
    color: #444;
}

.javaReportBody {
    max-height: 200px;
    margin: 0;
    padding: 10px;
    background: #f7f7f7;
    border-radius: 8px;
    white-space: pre-wrap;
    line-height: 1.4;
}

.javaReportCombined {
    margin-top: 12px;
}

.javaReportCombinedSummary {
    cursor: pointer;
    font-weight: 600;
}

.javaReportCombinedBody {
    margin: 8px 0 0;
    padding: 10px;
    background: #f7f7f7;
    border-radius: 8px;
    white-space: pre-wrap;
    line-height: 1.4;
}
</style>
