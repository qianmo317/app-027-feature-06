import type { Contour, Pt } from './types'
import {
  arcToCubics,
  matApply,
  matIsIdentity,
  matMul,
  matScale,
  matTranslate,
  parseSvgPath,
  parseTransform,
  sampleCubicInto,
  svgLengthToMm,
  type Mat,
  type SubPath,
} from './svg'
import { cleanupContours, type CleanupOptions, type CleanupReport, type RawSub } from './cleanup'

export type ImportSkip = {
  /** 元素在 SVG 中的定位信息：标签 + id/class（能写多少写多少） */
  element: string
  reason: string
}

export type ImportReport = {
  subPaths: number
  kept: number
  skipped: number
  /** 逐条跳过记录（不支持元素 / 背景矩形 / 隐藏元素） */
  skips: ImportSkip[]
  backgroundSkipped: boolean
  hiddenSkipped: number
  scale: number
  /** 缩放比例是怎么算出来的（人话说明） */
  scaleBasis: string
  sizeMm: { w: number; h: number }
  /** 近闭合自动闭合的条数 */
  autoClosed: number
  /** 清理阶段被丢弃的子路径原因（退化/点数不足等） */
  dropReasons: string[]
  notes: string[]
}

export type ImportResult = { contours: Contour[]; cleanup: CleanupReport; report: ImportReport }

const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'symbol', 'title', 'desc', 'style', 'metadata', 'pattern', 'lineargradient', 'radialgradient', 'filter'])

function localName(el: Element): string {
  const n = el.tagName || el.nodeName || ''
  const i = n.indexOf(':')
  return (i >= 0 ? n.slice(i + 1) : n).toLowerCase()
}

function num(el: Element, attr: string, fallback = 0): number {
  const v = el.getAttribute(attr)
  if (v === null) return fallback
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function pointsAttr(el: Element): Pt[] {
  const raw = el.getAttribute('points') || ''
  const nums = raw
    .split(/[\s,]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n))
  const pts: Pt[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] })
  return pts
}

function circleSubPaths(cx: number, cy: number, rx: number, ry: number, tol: number): SubPath[] {
  const pts: Pt[] = []
  const cubics = arcToCubics(cx + rx, cy, rx, ry, 0, true, true, cx - rx, cy)
  const cubics2 = arcToCubics(cx - rx, cy, rx, ry, 0, true, true, cx + rx, cy)
  const all = [...cubics, ...cubics2]
  let cur: Pt = { x: cx + rx, y: cy }
  for (const [c1, c2, end] of all) {
    sampleCubicInto(cur, c1, c2, end, tol, pts)
    cur = end
  }
  return [{ points: pts, closed: true }]
}

function rectSubPaths(el: Element, tol: number): SubPath[] {
  const x = num(el, 'x')
  const y = num(el, 'y')
  const w = num(el, 'width')
  const h = num(el, 'height')
  if (w <= 0 || h <= 0) return []
  let rx = num(el, 'rx', NaN)
  let ry = num(el, 'ry', NaN)
  if (!Number.isFinite(rx) && !Number.isFinite(ry)) {
    return [
      {
        points: [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
        ],
        closed: true,
      },
    ]
  }
  if (!Number.isFinite(rx)) rx = ry
  if (!Number.isFinite(ry)) ry = rx
  rx = Math.min(rx, w / 2)
  ry = Math.min(ry, h / 2)
  const pts: Pt[] = []
  const push = (cur: Pt, cubics: Array<[Pt, Pt, Pt]>) => {
    let c = cur
    for (const [c1, c2, end] of cubics) {
      sampleCubicInto(c, c1, c2, end, tol, pts)
      c = end
    }
  }
  push({ x: x + rx, y }, arcToCubics(x + rx, y, rx, ry, 0, false, true, x + w - rx, y))
  push({ x: x + w - rx, y }, arcToCubics(x + w - rx, y, rx, ry, 0, false, true, x + w, y + ry))
  push({ x: x + w, y: y + ry }, arcToCubics(x + w, y + ry, rx, ry, 0, false, true, x + w, y + h - ry))
  push({ x: x + w, y: y + h - ry }, arcToCubics(x + w, y + h - ry, rx, ry, 0, false, true, x + w - rx, y + h))
  push({ x: x + w - rx, y: y + h }, arcToCubics(x + w - rx, y + h, rx, ry, 0, false, true, x + rx, y + h))
  push({ x: x + rx, y: y + h }, arcToCubics(x + rx, y + h, rx, ry, 0, false, true, x, y + h - ry))
  push({ x, y: y + h - ry }, arcToCubics(x, y + h - ry, rx, ry, 0, false, true, x, y + ry))
  push({ x, y: y + ry }, arcToCubics(x, y + ry, rx, ry, 0, false, true, x + rx, y))
  return [{ points: pts, closed: true }]
}

