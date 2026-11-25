import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, readdir, readFile, rm, stat, cp } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
export const FFMPEG = require('ffmpeg-static')
export const FFPROBE = require('ffprobe-static').path
const pexec = promisify(execFile)

export const STICKER_DIM = 512
export const MAX_STICKER_BYTES = 500 * 1024
export const MAX_AUDIO_SEC = 10
export const VISUAL_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.gif', '.webp', '.png', '.jpg', '.jpeg'])
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv'])
export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac'])

/**
 * Computes exact 1:1 square crop coordinates from normalized [0..1] offsets.
 */
export function computeSquareCrop(srcWidth, srcHeight, cropX = 0.5, cropY = 0.5) {
  const safeW = Math.max(1, Math.round(srcWidth))
  const safeH = Math.max(1, Math.round(srcHeight))
  const cropSide = Math.min(safeW, safeH)
  const nx = Number.isFinite(cropX) ? Math.max(0, Math.min(1, cropX)) : 0.5
  const ny = Number.isFinite(cropY) ? Math.max(0, Math.min(1, cropY)) : 0.5
  const srcX = Math.round((safeW - cropSide) * nx)
  const srcY = Math.round((safeH - cropSide) * ny)
  return { srcX, srcY, cropSide, outputSize: STICKER_DIM }
}

/**
 * Normalizes a hex color string to #RRGGBB or returns null for transparent.
 */
export function normalizeMatte(matte) {
  if (!matte || matte === 'transparent') return null
  const m = String(matte).trim().match(/^#?([0-9a-f]{6})$/i)
  return m ? `#${m[1].toUpperCase()}` : null
}

function hexToRgba(hex) {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    alpha: 1
  }
}

