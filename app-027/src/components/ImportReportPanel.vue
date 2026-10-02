<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  cancelPending,
  compareWithLast,
  confirmBatch,
  downloadReport,
  moveFile,
  setIncluded,
  CUT_ORDER_NOTE,
  DUPLICATE_NAME_NOTE,
  MERGE_ORDER_NOTE,
  type FileComparison,
  type FileImportRecord,
  type ImportBatch,
  type ImportMode,
} from '@/logic/importReports'

const props = defineProps<{ batch: ImportBatch; pending: boolean }>()
const emit = defineEmits<{ (e: 'done', firstProjectId: string | null, batchId: string): void; (e: 'changed'): void }>()

const expanded = ref<Record<string, boolean>>({})
const mode = ref<ImportMode>('merged')
const mergedName = ref('')
const error = ref('')

const isPending = computed(() => props.pending)
const includedFiles = computed(() => props.batch.files.filter((f) => f.included && f.ok))
const okFiles = computed(() => props.batch.files.filter((f) => f.ok))
const multiple = computed(() => okFiles.value.length > 1)
const totals = computed(() => {
  let kept = 0
  let notClosed = 0
  let selfIntersect = 0
  let duplicates = 0
  let skipped = 0
  for (const f of includedFiles.value) {
    if (!f.report) continue
    kept += f.report.kept
    notClosed += f.report.notClosed
    selfIntersect += f.report.selfIntersect
    duplicates += f.report.duplicates
    skipped += f.report.skips.length
  }
  return { kept, notClosed, selfIntersect, duplicates, skipped }
})

const defaultMergedName = computed(() => `导入 ${includedFiles.value.length} 个纹样`)

function toggle(rid: string): void {
  expanded.value[rid] = !expanded.value[rid]
}

function onInclude(f: FileImportRecord, v: boolean): void {
  setIncluded(f.rid, v)
  emit('changed')
}

function onMove(rid: string, dir: -1 | 1): void {
  moveFile(rid, dir)
  emit('changed')
}

const comparisons = computed(() => {
  const map = new Map<string, FileComparison | null>()
  if (!isPending.value) return map
  for (const f of props.batch.files) map.set(f.rid, f.ok ? compareWithLast(f.name) : null)
  return map
})

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function deltaTag(c: FileComparison | null | undefined): string {
  if (!c) return ''
  if (c.identical) return '与上次一致'
  const parts: string[] = []
  if (c.kept.delta !== 0) parts.push(`轮廓${c.kept.delta > 0 ? '+' : ''}${c.kept.delta}`)
  if (c.notClosed.delta !== 0) parts.push(`未闭合${c.notClosed.delta > 0 ? '+' : ''}${c.notClosed.delta}`)
  if (c.selfIntersect.delta !== 0) parts.push(`自交${c.selfIntersect.delta > 0 ? '+' : ''}${c.selfIntersect.delta}`)
  if (c.duplicates.delta !== 0) parts.push(`重复${c.duplicates.delta > 0 ? '+' : ''}${c.duplicates.delta}`)
  if (c.scale.delta !== 0) parts.push(`缩放${c.scale.delta > 0 ? '+' : ''}${c.scale.delta}`)
  return parts.length ? `较上次：${parts.join('，')}` : '与上次一致'
}

function doConfirm(): void {
  error.value = ''
  try {
    const batchId = props.batch.id
    const { projects } = confirmBatch(mode.value, mergedName.value)
    emit('done', projects[0]?.id ?? null, batchId)
  } catch (e) {
    error.value = (e as Error).message
  }
}

function doCancel(): void {
  const batchId = props.batch.id
  cancelPending()
  emit('done', null, batchId)
}
</script>

