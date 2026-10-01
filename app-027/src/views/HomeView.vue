<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PATTERN_CATEGORIES, PATTERN_LIBRARY, fetchPatternText, type PatternEntry } from '@/data/patterns'
import { store, state } from '@/logic/store'
import type { Shape } from '@/logic/types'
import { DEFAULT_CUT_SETTINGS } from '@/logic/types'
import ImportReviewModal, { type ParsedImport } from '@/components/ImportReviewModal.vue'
import ImportArchiveDrawer from '@/components/ImportArchiveDrawer.vue'
import {
  cancelBatch,
  contentHash,
  recordDecision,
  savePendingBatch,
  toFileReport,
  type FileImportReport,
  type ImportBatch,
} from '@/logic/importArchive'

const router = useRouter()
const category = ref<(typeof PATTERN_CATEGORIES)[number]>('全部')
const busy = ref('')
const notice = ref('')
const error = ref('')

// ---------------- 导入核对（确认前不写项目库） ----------------
const reviewOpen = ref(false)
const reviewFiles = ref<ParsedImport[]>([])
const reviewBatch = ref<ImportBatch | null>(null)
const archiveRef = ref<InstanceType<typeof ImportArchiveDrawer> | null>(null)

const filtered = computed(() =>
  category.value === '全部' ? PATTERN_LIBRARY : PATTERN_LIBRARY.filter((p) => p.category === category.value),
)

const projects = computed(() => state.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt))

onMounted(() => {
  store.loadState()
})

function base(file: string): string {
  return `${import.meta.env.BASE_URL}patterns/${file}`
}

async function newFromPattern(p: PatternEntry): Promise<void> {
  busy.value = p.slug
  error.value = ''
  try {
    const text = await fetchPatternText(p.file)
    const { result, shape } = store.importSvgToShapes(text, p.name, DEFAULT_CUT_SETTINGS)
    const project = store.createProjectFromShapes(p.name, [shape])
    project.settings.toleranceMm = DEFAULT_CUT_SETTINGS.toleranceMm
    store.recomputeProject(project, true)
    notice.value = `已从内置纹样库新建项目「${p.name}」：${result.contours.length} 条轮廓`
    await router.push(`/design/${project.id}`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

/**
 * 选完文件只做解析并留「待确认」档，不写项目库；
 * 打开核对弹窗，由用户选择合并 / 各自建项目后再 commitImport。
 */
async function onFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return
  error.value = ''
  notice.value = ''
  busy.value = 'import'
  try {
    const parsed: ParsedImport[] = []
    const reports: FileImportReport[] = []
    const failures: string[] = []
    for (const file of Array.from(files)) {
      try {
        const text = await file.text()
        const name = file.name.replace(/\.svg$/i, '')
        const { result, shape } = store.importSvgToShapes(text, name, DEFAULT_CUT_SETTINGS)
        const hash = await contentHash(text)
        const report = toFileReport(
          file.name,
          name,
          text,
          hash,
          {
            subPaths: result.report.subPaths,
            kept: result.report.kept,
            scale: result.report.scale,
            sizeMm: result.report.sizeMm,
            skipped: result.report.skipped,
            skippedElements: result.report.skippedElements,
            notes: result.report.notes,
          },
          result.cleanup,
        )
        reports.push(report)
        parsed.push({ fileName: file.name, baseName: name, shape, report })
      } catch (e) {
        failures.push(`${file.name}：${(e as Error).message}`)
      }
    }
    if (failures.length > 0) error.value = failures.join('；')
    if (parsed.length === 0) return

    const batch = savePendingBatch(reports, DEFAULT_CUT_SETTINGS)
    reviewBatch.value = batch
    reviewFiles.value = parsed
    reviewOpen.value = true
  } finally {
    busy.value = ''
  }
}

function closeReview(): void {
  if (reviewBatch.value) cancelBatch(reviewBatch.value.id)
  reviewOpen.value = false
  reviewBatch.value = null
  reviewFiles.value = []
}

async function confirmImport(payload: { mode: 'merge' | 'separate'; shapeMode: 'single' | 'per_file'; projectName: string }): Promise<void> {
  if (!reviewBatch.value || reviewFiles.value.length === 0) return
  const items = reviewFiles.value.map((f) => ({
    fileName: f.fileName,
    baseName: f.baseName,
    shape: f.shape,
  }))
  const { projects, outcomes } = store.commitImport(items, {
    mode: payload.mode,
    shapeMode: payload.shapeMode,
    projectName: payload.projectName,
  })
  recordDecision(reviewBatch.value.id, payload.mode, payload.projectName, outcomes)
  const totalKept = reviewFiles.value.reduce((a, f) => a + f.report.kept, 0)
  notice.value =
    payload.mode === 'merge'
      ? `已将 ${reviewFiles.value.length} 个文件合并建项「${projects[0]?.name}」，共 ${totalKept} 条轮廓`
      : `已为 ${reviewFiles.value.length} 个文件各自建立项目`
  const target = projects[0]
  reviewOpen.value = false
  reviewBatch.value = null
  reviewFiles.value = []
  if (target) await router.push(`/design/${target.id}`)
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
            导入 SVG
            <input type="file" accept=".svg,image/svg+xml" multiple @change="onFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
          </label>
          <ImportArchiveDrawer ref="archiveRef" @navigate="(id) => router.push(`/design/${id}`)" />
          <span class="hint">选完文件先出核对报告：轮廓数、缩放比例、跳过元素与原因逐条可查，确认后才写入项目库</span>
        </div>
      </div>

      <div v-if="error" class="banner err">{{ error }}</div>
      <div v-if="notice" class="banner ok">{{ notice }}</div>

      <div
        class="dropzone"
        :class="{ busy: busy === 'import' }"
        @dragover.prevent
        @drop="onDrop"
      >
        {{ busy === 'import' ? '正在解析 SVG…（只解析，不写项目库）' : '把 SVG 文件拖到这里导入（也可点上面的「导入 SVG」），解析后先核对报告再决定合并或各自建项目' }}
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

    <ImportReviewModal
      :open="reviewOpen"
      :batch="reviewBatch"
      :files="reviewFiles"
      @close="closeReview"
      @confirm="confirmImport"
    />
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

.dropzone.busy {
  border-color: var(--accent);
  color: var(--accent-2);
}
</style>