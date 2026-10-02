<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ImportReportPanel from '@/components/ImportReportPanel.vue'
import { deleteArchived, importState, loadImportReports } from '@/logic/importReports'

const route = useRoute()
const router = useRouter()

onMounted(() => {
  if (!importState.ready) loadImportReports()
})

const batch = computed(() => importState.archive.find((b) => b.id === String(route.params.id)) ?? null)

function del(): void {
  if (!batch.value) return
  if (confirm('删除这份导入报告留档？不影响已经创建的项目。')) {
    deleteArchived(batch.value.id)
    void router.push('/')
  }
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <div class="head-row">
        <h1>导入报告留档</h1>
        <RouterLink class="back" to="/">← 返回首页</RouterLink>
      </div>

      <template v-if="batch">
        <div class="meta-line hint">
          生成于 {{ new Date(batch.createdAt).toLocaleString() }}｜{{ batch.files.length }} 个文件
        </div>
        <ImportReportPanel :batch="batch" :pending="false" @done="() => {}" @changed="() => {}" />
        <div class="btn-row">
          <RouterLink class="btn" to="/">返回首页</RouterLink>
          <button class="danger" @click="del">删除此留档</button>
        </div>
      </template>

      <div v-else class="card empty-state">
        <p>找不到这份报告。</p>
        <p class="hint">它可能已被删除。</p>
        <RouterLink class="btn primary" to="/">返回首页</RouterLink>
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
.empty-state {
  text-align: center;
  padding: 30px 16px;
}
.empty-state .btn {
  margin-top: 10px;
}
</style>
