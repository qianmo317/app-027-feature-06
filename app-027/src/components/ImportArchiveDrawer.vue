<script setup lang="ts">
import { ref } from 'vue'
import {
  decisionLabel,
  deleteBatch,
  downloadBatchMarkdown,
  fmtScale,
  fmtTime,
  listBatches,
  type ImportBatch,
} from '@/logic/importArchive'
import { SKIP_REASON_LABEL } from '@/logic/importer'

const open = ref(false)
const batches = ref<ImportBatch[]>([])
const expandedBatch = ref<string | null>(null)
const expandedFile = ref<string | null>(null)
const onlyDecided = ref(false)

function refresh(): void {
  batches.value = listBatches()
}

function show(): void {
  refresh()
  open.value = true
}

defineExpose({ show })

function close(): void {
  open.value = false
}

function toggleBatch(id: string): void {
  expandedBatch.value = expandedBatch.value === id ? null : id
  expandedFile.value = null
}

function toggleFile(key: string): void {
  expandedFile.value = expandedFile.value === key ? null : key
}

function remove(b: ImportBatch): void {
  if (confirm(`删除这份导入报告留档（${fmtTime(b.createdAt)}，${b.files.length} 个文件）？不影响已生成的项目。`)) {
    deleteBatch(b.id)
    refresh()
  }
}

const visible = (b: ImportBatch) => (onlyDecided.value ? b.decision && b.decision !== 'cancelled' : true)

const emit = defineEmits<{ (e: 'navigate', projectId: string): void }>()
</script>

<template>
  <button class="tiny" @click="show">导入报告留档（{{ listBatches().length }}）</button>

  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h2>导入报告留档</h2>
          <div class="sub">每次选完文件解析后都会留档；确认前报告标记为「待确认」，不写入项目库</div>
        </div>
        <button class="ghost tiny" @click="close">关闭</button>
      </div>

      <div class="modal-body">
        <label class="filter-line">
          <input type="checkbox" v-model="onlyDecided" @change="refresh" />
          只看已确认导入的
        </label>

        <div v-if="batches.filter(visible).length === 0" class="empty">还没有导入报告留档。</div>

        <div v-for="b in batches.filter(visible)" :key="b.id" class="batch-card">
          <div class="batch-head" @click="toggleBatch(b.id)">
            <span class="caret">{{ expandedBatch === b.id ? '▾' : '▸' }}</span>
            <span class="btime">{{ fmtTime(b.createdAt) }}</span>
            <span class="bcount">{{ b.files.length }} 个文件</span>
            <span class="bstatus" :class="{ pending: !b.decision, cancelled: b.decision === 'cancelled', ok: b.decision === 'merge' || b.decision === 'separate' }">
              {{ decisionLabel(b) }}
            </span>
            <span class="row-actions" @click.stop>
              <button class="tiny" @click="downloadBatchMarkdown(b)">导出 .md</button>
              <button class="tiny danger" @click="remove(b)">删除</button>
            </span>
          </div>

          <div v-if="expandedBatch === b.id" class="batch-body">
            <div class="bmeta">解析参数：贝塞尔容差 {{ b.toleranceMm }}mm，闭合判定 {{ b.closeToleranceMm }}mm</div>
            <div v-for="(f, i) in b.files" :key="f.fileName" class="file-block">
              <div class="file-head" @click="toggleFile(`${b.id}/${f.fileName}`)">
                <span class="caret">{{ expandedFile === `${b.id}/${f.fileName}` ? '▾' : '▸' }}</span>
                <span class="fidx">{{ i + 1 }}.</span>
                <span class="fname">{{ f.fileName }}</span>
                <span class="fc"><b>{{ f.kept }}</b> 轮廓</span>
                <span class="fc">比例 {{ fmtScale(f.scale).split('（')[0] }}</span>
                <span v-if="f.notClosed > 0" class="chip warn">{{ f.notClosed }} 未闭合</span>
                <span v-if="f.selfIntersect > 0" class="chip warn">{{ f.selfIntersect }} 自交</span>
                <span v-if="f.duplicates > 0" class="chip">{{ f.duplicates }} 重复</span>
                <span v-if="f.skipped > 0" class="chip err">跳过 {{ f.skipped }}</span>
              </div>
              <div v-if="expandedFile === `${b.id}/${f.fileName}`" class="file-detail">
                <table class="kv">
                  <tbody>
                    <tr><td>原始子路径</td><td>{{ f.subPaths }} 条</td></tr>
                    <tr><td>保留轮廓</td><td><b>{{ f.kept }}</b> 条</td></tr>
                    <tr><td>缩放比例</td><td>{{ fmtScale(f.scale) }}</td></tr>
                    <tr><td>成品尺寸</td><td>{{ f.sizeMm.w.toFixed(2) }} × {{ f.sizeMm.h.toFixed(2) }} mm</td></tr>
                    <tr><td>闭合 / 清理</td><td>未闭合 {{ f.notClosed }}｜自动闭合 {{ f.autoClosed }}｜自交 {{ f.selfIntersect }}｜重复合并 {{ f.duplicates }}｜退化丢弃 {{ f.dropped }}</td></tr>
                    <tr v-if="f.finalShapeName"><td>入库形状</td><td>{{ f.finalShapeName }}<span v-if="f.projectName">（项目：{{ f.projectName }}）</span></td></tr>
                  </tbody>
                </table>
                <div v-if="f.notes.length > 0" class="notes">
                  <span v-for="(n, ni) in f.notes" :key="ni" class="note">· {{ n }}</span>
                </div>
                <div class="skip-title">
                  跳过元素清单（{{ f.skippedElements.length }} 条<template v-if="f.skippedTruncated">，已截断</template>）
                </div>
                <table v-if="f.skippedElements.length > 0" class="skip-table">
                  <thead><tr><th>#</th><th>元素</th><th>原因</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr v-for="(s, si) in f.skippedElements" :key="si">
                      <td class="num">{{ si + 1 }}</td>
                      <td class="mono">{{ s.element }}</td>
                      <td><span class="reason-tag" :data-r="s.reason">{{ SKIP_REASON_LABEL[s.reason] }}</span></td>
                      <td class="dim">{{ s.detail }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="dim">无跳过元素。</div>
              </div>
            </div>
            <div v-if="b.projectIds.length > 0" class="foot-links">
              <span class="dim">生成的项目：</span>
              <a v-for="pid in b.projectIds" :key="pid" href="#" @click.prevent="emit('navigate', pid)">/design/{{ pid }}</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 15, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 20px;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 9px;
  width: min(880px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  border-radius: 9px 9px 0 0;
}

.modal-head .sub {
  color: var(--text-mute);
  font-size: 11.5px;
}

.modal-body {
  padding: 12px 16px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-line {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  gap: 6px;
  align-items: center;
}

.empty {
  text-align: center;
  color: var(--text-mute);
  padding: 30px 0;
  font-size: 12px;
}

.batch-card {
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--bg-grid);
}

.batch-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  cursor: pointer;
  flex-wrap: wrap;
}