export async function probeMedia(src) {
  const { stdout } = await pexec(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', src])
  const j = JSON.parse(stdout)
  const vs = (j.streams || []).find((s) => s.width && s.height) || {}
  const as = (j.streams || []).find((s) => s.codec_type === 'audio') || null
  let fps = 15
  if (vs.avg_frame_rate && vs.avg_frame_rate.includes('/')) {
    const [a, b] = vs.avg_frame_rate.split('/').map(Number)
    if (b) fps = a / b
  } else if (vs.r_frame_rate && vs.r_frame_rate.includes('/')) {
    const [a, b] = vs.r_frame_rate.split('/').map(Number)
    if (b) fps = a / b
  }
  const dur = parseFloat(vs.duration || as?.duration || j.format?.duration || 0) || 0
  return {
    w: vs.width || 0,
    h: vs.height || 0,
    fps,
    dur,
    hasAudio: !!as,
    audioCodec: as?.codec_name || '',
    audioDur: parseFloat(as?.duration || j.format?.duration || 0) || 0
  }
}

export function webpDims(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  let o = 12
  while (o + 8 <= buf.length) {
    const four = buf.toString('ascii', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    const d = o + 8
    if (four === 'VP8X' && d + 10 <= buf.length) {
      return { w: buf.readUIntLE(d + 4, 3) + 1, h: buf.readUIntLE(d + 7, 3) + 1 }
    }
    if (four === 'VP8 ' && d + 10 <= buf.length && buf[d + 3] === 0x9d && buf[d + 4] === 0x01 && buf[d + 5] === 0x2a) {
      return { w: buf.readUInt16LE(d + 6) & 0x3fff, h: buf.readUInt16LE(d + 8) & 0x3fff }
    }
    if (four === 'VP8L' && d + 5 <= buf.length && buf[d] === 0x2f) {
      const b = buf.readUInt32LE(d + 1)
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
    }
    o = d + size + (size % 2)
  }
  return null
}

function buildFilterGraph({ fit, matteHex, cropX, cropY, srcW, srcH, extraPrefix = '' }) {
  const parts = []
  if (extraPrefix) parts.push(extraPrefix)

  if (fit === 'contain') {
    const padColor = matteHex ? `${matteHex}@1` : 'black@0'
    parts.push(
      `scale=${STICKER_DIM}:${STICKER_DIM}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${STICKER_DIM}:${STICKER_DIM}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`
    )
  } else if (srcW > 0 && srcH > 0) {
    const { srcX, srcY, cropSide } = computeSquareCrop(srcW, srcH, cropX, cropY)
    parts.push(
      `crop=${cropSide}:${cropSide}:${srcX}:${srcY}`,
      `scale=${STICKER_DIM}:${STICKER_DIM}:flags=lanczos`
    )
  } else {
    parts.push(
      `scale=${STICKER_DIM}:${STICKER_DIM}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${STICKER_DIM}:${STICKER_DIM}`
    )
  }

  parts.push('format=yuva420p')
  return parts.join(',')
}

async function applyMatteToFrame(pngPath, matteHex) {
  if (!matteHex) return
  const rgb = hexToRgba(matteHex)
  const buf = await sharp(pngPath)
    .flatten({ background: { r: rgb.r, g: rgb.g, b: rgb.b } })
    .png()
    .toBuffer()
  await sharp(buf).toFile(pngPath)
}

async function extractFrames(src, ext, td, { fit, matteHex, cropX, cropY, trimSec }) {
  const info = await probeMedia(src).catch(() => ({ w: 0, h: 0, dur: 0 }))
  const list = async () => (await readdir(td)).filter((f) => f.endsWith('.png')).sort().map((f) => join(td, f))

  if (VIDEO_EXT.has(ext)) {
    const dur = trimSec > 0 && info.dur > 0 ? Math.min(info.dur, trimSec) : info.dur
    const exFps = dur > 0 ? Math.min(30, Math.max(10, Math.ceil(300 / dur))) : 30
    const cut = trimSec > 0 ? ['-t', String(trimSec)] : []
    const vf = buildFilterGraph({
      fit,
      matteHex,
      cropX,
      cropY,
      srcW: info.w,
      srcH: info.h,
      extraPrefix: `fps=${exFps}`
    })
    await pexec(FFMPEG, ['-y', '-v', 'error', '-i', src, ...cut, '-vf', vf, join(td, 'f%04d.png')])
    const files = await list()
    if (matteHex) await Promise.all(files.map((f) => applyMatteToFrame(f, matteHex)))
    return { files, dur: dur || 0, origDur: info.dur || 0 }
  }

  try {
    const vf = buildFilterGraph({ fit, matteHex, cropX, cropY, srcW: info.w, srcH: info.h })
    await pexec(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', vf, join(td, 'f%04d.png')])
    const files = await list()
    if (!files.length) throw new Error('empty')
    if (matteHex) await Promise.all(files.map((f) => applyMatteToFrame(f, matteHex)))
    return { files, dur: info.dur || 0, origDur: info.dur || 0 }
  } catch {
    // Fallback via sharp for animated WebP/GIF that ffmpeg cannot decode directly
    const srcBuf = await readFile(src)
    const meta = await sharp(srcBuf, { animated: true }).metadata()
    const pages = Math.min(meta.pages || 1, 300)
    const files = []
    const rgb = matteHex ? hexToRgba(matteHex) : { r: 0, g: 0, b: 0, alpha: 0 }
    for (let p = 0; p < pages; p++) {
      const out = join(td, `f${String(p).padStart(4, '0')}.png`)
      let sh = sharp(srcBuf, { animated: false, page: p })
      if (fit === 'contain') {
        sh = sh.resize(STICKER_DIM, STICKER_DIM, { fit: 'contain', background: rgb })
      } else if (meta.width && meta.height) {
        const { srcX, srcY, cropSide } = computeSquareCrop(meta.width, meta.height, cropX, cropY)
        sh = sh.extract({ left: srcX, top: srcY, width: cropSide, height: cropSide }).resize(STICKER_DIM, STICKER_DIM)
      } else {
        sh = sh.resize(STICKER_DIM, STICKER_DIM, { fit: 'cover' })
      }
      if (matteHex) sh = sh.flatten({ background: { r: rgb.r, g: rgb.g, b: rgb.b } })
      await sh.png().toFile(out)
      files.push(out)
    }
    const delays = Array.isArray(meta.delay) ? meta.delay : []
    const dur = delays.length ? delays.reduce((a, b) => a + b, 0) / 1000 : 0
    return { files, dur, origDur: dur }
  }
}

async function encodeWebpSeq(seqDir, count, dest, fps, q) {
  await pexec(
    FFMPEG,
    [
      '-y',
      '-v',
      'error',
      '-framerate',
      String(fps),
      '-i',
      join(seqDir, 'f%04d.png'),
      '-frames:v',
      String(count),
      '-c:v',
      'libwebp_anim',
      '-loop',
      '0',
      '-quality',
      String(q),
      '-compression_level',
      '4',
      '-an',
      dest
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
}

/**
 * Converts image/GIF/WebP/video into a WhatsApp-compliant 512x512 WebP <= 500 KB.
 */
export async function convertToSticker(
  src,
  dest,
  { fps: reqFps = 15, fit = 'cover', cropX = 0.5, cropY = 0.5, matte = null, maxDur = MAX_AUDIO_SEC } = {}
) {
  reqFps = Math.max(5, Math.min(24, parseInt(reqFps, 10) || 15))
  fit = fit === 'contain' ? 'contain' : 'cover'
  const matteHex = normalizeMatte(matte)
  const ext = '.' + src.split('.').pop().toLowerCase()
  const td = await mkdtemp(join(tmpdir(), 'stiksound-img-'))

  try {
    const { files: all, dur: srcDur, origDur } = await extractFrames(src, ext, td, {
      fit,
      matteHex,
      cropX,
      cropY,
      trimSec: maxDur
    })
    const total = all.length
    if (!total) throw new Error('No se pudieron extraer frames del archivo.')

    // Static single-frame sticker: fast direct WebP encode
    if (total === 1) {
      for (const q of [85, 70, 50, 35]) {
        const tmpOut = join(td, `static-${q}.webp`)
        await pexec(FFMPEG, [
          '-y',
          '-v',
          'error',
          '-i',
          all[0],
          '-c:v',
          'libwebp',
          '-quality',
          String(q),
          '-an',
          tmpOut
        ])
        const sz = (await stat(tmpOut)).size
        if (sz <= MAX_STICKER_BYTES) {
          await cp(tmpOut, dest)
          return { kb: Math.max(1, Math.round(sz / 1024)), fps: 1, fit, frames: 1, dur: 0, cropped: false, animated: false }
        }
      }
      throw new Error('La imagen supera los 500 KB incluso comprimida.')
    }

    const effDur = Math.min(srcDur > 0 ? srcDur : total / 10, maxDur)
    const clipped = (origDur || srcDur) > maxDur
    const mid = Math.max(8, Math.min(reqFps - 1, Math.floor(reqFps * 0.6)))
    const ladder = [
      [reqFps, 65],
      [reqFps, 50],
      [mid, 50],
      [8, 40],
      [6, 32]
    ]
    const seen = new Set()

    for (const [fps, q] of ladder) {
      const key = `${fps}x${q}`
      if (seen.has(key)) continue
      seen.add(key)
      const count = Math.max(2, Math.min(total, Math.round(effDur * fps)))
      const seq = join(td, `seq-${fps}-${q}`)
      mkdirSync(seq, { recursive: true })
      for (let i = 0; i < count; i++) {
        const si = Math.min(total - 1, Math.floor((i * total) / count))
        await cp(all[si], join(seq, `f${String(i).padStart(4, '0')}.png`))
      }
      const tmpOut = join(td, `out-${fps}-${q}.webp`)
      try {
        await encodeWebpSeq(seq, count, tmpOut, fps, q)
      } catch {
        continue
      }
      const sz = (await stat(tmpOut)).size
      if (sz <= MAX_STICKER_BYTES) {
        const d = webpDims(await readFile(tmpOut))
        if (!d || d.w !== STICKER_DIM || d.h !== STICKER_DIM) {
          throw new Error('La conversión no produjo un WebP de 512x512.')
        }
        await cp(tmpOut, dest)
        return {
          kb: Math.max(1, Math.round(sz / 1024)),
          fps,
          fit,
          frames: count,
          dur: Math.round((count / fps) * 10) / 10,
          clipped,
          animated: true
        }
      }
    }

    throw new Error('El sticker animado superó los 500 KB. Prueba bajar los FPS o recortar la duración.')
  } finally {
    await rm(td, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Converts and trims audio to OGG/Opus mono 48kHz ~48kbps (max 10s).
 */
export async function convertAudio(src, dest, { startMs = 0, durationMs = MAX_AUDIO_SEC * 1000 } = {}) {
  const before = await probeMedia(src).catch(() => ({ hasAudio: false, audioDur: 0 }))
  if (!before.hasAudio) throw new Error('El archivo seleccionado no tiene pista de audio.')

  const safeStartSec = Math.max(0, Number(startMs || 0) / 1000)
  const safeDurSec = Math.max(0.2, Math.min(MAX_AUDIO_SEC, Number(durationMs || MAX_AUDIO_SEC * 1000) / 1000))

  const args = ['-y', '-v', 'error']
  if (safeStartSec > 0) args.push('-ss', safeStartSec.toFixed(3))
  args.push(
    '-i',
    src,
    '-t',
    safeDurSec.toFixed(3),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-f',
    'ogg',
    dest
  )

  await pexec(FFMPEG, args)
  const s = await stat(dest).catch(() => null)
  if (!s || !s.size) throw new Error('No se pudo generar el audio OGG/Opus.')
  const after = await probeMedia(dest)
  if (after.audioCodec !== 'opus' || !(after.audioDur > 0)) {
    throw new Error('El audio convertido no es válido.')
  }
  return {
    dur: Math.round(after.audioDur * 10) / 10,
    kb: Math.max(1, Math.round(s.size / 1024)),
    clipped: before.audioDur > safeDurSec + 0.05
  }
}

/**
 * Exports a compatible MP4 (H.264 + AAC) combining the sticker WebP and its OGG audio sidecar
 * so users can also share or paste it outside WhatsApp Baileys.
 */
export async function exportMp4FromSticker(webpPath, oggPath, outMp4Path) {
  const td = await mkdtemp(join(tmpdir(), 'stiksound-mp4-'))
  try {
    const info = await probeMedia(oggPath)
    const dur = Math.max(1, Math.min(MAX_AUDIO_SEC, info.audioDur || 5))
    const webpBuf = await readFile(webpPath)
    const meta = await sharp(webpBuf, { animated: true }).metadata()
    const pages = Math.max(1, meta.pages || 1)

    if (pages === 1) {
      const pngPath = join(td, 'frame.png')
      await sharp(webpBuf).flatten({ background: { r: 15, g: 14, b: 13 } }).png().toFile(pngPath)
      await pexec(FFMPEG, [
        '-y',
        '-v',
        'error',
        '-loop',
        '1',
        '-i',
        pngPath,
        '-i',
        oggPath,
        '-t',
        dur.toFixed(3),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-movflags',
        '+faststart',
        outMp4Path
      ])
      return
    }

    const delays = Array.isArray(meta.delay) && meta.delay.length ? meta.delay : Array(pages).fill(67)
    const totalMs = delays.reduce((a, b) => a + b, 0) || pages * 67
    const fps = Math.max(5, Math.min(24, Math.round((pages * 1000) / totalMs)))

    for (let p = 0; p < pages; p++) {
      const frameOut = join(td, `f${String(p).padStart(4, '0')}.png`)
      await sharp(webpBuf, { animated: false, page: p })
        .flatten({ background: { r: 15, g: 14, b: 13 } })
        .png()
        .toFile(frameOut)
    }

    await pexec(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-stream_loop',
      '-1',
      '-framerate',
      String(fps),
      '-i',
      join(td, 'f%04d.png'),
      '-i',
      oggPath,
      '-t',
      dur.toFixed(3),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-movflags',
      '+faststart',
      outMp4Path
    ])
  } finally {
    await rm(td, { recursive: true, force: true }).catch(() => {})
  }
}