function elementToSubPaths(el: Element, tol: number): SubPath[] {
  const tag = localName(el)
  switch (tag) {
    case 'path': {
      const d = el.getAttribute('d')
      return d ? parseSvgPath(d, tol) : []
    }
    case 'line':
      return [
        {
          points: [
            { x: num(el, 'x1'), y: num(el, 'y1') },
            { x: num(el, 'x2'), y: num(el, 'y2') },
          ],
          closed: false,
        },
      ]
    case 'polygon': {
      const pts = pointsAttr(el)
      return pts.length >= 3 ? [{ points: pts, closed: true }] : []
    }
    case 'polyline': {
      const pts = pointsAttr(el)
      return pts.length >= 2 ? [{ points: pts, closed: false }] : []
    }
    case 'rect':
      return rectSubPaths(el, tol)
    case 'circle': {
      const r = num(el, 'r')
      return r > 0 ? circleSubPaths(num(el, 'cx'), num(el, 'cy'), r, r, tol) : []
    }
    case 'ellipse': {
      const rx = num(el, 'rx')
      const ry = num(el, 'ry')
      return rx > 0 && ry > 0 ? circleSubPaths(num(el, 'cx'), num(el, 'cy'), rx, ry, tol) : []
    }
    default:
      return []
  }
}

function isHidden(el: Element): boolean {
  const style = (el.getAttribute('style') || '').replace(/\s/g, '')
  if (/display:none/i.test(style) || /visibility:hidden/i.test(style)) return true
  if ((el.getAttribute('display') || '') === 'none') return true
  if ((el.getAttribute('visibility') || '') === 'hidden') return true
  return false
}

/** 元素在报告里的可读定位：`<rect id="bg" class="...">` */
function describeElement(el: Element): string {
  const tag = localName(el)
  const id = el.getAttribute('id')
  const cls = el.getAttribute('class')
  let s = `<${tag}`
  if (id) s += ` id="${id}"`
  if (cls) s += ` class="${cls.split(/\s+/).filter(Boolean).slice(0, 2).join(' ')}"`
  return `${s}>`
}

/**
 * 解析 SVG 文本 → 轮廓。
 * 支持 path / line / polygon / polyline / rect / circle / ellipse，
 * 支持 g / 元素级 transform（matrix/translate/scale/rotate/skewX/skewY）与 viewBox 缩放。
 */
