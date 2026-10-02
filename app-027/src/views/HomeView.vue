<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PATTERN_CATEGORIES, PATTERN_LIBRARY, fetchPatternText, type PatternEntry } from '@/data/patterns'
import { store, state } from '@/logic/store'
import { importState, loadImportReports, parseFilesToBatch, deleteArchived, type ImportBatch } from '@/logic/importReports'
import type { Shape } from '@/logic/types'
import { DEFAULT_CUT_SETTINGS } from '@/logic/types'

const router = useRouter()
const category = ref<(typeof PATTERN_CATEGORIES)[number]>('全部')
const busy = ref('')
const notice = ref('')
const error = ref('')
const parsing = ref(false)

const filtered = computed(() =>
  category.value === '全部' ? PATTERN_LIBRARY : PATTERN_LIBRARY.filter((p) => p.category === category.value),
)

const projects = computed(() => state.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt))
const pendingBatch = computed(() => importState.pending)
const archivedBatches = computed(() => importState.archive.slice(0, 20))

onMounted(() => {
  store.loadState()
  loadImportReports()
})

function base(file: string): string {
  return `${import.meta.env.BASE_URL}patterns/${file}`
}

async function newFromPattern(p: PatternEntry): Promise<void> {
  busy.value = p.slug
  error.value = ''
  try {
    const text = await fetchPatternText(p.file)
    const { shape } = store.importSvgToShapes(text, p.name, DEFAULT_CUT_SETTINGS)
    const project = store.createProjectFromShapes(p.name, [shape])
    project.settings.toleranceMm = DEFAULT_CUT_SETTINGS.toleranceMm
    store.recomputeProject(project, true)
    await router.push(`/design/${project.id}`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

/** 选文件：只解析出核对报告并跳转到报告页，确认前不创建任何项目 */
async function onFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return
  if (parsing.value) return
  parsing.value = true
  error.value = ''
  notice.value = ''
  try {
    const batch = await parseFilesToBatch(files)
    const allFailed = batch.files.length > 0 && batch.files.every((f) => !f.ok)
    if (allFailed) error.value = `${batch.files[0].name} 等文件解析失败，报告已生成，可查看原因`
    await router.push('/import')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    parsing.value = false
    const input = document.querySelector<HTMLInputElement>('.file-btn input')
    if (input) input.value = ''
  }
}

function newBlank(): void {
  const project = store.createBlankProject('未命名纹样')
  void router.push(`/design/${project.id}`)
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  void onFiles(e.dataTransfer?.files ?? null)
}

function remove(id: string, name: string): void {
  if (confirm(`删除项目「${name}」？该操作不可撤销。`)) store.deleteProject(id)
  if (state.lastError) error.value = state.lastError
}

function copy(id: string): void {
  const p = store.duplicateProject(id)
  if (p) void router.push(`/design/${p.id}`)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shapeStats(p: { shapes: Shape[] }): string {
  const contours = p.shapes.reduce((a, s) => a + s.contours.length, 0)
  return `${p.shapes.length} 形状 / ${contours} 轮廓`
}

function batchFileNames(b: ImportBatch): string {
  return b.files.map((f) => f.name).join('、')
}

function batchStats(b: ImportBatch): string {
  const ok = b.files.filter((f) => f.ok && f.report)
  const kept = ok.reduce((a, f) => a + (f.report?.kept ?? 0), 0)
  const open = ok.reduce((a, f) => a + (f.report?.notClosed ?? 0), 0)
  const skip = ok.reduce((a, f) => a + (f.report?.skips.length ?? 0), 0)
  const failed = b.files.filter((f) => !f.ok).length
  const parts = [`${ok.length} 文件 / ${kept} 轮廓`]
  if (open) parts.push(`${open} 未闭合`)
  if (skip) parts.push(`跳过 ${skip}`)
  if (failed) parts.push(`${failed} 解析失败`)
  return parts.join('｜')
}

function statusTag(b: ImportBatch): { cls: string; text: string } {
  if (b.status === 'pending') return { cls: 'warn', text: '待核对' }
  if (b.status === 'confirmed') return { cls: 'ok', text: b.mode === 'merged' ? '已合并导入' : '已分别导入' }
  return { cls: 'err', text: '已取消' }
}

function deleteReport(e: Event, id: string): void {
  e.preventDefault()
  e.stopPropagation()
  if (confirm('删除这份导入报告留档？不影响已经创建的项目。')) deleteArchived(id)
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <div class="hero">
        <div>
          <h1>剪纸刻绘刀路生成</h1>
          <p class="hero-sub">
            把剪纸纹样变成刻字机/刻绘机能直接切的刀路：轮廓闭合检查 → 自动留「连刀点」让小纸片不掉 → 按先内后外的顺序切割 → 导出 PLT 直接上机。
          </p>
          <div class="flow">
            <span class="tag">1 导入纹样</span>
            <span class="arrow">→</span>
            <span class="tag">2 清理路径</span>
            <span class="arrow">→</span>
            <span class="tag">3 生成连刀点</span>
            <span class="arrow">→</span>
            <span class="tag">4 排序与跳刀</span>
            <span class="arrow">→</span>
            <span class="tag accent">5 导出 PLT</span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" @click="newBlank">＋ 新建空白纹样</button>
          <label class="btn file-btn">
            {{ parsing ? '解析中…' : '导入 SVG（先出核对报告）' }}
            <input type="file" accept=".svg,image/svg+xml" multiple @change="onFiles(($event.target as HTMLInputElement).files)" />
          </label>
          <span class="hint">支持 path / line / polygon / circle / rect / ellipse 与 transform 变换矩阵；可一次多选，确认前不写入项目库</span>
        </div>
      </div>

      <div v-if="error" class="banner err">{{ error }}</div>
      <div v-if="notice" class="banner ok">{{ notice }}</div>

      <div v-if="pendingBatch" class="card pending-card">
        <div class="pending-row">
          <span class="tag warn">待核对导入</span>
          <span class="grow">
            {{ pendingBatch.files.length }} 个文件已解析完成，报告待你核对后再决定导入方式（当前项目库未改动）。
            <span class="hint">{{ batchFileNames(pendingBatch) }}</span>
          </span>
          <RouterLink class="btn primary" to="/import">去核对 / 选择导入方式 →</RouterLink>
        </div>
      </div>

      <div
        class="dropzone"
        @dragover.prevent
        @drop="onDrop"
      >
        把 SVG 文件拖到这里导入（也可点上面的「导入 SVG」）；一次可拖多个，先出核对报告再确认
      </div>

      <h2 class="sec">内置纹样库（本地打包，离线可用）</h2>
      <div class="cats">
        <button
          v-for="c in PATTERN_CATEGORIES"
          :key="c"
          class="tiny"
          :class="{ active: category === c }"
          @click="category = c"
        >
          {{ c }}
        </button>
      </div>
      <div class="card-grid">
        <div v-for="p in filtered" :key="p.slug" class="pattern-card" @click="newFromPattern(p)">
          <div class="thumb">
            <img :src="base(p.file)" :alt="p.name" />
          </div>
          <div class="meta">
            <div class="n">{{ p.name }}</div>
            <div class="d">{{ p.category }}｜{{ p.desc }}</div>
            <div class="traits">
              <span v-for="t in p.traits" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
          <div class="card-foot">
            <span v-if="busy === p.slug" class="hint">解析中…</span>
            <span v-else class="hint">点此新建项目</span>
          </div>
        </div>
      </div>

      <h2 class="sec">导入报告留档</h2>
      <div v-if="archivedBatches.length === 0" class="empty">
        还没有导入报告。选择 SVG 文件后会先生成核对报告，确认导入或取消都会在这里留档，以后导入同名文件可对照上次结论。
      </div>
      <table v-else class="grid archive-grid">
        <thead>
          <tr>
            <th>时间</th>
            <th>状态</th>
            <th>文件</th>
            <th>解析结论</th>
            <th>方式 / 结果</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in archivedBatches" :key="b.id" class="arch-row" @click="router.push(`/import-report/${b.id}`)">
            <td class="mono">{{ fmtTime(b.confirmedAt ?? b.createdAt) }}</td>
            <td><span class="tag" :class="statusTag(b).cls">{{ statusTag(b).text }}</span></td>
            <td class="names" :title="batchFileNames(b)">
              {{ batchFileNames(b) }}
            </td>
            <td class="mono">{{ batchStats(b) }}</td>
            <td class="names">
              <template v-if="b.status === 'confirmed'">
                <span v-for="p in b.resultProjects" :key="p.id" class="tag ok">{{ p.name }}</span>
              </template>
              <span v-else class="hint">{{ b.cancelReason }}</span>
            </td>
            <td class="row-actions" @click.stop>
              <RouterLink class="tiny" :to="`/import-report/${b.id}`">查看报告</RouterLink>
              <button class="tiny danger" @click="deleteReport($event, b.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <h2 class="sec">我的项目</h2>
      <div v-if="projects.length === 0" class="empty">还没有项目，点上面的纹样卡片或「新建空白纹样」开始。</div>
      <table v-else class="grid">
        <thead>
          <tr>
            <th>名称</th>
            <th>内容</th>
            <th>材料</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td>
              <a href="#" @click.prevent="router.push(`/design/${p.id}`)">{{ p.name }}</a>
            </td>
            <td class="mono">{{ shapeStats(p) }}</td>
            <td>{{ store.materialOf(p)?.name ?? '-' }}</td>
            <td class="mono">{{ fmtTime(p.updatedAt) }}</td>
            <td>
              <div class="btn-row">
                <button class="tiny" @click="router.push(`/design/${p.id}`)">编辑</button>
                <button class="tiny" @click="router.push(`/layout/${p.id}`)">排版</button>
                <button class="tiny" @click="router.push(`/export/${p.id}`)">导出</button>
                <button class="tiny" @click="copy(p.id)">复制</button>
                <button class="tiny danger" @click="remove(p.id, p.name)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  justify-content: space-between;
  background: linear-gradient(120deg, #1c2530, #191f27);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 14px;
}

.hero-sub {
  color: var(--text-dim);
  max-width: 720px;
  font-size: 12.5px;
}

.flow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.arrow {
  color: var(--text-mute);
}

.hero-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: flex-start;
  flex: 0 0 auto;
}

.hero-actions .hint {
  max-width: 220px;
}

.file-btn {
  position: relative;
  overflow: hidden;
}

.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12.5px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}

.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
}

.dropzone {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 14px;
  text-align: center;
  color: var(--text-mute);
  font-size: 12px;
  margin-bottom: 14px;
}

.dropzone:hover {
  border-color: var(--accent);
  color: var(--accent-2);
}

.sec {
  margin: 18px 0 8px;
}

.cats {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.cats button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #1a1206;
  font-weight: 600;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.traits {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 5px;
}

.card-foot {
  border-top: 1px solid var(--line-soft);
  padding: 4px 9px;
  background: var(--panel-2);
}

.pending-card {
  margin-bottom: 12px;
  padding: 10px 12px;
}

.pending-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.pending-row .grow {
  flex: 1 1 auto;
  min-width: 0;
}

.archive-grid .names {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-grid tr.arch-row {
  cursor: pointer;
}

.archive-grid tr.arch-row:hover td {
  background: rgba(255, 143, 60, 0.06);
}

.row-actions {
  white-space: nowrap;
}

.warnCell {
  color: var(--warn);
}
</style>