import { reactive } from 'vue'
import type { Shape } from './types'
import { DEFAULT_CUT_SETTINGS } from './types'
import { importSvgText, type ImportReport } from './importer'
import { uid } from './geometry'
import { downloadText, sanitizeFilename } from './download'
import { store } from './store'

/**
 * 导入核对报告：
 * - 选文件后只解析、只出报告，不动项目库；轮廓暂存在「待确认」批次里（sessionStorage）。
 * - 用户在报告页核对跳过原因/缩放/未闭合数，并选择合并为一个项目或各自建项目后，才写入项目库。
 * - 每一批（确认导入 / 取消）都留档到 localStorage，以后导入同名文件时自动取上一次结论对照。
 */

const ARCHIVE_KEY = 'papercut-plotter-studio/import-reports/v1'
const PENDING_KEY = 'papercut-plotter-studio/import-pending/v1'
const ARCHIVE_LIMIT = 50

export type ImportMode = 'merged' | 'separate'
export type BatchStatus = 'pending' | 'confirmed' | 'cancelled'

/** 报告页需要展示的解析结论（不含几何点数据，可留档） */
export type FileReportSnapshot = {
  subPaths: number
  kept: number
  skipped: number
  skips: ImportReport['skips']
  backgroundSkipped: boolean
  hiddenSkipped: number
  scale: number
  scaleBasis: string
  sizeMm: { w: number; h: number }
  autoClosed: number
  notClosed: number
  selfIntersect: number
  duplicates: number
  dropped: number
  dropReasons: string[]
  notes: string[]
}

export type FileImportRecord = {
  /** 报告内稳定标识（重排/留档后仍可用） */
  rid: string
  name: string
  sizeBytes: number
  /** 是否纳入确认（解析失败的文件默认不勾选） */
  included: boolean
  ok: boolean
  error?: string
  /** 仅待确认批次保留几何形状；留档时剥离 */
  shape?: Shape
  report?: FileReportSnapshot
}

export type ResultProject = { id: string; name: string; shapeCount: number; contourCount: number }

export type ImportBatch = {
  id: string
  createdAt: number
  confirmedAt?: number
  status: BatchStatus
  /** 确认时选择的方式（留档用） */
  mode?: ImportMode
  mergedName?: string
  files: FileImportRecord[]
  resultProjects?: ResultProject[]
  cancelReason?: string
}

type BatchState = {
  pending: ImportBatch | null
  archive: ImportBatch[]
  ready: boolean
}

export const importState = reactive<BatchState>({
  pending: null,
  archive: [],
  ready: false,
})

// ---------------- 持久化 ----------------

function storageOf(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage
  } catch {
    return null
  }
}

/** 留档版本：剥掉几何形状（点数据只属于待确认阶段） */
function toArchived(batch: ImportBatch): ImportBatch {
  const clone: ImportBatch = JSON.parse(JSON.stringify(batch))
  for (const f of clone.files) delete f.shape
  return clone
}

function persistPending(): void {
  const s = storageOf('session')
  if (!s) return
  try {
    if (importState.pending) s.setItem(PENDING_KEY, JSON.stringify(importState.pending))
    else s.removeItem(PENDING_KEY)
  } catch {
    // 配额不足（大文件点数据过多）时保留内存中的待确认批次，仅无法跨刷新
  }
}

function persistArchive(): void {
  const s = storageOf('local')
  if (!s) return
  try {
    s.setItem(ARCHIVE_KEY, JSON.stringify(importState.archive.slice(0, ARCHIVE_LIMIT)))
  } catch (e) {
    store.state.lastError = `导入报告留档失败：${(e as Error).message}`
  }
}

export function loadImportReports(): void {
  const ls = storageOf('local')
  if (ls) {
    try {
      const raw = ls.getItem(ARCHIVE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) importState.archive = parsed.filter((b) => b && b.status !== 'pending')
      }
    } catch {
      /* 损坏的留档忽略 */
    }
  }
  const ss = storageOf('session')
  if (ss) {
    try {
      const raw = ss.getItem(PENDING_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ImportBatch
        if (parsed && parsed.status === 'pending' && Array.isArray(parsed.files)) importState.pending = parsed
      }
    } catch {
      /* 忽略损坏的待确认数据 */
    }
  }
  importState.ready = true
}

