const UPPER_HALF_BLOCK = 0x2580
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

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
const TAG = /\[Image #(\d+)\]/g

export const TILE_ROWS = 8
export const MAX_TILE_COLUMNS = 48
const MIN_TILE_COLUMNS = 4

export function imageNumbers(draft: string): number[] {
  const numbers = [...draft.matchAll(TAG)].map(match => Number(match[1]))
  return [...new Set(numbers)]
}

/**
 * Cada célula mostra dois pixels empilhados (▀ com frente e fundo), e uma célula do terminal
 * tem o dobro da altura da largura: assim o pixel sai quadrado e a imagem mantém a proporção.
 */
export function tileSize(width: number, height: number): { columns: number; rows: number } {
  const pixelRows = TILE_ROWS * 2
  const columns = Math.round((pixelRows * width) / Math.max(1, height))
  if (columns <= MAX_TILE_COLUMNS) return { columns: Math.max(MIN_TILE_COLUMNS, columns), rows: TILE_ROWS }
  const rows = Math.max(1, Math.round((MAX_TILE_COLUMNS * height) / Math.max(1, width) / 2))
  return { columns: MAX_TILE_COLUMNS, rows }
}

function plainPpmNumbers(ppm: string): number[] {
  return ppm
    .replace(/#[^\n]*/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
}

/** Converte um PPM em texto (P3) de `columns` × `rows*2` pixels nas células de um Raster. */
export function ppmToCells(ppm: string, columns: number, rows: number): string | null {
  if (!ppm.trimStart().startsWith('P3')) return null
  const [width, height, maxValue, ...samples] = plainPpmNumbers(ppm)
  if (width !== columns || height !== rows * 2 || !maxValue) return null
  if (samples.length < width * height * 3) return null

  const scale = 255 / maxValue
  const color = (x: number, y: number) => {
    const at = (y * width + x) * 3
    const [red, green, blue] = [samples[at]!, samples[at + 1]!, samples[at + 2]!].map(value => Math.round(value * scale))
    return (red! << 16) | (green! << 8) | blue!
  }

  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const cell = (row * columns + x) * 3
      words[cell] = UPPER_HALF_BLOCK
      words[cell + 1] = color(x, row * 2)
      words[cell + 2] = color(x, row * 2 + 1)
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}
