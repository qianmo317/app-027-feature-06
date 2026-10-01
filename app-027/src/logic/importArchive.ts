/**
 * 导入报告留档：
 * - 选完文件只解析、不写项目库；报告先落「待确认」档并持久化，关掉页面也能回看
 * - 确认导入后补记决策（合并 / 各自建项目、项目名、生成的项目 id）
 * - 按文件名找到上一次同类导入，逐项对照轮廓数 / 缩放 / 跳过原因是否一致
 * - 报告可导出 Markdown 存档
 */
import type { SkipItem, SkipReason } from './importer'
import { SKIP_REASON_LABEL } from './importer'
import { downloadText, sanitizeFilename } from './download'
import type { CutSettings } from './types'

const LS_KEY = 'papercut-plotter-studio/import-archive/v1'
const MAX_BATCHES = 30
/** 单文件跳过清单最多留多少条，防止超大文件撑爆 localStorage */
const MAX_SKIP_ITEMS = 200

export type FileImportReport = {
  fileName: string
  /** 去掉扩展名的形状建议名 */
  baseName: string
  /** 文件内容指纹（SHA-256，降级时为 FNV-1a 前缀 hash:） */
  contentHash: string
  sizeBytes: number
  subPaths: number
  kept: number
  scale: number
  sizeMm: { w: number; h: number }
  autoClosed: number
  notClosed: number
  selfIntersect: number
  duplicates: number
  dropped: number
  skipped: number
  skippedElements: SkipItem[]
  /** skippedElements 是否超过留档上限被截断 */
  skippedTruncated: boolean
  notes: string[]
}

export type ImportDecision = 'merge' | 'separate' | 'cancelled'

export type ArchivedFile = FileImportReport & {
  /** 确认后记录：合并/独立时的实际形状名（重名改名后） */
  finalShapeName?: string
  projectId?: string
  projectName?: string
}

export type ImportBatch = {
  id: string
  createdAt: number
  decidedAt?: number
  decision?: ImportDecision
  /** merge 时所有文件并入一个项目；separate 时每文件一个项目 */
  projectName?: string
  projectIds: string[]
  files: ArchivedFile[]
  toleranceMm: number
  closeToleranceMm: number
}

type PersistedShape = { version: number; batches: ImportBatch[] }

export type ParsedPayload = {
  fileName: string
  baseName: string
  text: string
  sizeBytes: number
  report: FileImportReport
}

// ---------------- 内容指纹 ----------------

/** FNV-1a 32 位降级哈希（crypto.subtle 不可用时） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `hash:${(h >>> 0).toString(16).padStart(8, '0')}`
}

export async function contentHash(text: string): Promise<string> {
  try {
    const cryptoApi = globalThis.crypto?.subtle
    if (!cryptoApi) return fnv1a(text)
    const buf = await cryptoApi.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(buf))
      .slice(0, 10)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return fnv1a(text)
  }
}

/** 组装单文件留档报告（跳过清单超限时截断） */
export function toFileReport(
  fileName: string,
  baseName: string,
  text: string,
  hash: string,
  r: {
    subPaths: number
    kept: number
    scale: number
    sizeMm: { w: number; h: number }
    skipped: number
    skippedElements: SkipItem[]
    notes: string[]
  },
  cleanup: { autoClosed: number; notClosed: number; selfIntersect: number; duplicates: number; dropped: number },
): FileImportReport {
  const all = r.skippedElements
  const truncated = all.length > MAX_SKIP_ITEMS
  return {
    fileName,
    baseName,
    contentHash: hash,
    sizeBytes: new TextEncoder().encode(text).length,
    subPaths: r.subPaths,
    kept: r.kept,
    scale: r.scale,
    sizeMm: r.sizeMm,
    autoClosed: cleanup.autoClosed,
    notClosed: cleanup.notClosed,
    selfIntersect: cleanup.selfIntersect,
    duplicates: cleanup.duplicates,
    dropped: cleanup.dropped,
    skipped: r.skipped,
    skippedElements: truncated ? all.slice(0, MAX_SKIP_ITEMS) : all,
    skippedTruncated: truncated,
    notes: r.notes,
  }
}

// ---------------- 持久化 ----------------

function read(): ImportBatch[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PersistedShape
    return Array.isArray(parsed.batches) ? parsed.batches : []
  } catch {
    return []
  }
}

function write(batches: ImportBatch[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, batches } satisfies PersistedShape))
  } catch {
    // 配额超限时丢弃最旧的批次再试一次
    if (batches.length > 1) {
      write(batches.slice(0, batches.length - 1))
    }
  }
}