// ---------------- 解析（不动项目库） ----------------

function snapshotOf(r: ImportReport, cleanup: { notClosed: number; selfIntersect: number; duplicates: number; dropped: number }): FileReportSnapshot {
  return {
    subPaths: r.subPaths,
    kept: r.kept,
    skipped: r.skipped,
    skips: r.skips,
    backgroundSkipped: r.backgroundSkipped,
    hiddenSkipped: r.hiddenSkipped,
    scale: r.scale,
    scaleBasis: r.scaleBasis,
    sizeMm: r.sizeMm,
    autoClosed: r.autoClosed,
    notClosed: cleanup.notClosed,
    selfIntersect: cleanup.selfIntersect,
    duplicates: cleanup.duplicates,
    dropped: cleanup.dropped,
    dropReasons: r.dropReasons,
    notes: r.notes,
  }
}

/**
 * 解析一组 File → 待确认批次。
 * 只做解析与报告生成，绝不创建/修改项目。同一时刻只保留一个待确认批次，
 * 之前未处理的批次自动以「已取消（被新导入取代）」留档。
 */
export async function parseFilesToBatch(fileList: ArrayLike<File>): Promise<ImportBatch> {
  if (importState.pending) archiveCurrent('cancelled', '新导入开始，上一份未确认的报告自动作废')

  const files: FileImportRecord[] = []
  for (const file of Array.from(fileList)) {
    const rec: FileImportRecord = {
      rid: uid('f'),
      name: file.name,
      sizeBytes: file.size,
      included: true,
      ok: false,
    }
    try {
      const text = await file.text()
      const result = importSvgText(text, {
        toleranceMm: DEFAULT_CUT_SETTINGS.toleranceMm,
        closeToleranceMm: DEFAULT_CUT_SETTINGS.closeToleranceMm,
      })
      const baseName = file.name.replace(/\.svg$/i, '')
      rec.shape = { id: uid('s'), name: baseName, contours: result.contours, layer: 0 }
      rec.report = snapshotOf(result.report, result.cleanup)
      rec.ok = true
    } catch (e) {
      rec.ok = false
      rec.included = false
      rec.error = (e as Error).message
    }
    files.push(rec)
  }

  const batch: ImportBatch = { id: uid('b'), createdAt: Date.now(), status: 'pending', files }
  importState.pending = batch
  persistPending()
  return batch
}

export function getBatch(id: string): ImportBatch | null {
  if (importState.pending?.id === id) return importState.pending
  return importState.archive.find((b) => b.id === id) ?? null
}

// ---------------- 报告页操作（仍然不碰项目库，直到确认） ----------------

export function setIncluded(rid: string, included: boolean): void {
  const b = importState.pending
  if (!b) return
  const f = b.files.find((x) => x.rid === rid)
  if (f && f.ok) {
    f.included = included
    persistPending()
  }
}

/** 合并模式下调整文件先后（轮廓按此顺序拼接） */
export function moveFile(rid: string, dir: -1 | 1): void {
  const b = importState.pending
  if (!b) return
  const i = b.files.findIndex((x) => x.rid === rid)
  const j = i + dir
  if (i < 0 || j < 0 || j >= b.files.length) return
  const [item] = b.files.splice(i, 1)
  b.files.splice(j, 0, item)
  persistPending()
}

function uniqueProjectName(base: string): string {
  const existing = new Set(store.state.projects.map((p) => p.name))
  if (!existing.has(base)) return base
  for (let i = 2; ; i += 1) {
    const cand = `${base} ${i}`
    if (!existing.has(cand)) return cand
  }
}

/**
 * 确认导入：此刻才写入项目库。
 * - merged：勾选文件按当前顺序拼成一个项目，每个文件是一个形状（重名形状追加序号）。
 * - separate：每个勾选文件各自建项目（与已有项目重名追加序号）。
 */
