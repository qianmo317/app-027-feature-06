<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import ImportReportPanel from '@/components/ImportReportPanel.vue'
import { importState, loadImportReports } from '@/logic/importReports'
import { store } from '@/logic/store'

const router = useRouter()

onMounted(() => {
  if (!store.state.ready) store.loadState()
  if (!importState.ready) loadImportReports()
})

/**
 * 待确认批次带完整几何点数据，存在 sessionStorage；页面直接渲染 importState.pending。
 * 确认/取消后该批次转为留档（无几何），切换到只读的留档视图。
 */
const finishedBatchId = ref<string | null>(null)
const finishedFirstProjectId = ref<string | null>(null)

const pending = computed(() => importState.pending)
const finished = computed(() =>
  finishedBatchId.value ? importState.archive.find((b) => b.id === finishedBatchId.value) ?? null : null,
)

function onDone(firstProjectId: string | null, batchId: string): void {
  finishedFirstProjectId.value = firstProjectId
  finishedBatchId.value = batchId
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <div class="head-row">
        <h1>导入核对</h1>
        <RouterLink class="back" to="/">← 返回首页</RouterLink>
      </div>

      <div v-if="pending" class="meta-line hint">
        解析完成于 {{ new Date(pending.createdAt).toLocaleString() }}｜共 {{ pending.files.length }} 个文件｜报告已暂存，离开页面也能从首页的「待核对导入」回来继续
      </div>

      <ImportReportPanel v-if="pending" :batch="pending" :pending="true" @done="onDone" @changed="() => {}" />

      <template v-else-if="finished">
        <div class="banner ok">
          <template v-if="finishedFirstProjectId">
            已写入项目库：
            <button class="tiny primary" @click="router.push(`/design/${finishedFirstProjectId}`)">进入项目编辑 →</button>
          </template>
          <template v-else>已取消，本次没有改动项目库；下面是留档报告。</template>
        </div>
        <ImportReportPanel :batch="finished" :pending="false" @done="onDone" @changed="() => {}" />
        <div class="btn-row">
          <RouterLink class="btn" to="/">返回首页</RouterLink>
          <button v-if="finishedFirstProjectId" class="primary" @click="router.push(`/design/${finishedFirstProjectId}`)">
            进入项目编辑 →
          </button>
        </div>
      </template>

      <div v-else class="card empty-state">
        <p>没有待核对的导入报告。</p>
        <p class="hint">报告在确认前临时保存；如果已用完全部导入，请从首页重新选择 SVG 文件。历史报告可在首页「导入报告留档」中查看。</p>
        <RouterLink class="btn primary" to="/">返回首页选文件</RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}
.back {
  font-size: 12px;
}
.meta-line {
  margin-bottom: 10px;
}
.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
  padding: 8px 11px;
  border-radius: 6px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.empty-state {
  text-align: center;
  padding: 30px 16px;
}
.empty-state .btn {
  margin-top: 10px;
}
</style>