.batch-head:hover {
  background: rgba(255, 143, 60, 0.06);
}

.caret {
  color: var(--text-mute);
  width: 12px;
}

.btime {
  font-family: var(--mono);
  font-size: 11.5px;
}

.bcount {
  font-size: 11.5px;
  color: var(--text-dim);
}

.bstatus {
  font-size: 11px;
  color: var(--text-dim);
}

.bstatus.pending {
  color: var(--warn);
}

.bstatus.cancelled {
  color: var(--text-mute);
}

.bstatus.ok {
  color: var(--ok);
}

.row-actions {
  margin-left: auto;
  display: flex;
  gap: 5px;
}

.batch-body {
  border-top: 1px dashed var(--line-soft);
  padding: 8px 10px;
}

.bmeta {
  font-size: 11px;
  color: var(--text-mute);
  margin-bottom: 6px;
}

.file-block {
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  margin-bottom: 6px;
  background: var(--panel);
}

.file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
  flex-wrap: wrap;
}

.fidx {
  color: var(--text-mute);
  font-family: var(--mono);
  font-size: 11px;
}

.fname {
  font-weight: 600;
  font-size: 12px;
}

.fc {
  font-size: 11px;
  color: var(--text-dim);
}

.fc b {
  font-family: var(--mono);
  color: var(--text);
}

.chip {
  font-size: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0 6px;
  color: var(--text-dim);
}

.chip.warn {
  color: var(--warn);
  border-color: rgba(255, 200, 87, 0.4);
}

.chip.err {
  color: var(--err);
  border-color: rgba(255, 107, 107, 0.4);
}

.file-detail {
  border-top: 1px dashed var(--line-soft);
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

table.kv td {
  padding: 2px 14px 2px 0;
  font-size: 11.5px;
  vertical-align: top;
}

table.kv td:first-child {
  color: var(--text-mute);
  white-space: nowrap;
}

.notes {
  display: flex;
  flex-direction: column;
}

.note {
  font-size: 11px;
  color: var(--text-dim);
}

.skip-title {
  font-size: 11.5px;
  color: var(--text-dim);
}

.skip-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.skip-table th,
.skip-table td {
  border-bottom: 1px solid var(--line-soft);
  padding: 3px 6px;
  text-align: left;
}

.skip-table th {
  color: var(--text-mute);
  font-weight: 500;
  font-size: 10px;
}

.num {
  font-family: var(--mono);
  text-align: right;
}

.mono {
  font-family: var(--mono);
  font-size: 10.5px;
}

.dim {
  color: var(--text-mute);
  font-size: 11px;
}

.reason-tag {
  font-size: 10px;
  border-radius: 4px;
  padding: 0 5px;
  border: 1px solid var(--line);
  white-space: nowrap;
}

.reason-tag[data-r='unsupported_tag'] {
  color: var(--err);
  border-color: rgba(255, 107, 107, 0.4);
}

.reason-tag[data-r='empty_geometry'] {
  color: var(--warn);
  border-color: rgba(255, 200, 87, 0.4);
}

.reason-tag[data-r='hidden'] {
  color: var(--purple);
  border-color: rgba(180, 140, 255, 0.4);
}

.reason-tag[data-r='background_rect'] {
  color: var(--info);
  border-color: rgba(90, 169, 255, 0.4);
}

.foot-links {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 11px;
}
</style>