export function confirmBatch(mode: ImportMode, mergedName: string): { batch: ImportBatch; projects: ResultProject[] } {
  const b = importState.pending
  if (!b) throw new Error('没有待确认的导入')
  const chosen = b.files.filter((f) => f.included && f.ok && f.shape)
  if (chosen.length === 0) throw new Error('请先勾选至少一个解析成功的文件')

  const results: ResultProject[] = []
  const shapeOf = (f: FileImportRecord): Shape => JSON.parse(JSON.stringify(f.shape)) as Shape

  if (mode === 'merged' || chosen.length === 1) {
    const usedNames = new Set<string>()
    const shapes: Shape[] = chosen.map((f) => {
      const s = shapeOf(f)
      let name = s.name
      if (usedNames.has(name)) {
        for (let i = 2; ; i += 1) {
          const cand = `${s.name} ${i}`
          if (!usedNames.has(cand)) {
            name = cand
            break
          }
        }
      }
      usedNames.add(name)
      s.name = name
      return s
    })
    const base = mergedName.trim() || (chosen.length === 1 ? chosen[0].shape!.name : `导入 ${chosen.length} 个纹样`)
    const project = store.createProjectFromShapes(uniqueProjectName(base), shapes)
    results.push({ id: project.id, name: project.name, shapeCount: shapes.length, contourCount: countContours(shapes) })
    b.mode = chosen.length === 1 ? 'separate' : 'merged'
    b.mergedName = project.name
  } else {
    for (const f of chosen) {
      const s = shapeOf(f)
      const project = store.createProjectFromShapes(uniqueProjectName(s.name), [s])
      results.push({ id: project.id, name: project.name, shapeCount: 1, contourCount: s.contours.length })
    }
    b.mode = 'separate'
  }

  b.status = 'confirmed'
  b.confirmedAt = Date.now()
  b.resultProjects = results
  archiveCurrent('confirmed')
  return { batch: b, projects: results }
}

function countContours(shapes: Shape[]): number {
  return shapes.reduce((a, s) => a + s.contours.length, 0)
}

/** 取消待确认导入（项目库不变），报告仍留档 */
export function cancelPending(reason = '用户取消，未写入项目库'): void {
  if (!importState.pending) return
  archiveCurrent('cancelled', reason)
}

function archiveCurrent(status: BatchStatus, cancelReason?: string): void {
  const b = importState.pending
  if (!b) return
  b.status = status
  if (status === 'cancelled') b.cancelReason = cancelReason
  importState.archive.unshift(toArchived(b))
  if (importState.archive.length > ARCHIVE_LIMIT) importState.archive.length = ARCHIVE_LIMIT
  importState.pending = null
  persistPending()
  persistArchive()
}

export function deleteArchived(id: string): void {
  const i = importState.archive.findIndex((b) => b.id === id)
  if (i >= 0) {
    importState.archive.splice(i, 1)
    persistArchive()
  }
}

// ---------------- 与上一次对照 ----------------

export type FieldDelta = { prev: number; cur: number; delta: number }
export type FileComparison = {
  batchId: string
  batchDate: number
  prev: FileReportSnapshot
  kept: FieldDelta
  notClosed: FieldDelta
  selfIntersect: FieldDelta
  duplicates: FieldDelta
  scale: FieldDelta
  identical: boolean
}

function delta(prev: number, cur: number): FieldDelta {
  return { prev, cur, delta: Math.round((cur - prev) * 1e6) / 1e6 }
}

/** 找同名文件最近一次的解析结论（任何状态的留档都算），用于再导入时对照 */
export function compareWithLast(fileName: string): FileComparison | null {
  for (const b of importState.archive) {
    const f = b.files.find((x) => x.name === fileName && x.ok && x.report)
    if (f?.report) {
      const prev = f.report
      const cur = importState.pending?.files.find((x) => x.name === fileName)?.report
      if (!cur) return null
      const cmp: FileComparison = {
        batchId: b.id,
        batchDate: b.confirmedAt ?? b.createdAt,
        prev,
        kept: delta(prev.kept, cur.kept),
        notClosed: delta(prev.notClosed, cur.notClosed),
        selfIntersect: delta(prev.selfIntersect, cur.selfIntersect),
        duplicates: delta(prev.duplicates, cur.duplicates),
        scale: delta(prev.scale, cur.scale),
        identical: false,
      }
      cmp.identical =
        cmp.kept.delta === 0 &&
        cmp.notClosed.delta === 0 &&
        cmp.selfIntersect.delta === 0 &&
        cmp.duplicates.delta === 0 &&
        cmp.scale.delta === 0
      return cmp
    }
  }
  return null
}

