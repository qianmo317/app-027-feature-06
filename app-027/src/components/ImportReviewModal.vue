<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  downloadBatchMarkdown,
  findPrevious,
  fmtScale,
  fmtSize,
  type FileDiff,
  type FileImportReport,
  type ImportBatch,
} from '@/logic/importArchive'
import { SKIP_REASON_LABEL, type SkipReason } from '@/logic/importer'
import { store } from '@/logic/store'
import type { Shape } from '@/logic/types'

export type ParsedImport = {
  fileName: string
  baseName: string
  shape: Shape
  report: FileImportReport
}

const props = defineProps<{
  open: boolean
  batch: ImportBatch | null
  files: ParsedImport[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { mode: 'merge' | 'separate'; shapeMode: 'single' | 'per_file'; projectName: string }): void
}>()

const mode = ref<'merge' | 'separate'>('merge')
const shapeMode = ref<'single' | 'per_file'>('per_file')
const projectName = ref('')
const expanded = ref<Set<string>>(new Set())
const skipFilter = ref<SkipReason | 'all'>('all')

watch(
  () => props.open,
  (v) => {
    if (v) {
      mode.value = props.files.length > 1 ? 'merge' : 'separate'
      shapeMode.value = 'per_file'
      projectName.value = props.files.length > 1 ? `合并纹样 ${props.files.length} 拼` : (props.files[0]?.baseName ?? '导入纹样')
      expanded.value = new Set()
      skipFilter.value = 'all'
    }
  },
)

const diffs = computed(() => {
  const m = new Map<string, FileDiff | null>()
  if (!props.batch) return m
  for (const f of props.files) m.set(f.fileName, findPrevious(f.report, props.batch.id))
  return m
})

const totals = computed(() => ({
  kept: props.files.reduce((acc, f) => acc + f.report.kept, 0),
  notClosed: props.files.reduce((acc, f) => acc + f.report.notClosed, 0),
  skipped: props.files.reduce((acc, f) => acc + f.report.skipped, 0),
}))

const reasonOrder: SkipReason[] = ['unsupported_tag', 'hidden', 'background_rect', 'empty_geometry', 'non_render_container']

function reasonCount(f: FileImportReport, r: SkipReason): number {
  return f.skippedElements.filter((s) => s.reason === r).length
}

function filteredSkips(f: ParsedImport) {
  return skipFilter.value === 'all' ? f.report.skippedElements : f.report.skippedElements.filter((s) => s.reason === skipFilter.value)
}