export function importSvgText(text: string, opts: CleanupOptions): ImportResult {
  const notes: string[] = []
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const perr = doc.getElementsByTagName('parsererror')
  const svg = doc.getElementsByTagName('svg')[0] ?? doc.documentElement
  if (!svg || perr.length > 0 || !svg.tagName) {
    throw new Error('SVG 解析失败：文件不是合法的 SVG XML')
  }

  const vbAttr = svg.getAttribute('viewBox')
  let vb = { x: 0, y: 0, w: 0, h: 0 }
  if (vbAttr) {
    const n = vbAttr
      .split(/[\s,]+/)
      .map((s) => Number.parseFloat(s))
      .filter((v) => Number.isFinite(v))
    if (n.length >= 4 && n[2] > 0 && n[3] > 0) vb = { x: n[0], y: n[1], w: n[2], h: n[3] }
  }
  const wMm = svgLengthToMm(svg.getAttribute('width'))
  const hMm = svgLengthToMm(svg.getAttribute('height'))
  let scale = 1
  let scaleBasis: string
  if (vb.w > 0 && wMm && wMm > 0) {
    scale = wMm / vb.w
    scaleBasis = `viewBox 宽 ${vb.w} 单位对应 width=${Math.round(wMm * 100) / 100}mm（1 单位 = ${Math.round(scale * 1e4) / 1e4}mm）`
  } else if (vb.w > 0 && !wMm) {
    scale = 1
    scaleBasis = `有 viewBox（宽 ${vb.w}）但无 width 物理尺寸：按 1 单位 = 1mm`
  } else if (!vb.w && wMm && wMm > 0 && hMm && hMm > 0) {
    scale = 25.4 / 96
    scaleBasis = `无 viewBox，width/height 为像素：按 96dpi 换算（1px = 25.4/96 ≈ 0.2646mm）`
  } else {
    scale = 1
    scaleBasis = '无 viewBox 且无 width/height：按 1 单位 = 1mm'
  }

  const rootMat: Mat = vb.w > 0 ? matMul(matTranslate(-vb.x * scale, -vb.y * scale), matScale(scale, scale)) : matScale(scale, scale)

  const raw: RawSub[] = []
  let subPaths = 0
  let skipped = 0
  let hiddenSkipped = 0
  let backgroundSkipped = false
  const skips: ImportSkip[] = []
  const skipCount = (el: Element, reason: string): void => {
    skipped += 1
    skips.push({ element: describeElement(el), reason })
  }

  const walk = (el: Element, parentMat: Mat, depth: number): void => {
    for (const child of Array.from(el.children)) {
      const tag = localName(child)
      if (SKIP_TAGS.has(tag)) continue
      if (isHidden(child)) {
        hiddenSkipped += 1
        skips.push({ element: describeElement(child), reason: '隐藏元素（display:none 或 visibility:hidden），不参与切割' })
        continue
      }
      const elMat = parseTransform(child.getAttribute('transform'))
      const m = matIsIdentity(elMat) ? parentMat : matMul(parentMat, elMat)

      if (tag === 'g' || tag === 'svg' || tag === 'a') {
        walk(child, m, depth + 1)
        continue
      }
      if (tag === 'text' || tag === 'image' || tag === 'use' || tag === 'tspan') {
        const why =
          tag === 'text' || tag === 'tspan'
            ? '文字元素（text）：本应用不做文字转曲，请先在矢量软件中转成轮廓路径'
            : tag === 'image'
              ? '位图（image）：只支持矢量路径，不做位图描摹'
              : 'use 引用元素：不支持 <use> 展开，请在矢量软件中展开为实体路径'
        skipCount(child, why)
        continue
      }

      // 背景整幅矩形：跳过（避免把画布边框当作切割线）
      if (tag === 'rect' && depth <= 1 && vb.w > 0) {
        const x = num(child, 'x')
        const y = num(child, 'y')
        const w = num(child, 'width')
        const h = num(child, 'height')
        if (Math.abs(x - vb.x) < 0.5 && Math.abs(y - vb.y) < 0.5 && Math.abs(w - vb.w) < 0.5 && Math.abs(h - vb.h) < 0.5) {
          backgroundSkipped = true
          skips.push({ element: describeElement(child), reason: '与 viewBox 等大的整幅背景矩形（画布边框），不参与切割' })
          continue
        }
      }

      const subs = elementToSubPaths(child, opts.toleranceMm)
      if (subs.length === 0) {
        if (tag === 'path') {
          skipCount(child, 'path 元素没有 d 数据（或 d 为空），无路径可解析')
        } else if (tag === 'rect') {
          skipCount(child, 'rect 的 width/height 为 0 或缺失，没有面积')
        } else if (tag === 'circle') {
          skipCount(child, 'circle 的 r 为 0 或缺失')
        } else if (tag === 'ellipse') {
          skipCount(child, 'ellipse 的 rx/ry 为 0 或缺失')
        } else if (tag === 'polygon') {
          skipCount(child, 'polygon 有效顶点不足 3 个')
        } else if (tag === 'polyline') {
          skipCount(child, 'polyline 有效顶点不足 2 个')
        } else if (tag === 'line') {
          skipCount(child, 'line 端点缺失')
        } else {
          skipCount(child, `不支持的元素 <${tag}>，仅支持 path/line/polygon/polyline/rect/circle/ellipse`)
        }
        continue
      }
      for (const sub of subs) {
        subPaths += 1
        raw.push({ points: sub.points.map((p) => matApply(m, p)), closed: sub.closed })
      }
    }
  }

  walk(svg, rootMat, 0)

  const { contours, report: cleanup } = cleanupContours(raw, opts)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of contours) {
    for (const p of c.points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  const sizeMm = Number.isFinite(minX)
    ? { w: Math.round((maxX - minX) * 100) / 100, h: Math.round((maxY - minY) * 100) / 100 }
    : { w: 0, h: 0 }

  if (backgroundSkipped) notes.push('已跳过整幅背景矩形（不参与切割）')
  if (hiddenSkipped > 0) notes.push(`已跳过 ${hiddenSkipped} 个隐藏元素（display/visibility）`)
  if (skipped > 0) notes.push(`已跳过 ${skipped} 个元素（详见报告逐条原因）`)
  if (!vbAttr) notes.push('SVG 无 viewBox：按 1 单位 = 1mm（或 96dpi 尺寸）换算')

  return {
    contours,
    cleanup,
    report: {
      subPaths,
      kept: contours.length,
      skipped,
      skips,
      backgroundSkipped,
      hiddenSkipped,
      scale: Math.round(scale * 10000) / 10000,
      scaleBasis,
      sizeMm,
      autoClosed: cleanup.autoClosed,
      dropReasons: cleanup.dropReasons,
      notes,
    },
  }
}