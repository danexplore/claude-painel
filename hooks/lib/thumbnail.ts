const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const TAG = /\[Image #(\d+)\]/g
const DEFAULT_COLOR = 0x01000000
const BLANK = 0x20
const LAST_BMP = 0xffff

export const TILE_COLUMNS = 48
export const TILE_ROWS = 14

export type RasterCells = { columns: number; rows: number; cells: string }

export function imageNumbers(draft: string): number[] {
  const numbers = [...draft.matchAll(TAG)].map(match => Number(match[1]))
  return [...new Set(numbers)]
}

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(triple >> 18) & 63]! + BASE64[(triple >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(triple >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[triple & 63]!
  }
  return out
}

/** O comando que desenha a imagem só com blocos, meios-blocos e quadrantes: todos de largura 1 e no BMP, como o Raster exige. */
export function chafaCommand(path: string): string[] {
  return [
    'chafa',
    '--format', 'symbols',
    '--colors', 'full',
    '--symbols', 'block+quad+half+space',
    '--fill', 'none',
    '--dither', 'none',
    '--work', '9',
    '--optimize', '0',
    '--animate', 'off',
    '--polite', 'on',
    '--size', `${TILE_COLUMNS}x${TILE_ROWS}`,
    path,
  ]
}

type Pen = { fg: number; bg: number; isInverse: boolean }

function rgb(params: number[], at: number): number {
  return ((params[at]! & 255) << 16) | ((params[at + 1]! & 255) << 8) | (params[at + 2]! & 255)
}

function applySgr(pen: Pen, params: number[]): Pen {
  let next = { ...pen }
  for (let i = 0; i < params.length; i++) {
    const code = params[i]
    if (code === 0) next = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, isInverse: false }
    else if (code === 7) next.isInverse = true
    else if (code === 27) next.isInverse = false
    else if (code === 39) next.fg = DEFAULT_COLOR
    else if (code === 49) next.bg = DEFAULT_COLOR
    else if ((code === 38 || code === 48) && params[i + 1] === 2) {
      if (code === 38) next.fg = rgb(params, i + 2)
      else next.bg = rgb(params, i + 2)
      i += 4
    }
  }
  return next
}

/** Lê a saída ANSI de cor verdadeira do chafa e monta as células de um Raster. */
export function ansiToCells(ansi: string): RasterCells | null {
  const lines: number[][] = [[]]
  let pen: Pen = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, isInverse: false }
  for (const match of ansi.matchAll(/\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|(\n)|([^\x1b\r\n])/gu)) {
    if (match[1] !== undefined) pen = applySgr(pen, match[1].split(';').filter(Boolean).map(Number))
    else if (match[2]) lines.push([])
    else if (match[3]) {
      const codePoint = match[3].codePointAt(0) ?? BLANK
      const glyph = codePoint > LAST_BMP ? BLANK : codePoint
      const [fg, bg] = pen.isInverse ? [pen.bg, pen.fg] : [pen.fg, pen.bg]
      lines[lines.length - 1]!.push(glyph, fg, bg)
    }
  }
  const rows = lines.filter(line => line.length > 0)
  const columns = Math.max(0, ...rows.map(line => line.length / 3))
  if (rows.length === 0 || columns === 0) return null

  const words = new Uint32Array(columns * rows.length * 3)
  rows.forEach((line, row) => {
    for (let x = 0; x < columns; x++) {
      const at = (row * columns + x) * 3
      words[at] = line[x * 3] ?? BLANK
      words[at + 1] = line[x * 3 + 1] ?? DEFAULT_COLOR
      words[at + 2] = line[x * 3 + 2] ?? DEFAULT_COLOR
    }
  })
  return { columns, rows: rows.length, cells: toBase64(new Uint8Array(words.buffer)) }
}