function toggle(name: string): void {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

const nameClashAcrossFiles = computed(() => {
  const seen = new Map<string, number>()
  for (const f of props.files) seen.set(f.baseName, (seen.get(f.baseName) ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([n]) => n)
})

const projectNameTaken = computed(() => store.state.projects.some((p) => p.name === projectName.value.trim()))

function previewName(): string {
  if (mode.value === 'separate') return '每个文件各建 1 个项目'
  if (shapeMode.value === 'single') return `1 个项目「${projectName.value.trim() || '导入纹样'}」/ 1 个形状`
  return `1 个项目「${projectName.value.trim() || '导入纹样'}」/ ${props.files.length} 个形状`
}

function confirm(): void {
  emit('confirm', { mode: mode.value, shapeMode: shapeMode.value, projectName: projectName.value.trim() || props.files[0]?.baseName || '导入纹样' })
}

function exportMd(): void {
  if (props.batch) downloadBatchMarkdown(props.batch)
}

const close = () => emit('close')
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h2>导入核对</h2>
          <div class="sub">{{ files.length }} 个文件已解析完成，尚未写入项目库</div>
        </div>
        <button class="ghost tiny" @click="close">取消</button>
      </div>

      <div class="modal-body">
        <div class="totals">
          <div class="t"><span class="k">文件</span><span class="v">{{ files.length }}</span></div>
          <div class="t"><span class="k">保留轮廓合计</span><span class="v">{{ totals.kept }}</span></div>
          <div class="t"><span class="k">未闭合</span><span class="v" :class="{ warn: totals.notClosed > 0 }">{{ totals.notClosed }}</span></div>
          <div class="t"><span class="k">跳过元素</span><span class="v" :class="{ warn: totals.skipped > 0 }">{{ totals.skipped }}</span></div>
        </div>

        <div class="file-list">
          <div v-for="f in files" :key="f.fileName" class="file-card">
            <div class="file-head" @click="toggle(f.fileName)">
              <span class="caret">{{ expanded.has(f.fileName) ? '▾' : '▸' }}</span>
              <span class="fname">{{ f.fileName }}</span>
              <span class="fc"><b>{{ f.report.kept }}</b> 轮廓</span>
              <span class="fc">比例 <b :class="{ warn: Math.abs(f.report.scale - 1) > 1e-9 }">{{ fmtScale(f.report.scale).split('（')[0] }}</b></span>
              <span v-if="f.report.notClosed > 0" class="chip warn">{{ f.report.notClosed }} 未闭合</span>
              <span v-if="f.report.selfIntersect > 0" class="chip warn">{{ f.report.selfIntersect }} 自交</span>
              <span v-if="f.report.duplicates > 0" class="chip">{{ f.report.duplicates }} 重复已合并</span>
              <span v-if="f.report.skipped > 0" class="chip err">跳过 {{ f.report.skipped }}</span>
              <span v-if="diffs.get(f.fileName)?.sameContent" class="chip ok">与上次内容一致</span>
              <span v-else-if="diffs.get(f.fileName)" class="chip info">同名文件再导·{{ diffs.get(f.fileName)!.changed.length }} 项变化</span>
            </div>

            <div v-if="expanded.has(f.fileName)" class="file-detail">
              <table class="kv">
                <tbody>
                  <tr><td>原始子路径</td><td>{{ f.report.subPaths }} 条</td></tr>
                  <tr><td>保留轮廓</td><td><b>{{ f.report.kept }}</b> 条</td></tr>
                  <tr><td>缩放比例</td><td>{{ fmtScale(f.report.scale) }}</td></tr>
                  <tr><td>成品尺寸</td><td>{{ fmtSize(f.report.sizeMm) }} mm</td></tr>
                  <tr>
                    <td>闭合情况</td>
                    <td>
                      未闭合 <b :class="{ warn: f.report.notClosed > 0 }">{{ f.report.notClosed }}</b> 条
                      ｜首尾相近自动闭合 {{ f.report.autoClosed }} 条
                    </td>
                  </tr>
                  <tr>
                    <td>其他清理</td>
                    <td>自交 {{ f.report.selfIntersect }}｜重复合并 {{ f.report.duplicates }}｜退化丢弃 {{ f.report.dropped }}</td>
                  </tr>
                </tbody>
              </table>

              <div v-if="diffs.get(f.fileName)" class="diff-box">
                <template v-if="diffs.get(f.fileName)!.sameContent">
                  <div class="diff-title ok">✓ 与上一次导入的是同一文件（内容指纹一致），结论可直接对照</div>
                </template>
                <template v-else>
                  <div class="diff-title">与上一次同名文件（{{ diffs.get(f.fileName)!.previous.fileName }}）的结论差异：</div>
                  <table v-if="diffs.get(f.fileName)!.changed.length > 0" class="diff-table">
                    <thead><tr><th>核对项</th><th>上次</th><th>本次</th></tr></thead>
                    <tbody>
                      <tr v-for="(c, ci) in diffs.get(f.fileName)!.changed" :key="ci">
                        <td>{{ c.label }}</td><td class="num">{{ c.before }}</td><td class="num">{{ c.after }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else class="hint">文件名相同、内容已改版，但各项解析结论一致。</div>
                </template>
              </div>

              <div v-if="f.report.notes.length > 0" class="notes">
                <span v-for="(n, ni) in f.report.notes" :key="ni" class="note">· {{ n }}</span>
              </div>

              <div class="skip-head">
                <span>跳过的元素与原因（{{ f.report.skipped }} 个计入统计，清单 {{ f.report.skippedElements.length }} 条<template v-if="f.report.skippedTruncated">，已截断）</template>：</span>
                <select v-if="f.report.skippedElements.length > 0" v-model="skipFilter" class="skip-select">
                  <option value="all">全部原因</option>
                  <option v-for="r in reasonOrder" :key="r" :value="r" :disabled="reasonCount(f.report, r) === 0">
                    {{ SKIP_REASON_LABEL[r] }}（{{ reasonCount(f.report, r) }}）
                  </option>
                </select>
              </div>
              <table v-if="f.report.skippedElements.length > 0" class="skip-table">
                <thead><tr><th>#</th><th>元素（源文件定位）</th><th>原因</th><th>说明</th></tr></thead>
                <tbody>
                  <tr v-for="(s, si) in filteredSkips(f)" :key="si">
                    <td class="num">{{ si + 1 }}</td>
                    <td class="mono ellipsis">{{ s.element }}</td>
                    <td><span class="reason-tag" :data-r="s.reason">{{ SKIP_REASON_LABEL[s.reason] }}</span></td>
                    <td class="dim">{{ s.detail }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="hint ok">无跳过元素。</div>
            </div>
          </div>
        </div>

        <div class="decision card-in">
          <div class="section-title">入库方式（确认前不会改动项目库）</div>
          <div class="mode-grid">
            <label class="mode-opt" :class="{ active: mode === 'merge' }">
              <input type="radio" v-model="mode" value="merge" />
              <div>
                <div class="m-title">合并为一个项目</div>
                <div class="dim">几张拆开的图拼成同一个纹样，在同一项目里统一清理、排序、导出。</div>
              </div>
            </label>
            <label class="mode-opt" :class="{ active: mode === 'separate' }">
              <input type="radio" v-model="mode" value="separate" />
              <div>
                <div class="m-title">各自建立项目</div>
                <div class="dim">{{ files.length }} 个文件分别建 {{ files.length }} 个项目，项目名取文件名，互不影响。</div>
              </div>
            </label>
          </div>

          <div v-if="mode === 'merge'" class="merge-opts">
            <div class="field">
              <label>项目名称</label>
              <input type="text" v-model="projectName" />
              <div v-if="projectNameTaken" class="hint warn">项目库中已有同名项目，确认时将自动改名为「{{ projectName }} -2」。</div>
            </div>
            <div class="field">
              <label>文件与形状的对应</label>
              <label class="radio-line">
                <input type="radio" v-model="shapeMode" value="per_file" />
                <span>每个文件保留为独立形状（推荐：之后仍可单独选中、删除、分层）</span>
              </label>
              <label class="radio-line">
                <input type="radio" v-model="shapeMode" value="single" />
                <span>所有文件轮廓并入同一个形状</span>
              </label>
            </div>

            <div class="rules">
              <div class="rules-title">合并后的处理规则</div>
              <ul>
                <li>
                  <b>轮廓顺序：</b>按文件在上方列表中的顺序（即选择文件的先后）逐文件拼接；
                  每个文件内部保持 SVG 文档顺序。最终切割顺序仍按「先内后外 + 跳刀优化」重排，与轮廓存储顺序无关。
                </li>
                <li>
                  <b>重名处理：</b>同名形状追加 <span class="mono">-2、-3…</span> 后缀；
                  跨文件完全重合的轮廓<b>不做去重</b>（重复路径只在单文件解析时合并），如需要可入库后手动删除。
                </li>
                <li v-if="nameClashAcrossFiles.length > 0" class="warn-li">
                  本次选中的文件存在重名：{{ nameClashAcrossFiles.join('、') }}，入库时会自动加后缀区分。
                </li>
                <li>各文件缩放比例互相独立，坐标不做平移归一化（若各图自带不同坐标系，位置可能重叠，可在编辑页拖动调整）。</li>
              </ul>
            </div>
          </div>

          <div class="preview-line">
            将创建：<b>{{ previewName() }}</b>
            <span class="dim">｜形状名预览：</span>
            <span class="dim mono">{{ files.map((f) => (mode === 'merge' && shapeMode === 'single' ? (projectName || '导入纹样') : f.baseName)).join('、') }}</span>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="ghost" @click="exportMd">⬇ 导出 Markdown 报告</button>
        <span class="hint">报告已留档，取消后仍可在首页「导入报告留档」中回看</span>
        <span class="spacer"></span>
        <button @click="close">取消</button>
        <button class="primary" @click="confirm">确认导入</button>
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
  width: min(940px, 100%);
  max-height: 92vh;
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
  gap: 12px;
}

.modal-foot {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
  border-radius: 0 0 9px 9px;
}

.spacer {
  flex: 1 1 auto;
}

.totals {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.totals .t {
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 7px 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.totals .k {
  font-size: 11px;
  color: var(--text-mute);
}

.totals .v {
  font-family: var(--mono);
  font-size: 16px;
}

.warn {
  color: var(--warn);
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.file-card {
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--bg-grid);
}

.file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  flex-wrap: wrap;
}

.file-head:hover {
  background: rgba(255, 143, 60, 0.06);
}

.caret {
  color: var(--text-mute);
  width: 12px;
}

.fname {
  font-weight: 600;
  font-size: 12.5px;
}

.fc {
  font-size: 11.5px;
  color: var(--text-dim);
}

.fc b {
  font-family: var(--mono);
  color: var(--text);
}

.chip {
  font-size: 10.5px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0 7px;
  color: var(--text-dim);
  background: var(--panel-2);
}

.chip.warn {
  color: var(--warn);
  border-color: rgba(255, 200, 87, 0.4);
}

.chip.err {
  color: var(--err);
  border-color: rgba(255, 107, 107, 0.4);
}

.chip.ok {
  color: var(--ok);
  border-color: rgba(71, 192, 122, 0.45);
}

.chip.info {
  color: var(--info);
  border-color: rgba(90, 169, 255, 0.45);
}

.file-detail {
  border-top: 1px dashed var(--line-soft);
  padding: 9px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

table.kv td {
  padding: 2px 14px 2px 0;
  font-size: 12px;
  vertical-align: top;
}

table.kv td:first-child {
  color: var(--text-mute);
  white-space: nowrap;
}

.diff-box {
  border: 1px solid rgba(90, 169, 255, 0.3);
  background: rgba(90, 169, 255, 0.07);
  border-radius: 6px;
  padding: 7px 9px;
}

.diff-title {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-bottom: 5px;
}

.diff-title.ok {
  color: var(--ok);
}

.diff-table,
.skip-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.diff-table th,
.diff-table td,
.skip-table th,
.skip-table td {
  border-bottom: 1px solid var(--line-soft);
  padding: 3px 6px;
  text-align: left;
}

.diff-table th,
.skip-table th {
  color: var(--text-mute);
  font-weight: 500;
  font-size: 10.5px;
}

.num {
  font-family: var(--mono);
  text-align: right;
  white-space: nowrap;
}

.notes {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.note {
  font-size: 11.5px;
  color: var(--text-dim);
}

.skip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.skip-select {
  width: auto;
  font-size: 11px;
  padding: 2px 5px;
}

.skip-table .mono {
  font-size: 10.5px;
}

.ellipsis {
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim {
  color: var(--text-mute);
  font-size: 11px;
}

.hint.ok {
  color: var(--ok);
}

.reason-tag {
  font-size: 10.5px;
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

.decision.card-in {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px 12px;
  background: var(--panel-2);
}

.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 9px;
}

.mode-opt {
  display: flex;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  background: var(--bg-grid);
}

.mode-opt.active {
  border-color: var(--accent);
  background: rgba(255, 143, 60, 0.09);
}

.m-title {
  font-weight: 600;
  font-size: 12.5px;
  margin-bottom: 2px;
}

.merge-opts {
  display: grid;
  grid-template-columns: minmax(180px, 260px) 1fr;
  gap: 14px;
}

.radio-line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
  cursor: pointer;
}

.rules {
  grid-column: 1 / -1;
  border-top: 1px dashed var(--line-soft);
  padding-top: 8px;
}

.rules-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.rules ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.rules .warn-li {
  color: var(--warn);
}

.preview-line {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--line-soft);
  font-size: 12px;
}

.preview-line .dim {
  font-size: 11px;
}

@media (max-width: 760px) {
  .totals {
    grid-template-columns: repeat(2, 1fr);
  }

  .mode-grid,
  .merge-opts {
    grid-template-columns: 1fr;
  }
}
</style>