export function listBatches(): ImportBatch[] {
  return read().sort((a, b) => b.createdAt - a.createdAt)
}

export function getBatch(id: string): ImportBatch | undefined {
  return read().find((b) => b.id === id)
}

/** 解析完成即留「待确认」档；返回批次 id，确认/取消后再补记决策 */
export function savePendingBatch(files: FileImportReport[], settings: CutSettings): ImportBatch {
  const batches = read()
  const batch: ImportBatch = {
    id: `ib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    projectIds: [],
    files: files.map((f) => ({ ...f })),
    toleranceMm: settings.toleranceMm,
    closeToleranceMm: settings.closeToleranceMm,
  }
  batches.unshift(batch)
  write(batches.slice(0, MAX_BATCHES))
  return batch
}

export function recordDecision(
  batchId: string,
  decision: Exclude<ImportDecision, 'cancelled'>,
  projectName: string,
  outcomes: Array<{ fileName: string; finalShapeName: string; projectId: string; projectName: string }>,
): void {
  const batches = read()
  const b = batches.find((x) => x.id === batchId)
  if (!b) return
  b.decision = decision
  b.decidedAt = Date.now()
  b.projectName = projectName
  b.projectIds = [...new Set(outcomes.map((o) => o.projectId))]
  for (const o of outcomes) {
    const f = b.files.find((x) => x.fileName === o.fileName)
    if (f) {
      f.finalShapeName = o.finalShapeName
      f.projectId = o.projectId
      f.projectName = o.projectName
    }
  }
  write(batches)
}

export function cancelBatch(batchId: string): void {
  const batches = read()
  const b = batches.find((x) => x.id === batchId)
  if (!b) return
  b.decision = 'cancelled'
  b.decidedAt = Date.now()
  write(batches)
}

export function deleteBatch(batchId: string): void {
  write(read().filter((b) => b.id !== batchId))
}

// ---------------- 与上次同类导入对照 ----------------

export type FileDiff = {
  previous: ArchivedFile
  sameContent: boolean
  changed: Array<{ label: string; before: string; after: string }>
}

/**
 * 找该文件上一次的导入结论：
 * 优先文件名相同且内容不同（正是"同类文件改版后再导"的场景），
 * 内容完全相同也返回，sameContent=true 时界面可直接显示"与上次完全一致"。
 * 只在早于当前批次、且已确认（非取消）的批次里找。
 */
export function findPrevious(file: FileImportReport, excludeBatchId?: string): FileDiff | null {
  const batches = read()
    .filter((b) => b.id !== excludeBatchId && b.decision !== 'cancelled')
    .sort((a, b) => b.createdAt - a.createdAt)
  let prev: ArchivedFile | null = null
  for (const b of batches) {
    const hit = b.files.find((f) => f.fileName === file.fileName)
    if (hit) {
      prev = hit
      break
    }
  }
  if (!prev) return null

  const changed: FileDiff['changed'] = []
  const num = (label: string, before: number, after: number, unit = '') => {
    if (before !== after) changed.push({ label, before: `${before}${unit}`, after: `${after}${unit}` })
  }
  num('保留轮廓', prev.kept, file.kept)
  num('原始子路径', prev.subPaths, file.subPaths)
  if (Math.abs(prev.scale - file.scale) > 1e-6) changed.push({ label: '缩放比例', before: fmtScale(prev.scale), after: fmtScale(file.scale) })
  num('未闭合', prev.notClosed, file.notClosed)
  num('自交', prev.selfIntersect, file.selfIntersect)
  num('重复合并', prev.duplicates, file.duplicates)
  num('自动闭合', prev.autoClosed, file.autoClosed)
  num('退化丢弃', prev.dropped, file.dropped)
  if (prev.skipped !== file.skipped) changed.push({ label: '跳过元素数', before: String(prev.skipped), after: String(file.skipped) })
  if (
    Math.abs(prev.sizeMm.w - file.sizeMm.w) > 0.01 ||
    Math.abs(prev.sizeMm.h - file.sizeMm.h) > 0.01
  ) {
    changed.push({ label: '成品尺寸 mm', before: fmtSize(prev.sizeMm), after: fmtSize(file.sizeMm) })
  }

  // 跳过原因分布对照
  const beforeReasons = reasonCounts(prev.skippedElements)
  const afterReasons = reasonCounts(file.skippedElements)
  for (const key of new Set([...beforeReasons.keys(), ...afterReasons.keys()])) {
    const a = beforeReasons.get(key) ?? 0
    const c = afterReasons.get(key) ?? 0
    if (a !== c) changed.push({ label: `跳过·${SKIP_REASON_LABEL[key]}`, before: `${a} 个`, after: `${c} 个` })
  }

  return { previous: prev, sameContent: prev.contentHash === file.contentHash, changed }
}

function reasonCounts(items: SkipItem[]): Map<SkipReason, number> {
  const m = new Map<SkipReason, number>()
  for (const it of items) m.set(it.reason, (m.get(it.reason) ?? 0) + 1)
  return m
}

// ---------------- 展示 / 导出辅助 ----------------

export function fmtScale(s: number): string {
  if (Math.abs(s - 1) < 1e-9) return '1（无缩放）'
  return `${s}（≈ ${(1 / s).toFixed(4)} SVG 单位/mm）`
}

export function fmtSize(s: { w: number; h: number }): string {
  return `${s.w.toFixed(2)} × ${s.h.toFixed(2)}`
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function decisionLabel(b: ImportBatch): string {
  if (!b.decision) return '待确认'
  if (b.decision === 'merge') return `已合并导入：${b.projectName ?? ''}`
  if (b.decision === 'separate') return `已各自建项目（${b.projectIds.length} 个）`
  return '已取消（未写入项目库）'
}

/** 批次 Markdown 报告（可下载留档） */
export function batchToMarkdown(b: ImportBatch): string {
  const L: string[] = []
  L.push(`# 导入核对报告`)
  L.push('')
  L.push(`- 留档时间：${fmtTime(b.createdAt)}`)
  L.push(`- 文件数量：${b.files.length}`)
  L.push(`- 解析参数：贝塞尔容差 ${b.toleranceMm}mm，闭合判定 ${b.closeToleranceMm}mm`)
  if (b.decision) {
    L.push(`- 处理结果：${decisionLabel(b)}`)
    if (b.decidedAt) L.push(`- 确认时间：${fmtTime(b.decidedAt)}`)
  } else {
    L.push('- 处理结果：待确认（尚未写入项目库）')
  }
  L.push('')
  for (const [i, f] of b.files.entries()) {
    L.push(`## ${i + 1}. ${f.fileName}`)
    L.push('')
    L.push(`- 内容指纹：\`${f.contentHash}\`${f.sizeBytes ? `（${f.sizeBytes} 字节）` : ''}`)
    L.push(`- 原始子路径：${f.subPaths} 条`)
    L.push(`- 保留轮廓：**${f.kept} 条**`)
    L.push(`- 缩放比例：${fmtScale(f.scale)}`)
    L.push(`- 成品尺寸：${fmtSize(f.sizeMm)} mm`)
    L.push(`- 未闭合轮廓：${f.notClosed} 条｜自动闭合：${f.autoClosed} 条｜自交：${f.selfIntersect} 条｜重复合并：${f.duplicates} 条｜退化丢弃：${f.dropped} 条`)
    if (f.finalShapeName) L.push(`- 入库形状名：${f.finalShapeName}${f.projectName ? `（项目：${f.projectName}）` : ''}`)
    if (f.notes.length > 0) {
      L.push('')
      L.push('解析备注：')
      for (const n of f.notes) L.push(`- ${n}`)
    }
    L.push('')
    if (f.skippedElements.length > 0) {
      L.push(`跳过的元素（${f.skipped} 个计入统计，清单 ${f.skippedElements.length} 条${f.skippedTruncated ? '，已截断' : ''}）：`)
      L.push('')
      L.push('| # | 元素 | 原因 | 说明 |')
      L.push('|---|------|------|------|')
      f.skippedElements.forEach((s, j) => {
        L.push(`| ${j + 1} | ${mdCell(s.element)} | ${mdCell(SKIP_REASON_LABEL[s.reason])} | ${mdCell(s.detail)} |`)
      })
      L.push('')
    } else {
      L.push('跳过的元素：无')
      L.push('')
    }
  }
  L.push('---')
  L.push('由 剪纸刻绘刀路生成 生成，仅记录解析结论，不包含图形坐标。')
  return L.join('\n')
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function downloadBatchMarkdown(b: ImportBatch): void {
  const stamp = new Date(b.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const name = `导入报告_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}_${b.files.length}文件.md`
  downloadText(sanitizeFilename(name), batchToMarkdown(b), 'text/markdown;charset=utf-8')
}