<template>
  <div class="report-panel">
    <div v-if="isPending" class="banner note">
      以下只是解析报告，<strong>尚未改动项目库</strong>。请逐个文件核对缩放、跳过原因与未闭合轮廓，选择导入方式后点「确认导入」。
    </div>
    <div v-if="error" class="banner err">{{ error }}</div>

    <!-- 逐文件报告表 -->
    <div class="card">
      <table class="grid files">
        <thead>
          <tr>
            <th v-if="isPending"></th>
            <th>#</th>
            <th>文件</th>
            <th class="r">轮廓数</th>
            <th class="r">未闭合</th>
            <th class="r">自交</th>
            <th class="r">重复合并</th>
            <th class="r">跳过</th>
            <th>缩放</th>
            <th>核对</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(f, i) in batch.files" :key="f.rid">
            <tr :class="{ failed: !f.ok, disabledRow: isPending && !f.included }">
              <td v-if="isPending" class="center">
                <input v-if="f.ok" type="checkbox" :checked="f.included" @change="onInclude(f, ($event.target as HTMLInputElement).checked)" />
              </td>
              <td class="num dim">{{ i + 1 }}</td>
              <td>
                <a href="#" @click.prevent="toggle(f.rid)">{{ f.name }}</a>
                <div class="sub">{{ fmtSize(f.sizeBytes) }}</div>
              </td>
              <template v-if="f.ok && f.report">
                <td class="num strong">{{ f.report.kept }}</td>
                <td class="num" :class="{ warn: f.report.notClosed > 0 }">{{ f.report.notClosed }}</td>
                <td class="num" :class="{ warn: f.report.selfIntersect > 0 }">{{ f.report.selfIntersect }}</td>
                <td class="num" :class="{ warn: f.report.duplicates > 0 }">{{ f.report.duplicates }}</td>
                <td class="num" :class="{ warn: f.report.skips.length > 0 }">{{ f.report.skips.length }}</td>
                <td class="num">{{ f.report.scale }}×</td>
                <td>
                  <span v-if="f.report.notClosed > 0 || f.report.selfIntersect > 0 || f.report.skips.length > 0" class="tag err">需核对</span>
                  <span v-else class="tag ok">无异常</span>
                </td>
              </template>
              <template v-else>
                <td :colspan="isPending ? 5 : 6" class="err-text">解析失败：{{ f.error }}</td>
                <td :colspan="isPending ? 2 : 1"><span class="tag err">未导入</span></td>
              </template>
            </tr>
            <tr v-if="isPending && comparisons.get(f.rid)" class="cmp-row">
              <td v-if="isPending"></td>
              <td colspan="9">
                <span class="tag" :class="comparisons.get(f.rid)?.identical ? 'ok' : 'warn'">
                  {{ deltaTag(comparisons.get(f.rid)) }}
                </span>
                <span class="hint">（上次报告 {{ fmtTs(comparisons.get(f.rid)!.batchDate) }}）</span>
              </td>
            </tr>
            <tr v-if="expanded[f.rid]">
              <td v-if="isPending"></td>
              <td colspan="9" class="detail-cell">
                <div v-if="f.ok && f.report" class="detail-grid">
                  <div class="detail-block">
                    <h4>解析结果</h4>
                    <div class="kv"><span>子路径数</span><b>{{ f.report.subPaths }}</b></div>
                    <div class="kv"><span>保留轮廓</span><b>{{ f.report.kept }}</b></div>
                    <div class="kv"><span>未闭合轮廓</span><b :class="{ warn: f.report.notClosed > 0 }">{{ f.report.notClosed }} 条</b></div>
                    <div class="kv"><span>自交轮廓</span><b :class="{ warn: f.report.selfIntersect > 0 }">{{ f.report.selfIntersect }} 条</b></div>
                    <div class="kv"><span>重复路径（已合并）</span><b>{{ f.report.duplicates }} 条</b></div>
                    <div class="kv"><span>近闭合自动闭合</span><b>{{ f.report.autoClosed }} 条</b></div>
                    <div class="kv"><span>清理阶段丢弃</span><b>{{ f.report.dropped }} 条</b></div>
                    <div class="kv"><span>成品尺寸</span><b>{{ f.report.sizeMm.w }} × {{ f.report.sizeMm.h }} mm</b></div>
                  </div>
                  <div class="detail-block">
                    <h4>缩放比例</h4>
                    <p class="scale-line mono">{{ f.report.scale }}×</p>
                    <p class="hint">{{ f.report.scaleBasis }}</p>
                    <h4 style="margin-top: 8px">备注</h4>
                    <ul v-if="f.report.notes.length" class="plain">
                      <li v-for="(n, k) in f.report.notes" :key="k">{{ n }}</li>
                    </ul>
                    <p v-else class="hint">无</p>
                  </div>
                  <div class="detail-block wide">
                    <h4>跳过的元素（{{ f.report.skips.length }}）与原因</h4>
                    <p v-if="f.report.skips.length === 0" class="hint">没有跳过任何元素。</p>
                    <table v-else class="grid mini">
                      <thead>
                        <tr><th>元素</th><th>原因</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(s, k) in f.report.skips" :key="k">
                          <td class="mono el">{{ s.element }}</td>
                          <td>{{ s.reason }}</td>
                        </tr>
                      </tbody>
                    </table>
                    <h4 style="margin-top: 8px">清理阶段丢弃（{{ f.report.dropReasons.length }}）</h4>
                    <p v-if="f.report.dropReasons.length === 0" class="hint">无。</p>
                    <ul v-else class="plain">
                      <li v-for="(d, k) in f.report.dropReasons" :key="k">{{ d }}</li>
                    </ul>
                  </div>
                  <div v-if="isPending && multiple" class="detail-block wide order-tools">
                    <span class="hint">合并时该文件在拼接顺序中的位置：第 {{ i + 1 }} 个</span>
                    <button class="tiny" :disabled="i === 0" @click="onMove(f.rid, -1)">↑ 前移</button>
                    <button class="tiny" :disabled="i === batch.files.length - 1" @click="onMove(f.rid, 1)">↓ 后移</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 导入方式选择（仅待确认） -->
    <div v-if="isPending" class="card options">
      <div class="section-title">导入方式<span class="hint">勾选 {{ includedFiles.length }} / 成功 {{ okFiles.length }} 个文件</span></div>

      <label v-if="multiple" class="opt" :class="{ active: mode === 'merged' }">
        <input type="radio" value="merged" v-model="mode" />
        <div>
          <div class="opt-title">合并为一个项目</div>
          <div class="hint">
            勾选的 {{ includedFiles.length || 'N' }} 个文件作为同一项目里的多个形状，适合把拆开的几张图拼成一个纹样。
          </div>
        </div>
      </label>
      <div v-if="multiple && mode === 'merged'" class="rule-box">
        <p>{{ MERGE_ORDER_NOTE }}</p>
        <p>{{ CUT_ORDER_NOTE }}</p>
        <p>{{ DUPLICATE_NAME_NOTE }}</p>
        <div class="field merged-name">
          <label>合并后的项目名</label>
          <input type="text" :value="mergedName" :placeholder="defaultMergedName" @input="mergedName = ($event.target as HTMLInputElement).value" />
        </div>
      </div>

      <label class="opt" :class="{ active: mode === 'separate' || !multiple }">
        <input type="radio" value="separate" v-model="mode" :disabled="!multiple" />
        <div>
          <div class="opt-title">各自建立项目{{ !multiple ? '（只有一个可导入文件）' : '' }}</div>
          <div class="hint">每个勾选文件单独建一个项目，项目名取文件名；与已有项目重名时自动追加序号。</div>
        </div>
      </label>

      <div class="summary-line">
        本次将写入：
        <template v-if="mode === 'merged' && multiple">
          <b>1 个项目</b>（{{ includedFiles.length }} 个形状，共 {{ totals.kept }} 条轮廓）
        </template>
        <template v-else>
          <b>{{ includedFiles.length }} 个项目</b>（共 {{ totals.kept }} 条轮廓）
        </template>
        <span v-if="totals.notClosed > 0" class="tag err">含 {{ totals.notClosed }} 条未闭合</span>
        <span v-if="totals.skipped > 0" class="tag warn">跳过 {{ totals.skipped }} 个元素</span>
      </div>

      <div class="btn-row foot">
        <button class="primary" :disabled="includedFiles.length === 0" @click="doConfirm">确认导入（此前不动项目库）</button>
        <button @click="doCancel">取消（仅留档，不导入）</button>
        <span class="spacer"></span>
        <button class="ghost" @click="downloadReport(batch)">下载报告 .txt</button>
      </div>
    </div>

    <!-- 已留档报告：展示当时结论 -->
    <div v-else class="card archived-foot">
      <div v-if="batch.status === 'confirmed'" class="summary-line">
        已于 {{ fmtTs(batch.confirmedAt ?? batch.createdAt) }} 以
        <b>{{ batch.mode === 'merged' ? '合并为一个项目' : '各自建立项目' }}</b>方式导入：
        <span v-for="p in batch.resultProjects" :key="p.id" class="tag ok">{{ p.name }}（{{ p.contourCount }} 轮廓）</span>
      </div>
      <div v-else class="summary-line">
        <span class="tag warn">已取消 / 未导入</span>
        <span class="hint">{{ batch.cancelReason }}</span>
      </div>
      <div class="btn-row foot">
        <button class="ghost" @click="downloadReport(batch)">下载报告 .txt</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.banner {
  padding: 8px 11px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12.5px;
}
.banner.note {
  background: rgba(90, 169, 255, 0.1);
  border: 1px solid rgba(90, 169, 255, 0.4);
  color: #b6d6ff;
}
.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}
.card {
  margin-bottom: 12px;
  padding: 10px;
}
table.files th.r,
table.files td.r {
  text-align: right;
}
table.files td.center {
  text-align: center;
  width: 28px;
}
table.files td.num {
  font-family: var(--mono);
}
table.files td.strong {
  font-weight: 700;
}
.dim {
  color: var(--text-mute);
}
.warn {
  color: var(--warn);
}
.sub {
  font-size: 10.5px;
  color: var(--text-mute);
}
tr.failed td {
  color: var(--err);
}
tr.disabledRow {
  opacity: 0.55;
}
.err-text {
  color: var(--err);
  font-size: 11.5px;
}
.cmp-row td {
  border-bottom: 1px solid var(--line-soft);
  padding: 3px 6px;
}
.detail-cell {
  background: var(--panel-2);
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 8px 4px;
}
.detail-block.wide {
  grid-column: 1 / -1;
}
.detail-block h4 {
  margin: 0 0 5px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  border-bottom: 1px dashed var(--line-soft);
  padding: 2px 0;
}
.kv span {
  color: var(--text-dim);
}
.scale-line {
  font-size: 15px;
  color: var(--accent-2);
}
.plain {
  margin: 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: var(--text-dim);
}
table.mini td {
  white-space: normal;
  vertical-align: top;
}
table.mini td.el {
  color: var(--accent-2);
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.order-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}
.options .section-title {
  margin-bottom: 9px;
}
.options .section-title .hint {
  margin-left: 8px;
}
.opt {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 7px;
  cursor: pointer;
  background: var(--panel-2);
}
.opt.active {
  border-color: var(--accent);
  background: rgba(255, 143, 60, 0.08);
}
.opt input {
  margin-top: 2px;
}
.opt-title {
  font-size: 12.5px;
  font-weight: 600;
}
.rule-box {
  border-left: 2px solid var(--accent);
  background: var(--panel-2);
  border-radius: 0 5px 5px 0;
  padding: 7px 10px;
  margin: -3px 0 8px 22px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.rule-box p {
  margin: 0 0 4px;
}
.merged-name {
  max-width: 320px;
  margin-top: 6px;
}
.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
  margin: 8px 0;
}
.foot .spacer {
  flex: 1 1 auto;
}
</style>