// ---------------- 报告导出（纯文本留档） ----------------

export const MERGE_ORDER_NOTE =
  '合并后轮廓顺序：按报告中文件的先后顺序（可用 ↑/↓ 调整）逐文件拼接；同一文件内保持 SVG 元素出现顺序。'
export const CUT_ORDER_NOTE = '实际切割顺序在生成刀路时按「先内后外 + 最近邻/2-opt」重排，与导入拼接顺序无关。'
export const DUPLICATE_NAME_NOTE = '重名处理：形状名（取文件名）冲突时自动追加「 2 / 3 …」序号；项目名与已有项目冲突同样追加序号；轮廓使用内部唯一编号，无重名冲突。'

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function reportToText(b: ImportBatch): string {
  const lines: string[] = []
  const statusLabel = b.status === 'pending' ? '待确认' : b.status === 'confirmed' ? '已确认导入' : '已取消'
  lines.push('剪纸刻绘 · SVG 导入核对报告')
  lines.push('────────────────────────')
  lines.push(`生成时间：${fmtTs(b.createdAt)}　状态：${statusLabel}`)
  if (b.status === 'confirmed') {
    lines.push(`导入方式：${b.mode === 'merged' ? '合并为一个项目' : '各自建立项目'}${b.mergedName ? `　项目：${b.mergedName}` : ''}`)
    for (const p of b.resultProjects ?? []) lines.push(`　· ${p.name}：${p.shapeCount} 形状 / ${p.contourCount} 轮廓`)
  }
  if (b.status === 'cancelled' && b.cancelReason) lines.push(`说明：${b.cancelReason}`)
  lines.push('')
  b.files.forEach((f, i) => {
    lines.push(`[${i + 1}] ${f.name}（${f.sizeBytes} 字节）`)
    if (!f.ok || !f.report) {
      lines.push(`　解析失败：${f.error ?? '未知错误'}`)
      lines.push('')
      return
    }
    const r = f.report
    lines.push(`　解析子路径：${r.subPaths}　保留轮廓：${r.kept}　未闭合：${r.notClosed}　自交：${r.selfIntersect}　重复已合并：${r.duplicates}　近闭合自动闭合：${r.autoClosed}　清理丢弃：${r.dropped}`)
    lines.push(`　缩放比例：${r.scale}（${r.scaleBasis}）`)
    lines.push(`　成品尺寸：${r.sizeMm.w} × ${r.sizeMm.h} mm`)
    if (r.notes.length) lines.push(`　备注：${r.notes.join('；')}`)
    if (r.skips.length) {
      lines.push(`　跳过元素 ${r.skips.length} 个：`)
      for (const s of r.skips) lines.push(`　　- ${s.element}　原因：${s.reason}`)
    } else {
      lines.push('　跳过元素：无')
    }
    if (r.dropReasons.length) {
      lines.push(`　清理阶段丢弃 ${r.dropReasons.length} 条子路径：`)
      for (const d of r.dropReasons) lines.push(`　　- ${d}`)
    }
    lines.push('')
  })
  if (b.files.length > 1) {
    lines.push(MERGE_ORDER_NOTE)
    lines.push(CUT_ORDER_NOTE)
    lines.push(DUPLICATE_NAME_NOTE)
  }
  return lines.join('\n')
}

export function downloadReport(b: ImportBatch): void {
  downloadText(`导入报告-${sanitizeFilename(b.files[0]?.name ?? 'batch')}-${b.id.slice(0, 6)}.txt`, reportToText(b))
}
