import { createServer } from 'node:http'
import { readFile, writeFile, readdir, stat, mkdir, rm, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import process from 'node:process'

import {
  AUDIO_EXT,
  MAX_AUDIO_SEC,
  VIDEO_EXT,
  VISUAL_EXT,
  convertAudio,
  convertToSticker,
  exportMp4FromSticker,
  probeMedia
} from './lib/media.js'
import { resolveMyInstantsAudio } from './lib/myinstants.js'
import { WhatsAppSession } from './lib/whatsapp.js'

const PORT = Number(process.env.PORT || 3847)
const HOST = process.env.HOST || '127.0.0.1'
const ROOT_DIR = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(ROOT_DIR, 'public')
const AUTH_DIR = join(ROOT_DIR, 'auth')
const STICKERS_DIR = join(ROOT_DIR, 'stickers')

await mkdir(STICKERS_DIR, { recursive: true })

const wa = new WhatsAppSession({
  authDir: AUTH_DIR,
  logger: (...args) => console.log('[WA]', ...args)
})

// Auto-start socket only if an existing paired session exists on disk
if (existsSync(join(AUTH_DIR, 'creds.json'))) {
  wa.ensureSocket().catch(() => {})
}

function sidecarOf(webpName) {
  return webpName.replace(/\.webp$/i, '.ogg')
}

function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42) || `sticker-${Date.now() % 100000}`
  )
}

function sendJson(res, obj, code = 200) {
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  })
  res.end(buf)
}

function sendBytes(res, buf, type, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    ...extraHeaders
  })
  res.end(buf)
}

async function readBody(req, maxBytes = 60 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Archivo demasiado grande (máximo 60 MB).')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Binary-safe multipart/form-data parser using Buffer.indexOf.
 */
function parseMultipart(buf, boundary) {
  const fields = {}
  const files = {}
  const sep = Buffer.from(`--${boundary}`)
  const headerEndSep = Buffer.from('\r\n\r\n')

  let pos = buf.indexOf(sep)
  while (pos !== -1) {
    const afterSep = pos + sep.length
    // End boundary "--"
    if (buf[afterSep] === 0x2d && buf[afterSep + 1] === 0x2d) break

    let partStart = afterSep
    if (buf[partStart] === 0x0d && buf[partStart + 1] === 0x0a) partStart += 2

    const nextPos = buf.indexOf(sep, partStart)
    if (nextPos === -1) break

    // Strip trailing \r\n before next boundary
    let partEnd = nextPos
    if (buf[partEnd - 2] === 0x0d && buf[partEnd - 1] === 0x0a) partEnd -= 2

    const headEnd = buf.indexOf(headerEndSep, partStart)
    if (headEnd !== -1 && headEnd < partEnd) {
      const headersStr = buf.slice(partStart, headEnd).toString('utf8')
      const content = buf.slice(headEnd + 4, partEnd)
      const nameMatch = headersStr.match(/name="([^"]+)"/)
      if (nameMatch) {
        const fieldName = nameMatch[1]
        const fileMatch = headersStr.match(/filename="([^"]*)"/)
        if (fileMatch && fileMatch[1]) {
          files[fieldName] = { filename: fileMatch[1], data: content }
        } else {
          fields[fieldName] = content.toString('utf8')
        }
      }
    }
    pos = nextPos
  }

  return { fields, files }
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    const seg = url.pathname.split('/').filter(Boolean)

    // Static frontend
    if (req.method === 'GET' && !seg[0]?.startsWith('api') && seg[0] !== 'stickers') {
      const rel = url.pathname === '/' ? 'index.html' : seg.join('/')
      const safeRel = basename(rel)
      const filePath = join(PUBLIC_DIR, safeRel)
      const ext = extname(filePath).toLowerCase()
      if (STATIC_MIME[ext] && existsSync(filePath)) {
        return sendBytes(res, await readFile(filePath), STATIC_MIME[ext], { 'Cache-Control': 'no-cache' })
      }
    }

    // Serve generated sticker .webp or .ogg sidecars
    if (req.method === 'GET' && seg[0] === 'stickers' && seg.length === 2) {
      const name = basename(decodeURIComponent(seg[1]))
      const fullPath = join(STICKERS_DIR, name)
      if (!existsSync(fullPath)) {
        res.writeHead(404)
        return res.end()
      }
      if (name.endsWith('.webp')) return sendBytes(res, await readFile(fullPath), 'image/webp')
      if (name.endsWith('.ogg')) return sendBytes(res, await readFile(fullPath), 'audio/ogg')
      res.writeHead(404)
      return res.end()
    }

    // API: WhatsApp status
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, wa.getState())
    }

    // API: Start / reconnect WhatsApp socket (generates QR if not paired)
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      await wa.ensureSocket()
      return sendJson(res, { ok: true, ...wa.getState() })
    }

    // API: Request pairing code by phone number
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
      const result = await wa.requestPairingCode(body.number)
      return sendJson(res, { ok: true, ...result })
    }

    // API: Logout / switch WhatsApp account
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      await wa.logout()
      return sendJson(res, { ok: true })
    }

    // API: Resolve MyInstants audio URL safely server-side
    if (req.method === 'POST' && url.pathname === '/api/myinstants') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
      const resolved = await resolveMyInstantsAudio(body.url)
      const ext = extname(resolved.filename).toLowerCase()
      const mimeType =
        ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg'
      return sendJson(res, {
        ok: true,
        title: resolved.title,
        filename: resolved.filename,
        mediaUrl: resolved.mediaUrl,
        mimeType,
        base64: resolved.buffer.toString('base64')
      })
    }

    // API: List stickers gallery
    if (req.method === 'GET' && url.pathname === '/api/stickers') {
      const entries = (await readdir(STICKERS_DIR)).filter((f) => f.endsWith('.webp'))
      const items = []
      for (const name of entries) {
        const webpStat = await stat(join(STICKERS_DIR, name)).catch(() => null)
        if (!webpStat || !webpStat.size) continue
        const oggName = sidecarOf(name)
        const oggStat = await stat(join(STICKERS_DIR, oggName)).catch(() => null)
        const hasSound = !!(oggStat && oggStat.size > 0)
        items.push({
          name,
          kb: Math.max(1, Math.round(webpStat.size / 1024)),
          hasSound,
          soundKb: hasSound ? Math.max(1, Math.round(oggStat.size / 1024)) : 0,
          mtimeMs: webpStat.mtimeMs
        })
      }
      items.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return sendJson(res, { ok: true, files: items })
    }

    // API: Create sticker (+ optional trimmed OGG/Opus audio sidecar)
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const ct = req.headers['content-type'] || ''
      const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/)
      const boundary = m?.[1] || m?.[2]
      if (!boundary) return sendJson(res, { ok: false, error: 'Solicitud multipart inválida.' }, 400)

      const { fields, files } = parseMultipart(await readBody(req), boundary)
      const mediaFile = files.media
      if (!mediaFile?.data?.length) return sendJson(res, { ok: false, error: 'Falta la imagen, GIF o video.' }, 400)

      const ext = extname(mediaFile.filename).toLowerCase() || '.png'
      if (!VISUAL_EXT.has(ext)) {
        return sendJson(res, { ok: false, error: `Formato visual no soportado (${ext}).` }, 400)
      }

      const audioMode = ['none', 'video', 'file'].includes(fields.audioMode) ? fields.audioMode : 'none'
      const audioFile = files.audio
      const fps = Math.max(5, Math.min(24, parseInt(fields.fps, 10) || 15))
      const fit = fields.fit === 'contain' ? 'contain' : 'cover'
      const cropX = fields.cropX !== undefined ? parseFloat(fields.cropX) : 0.5
      const cropY = fields.cropY !== undefined ? parseFloat(fields.cropY) : 0.5
      const matte = fields.matte || 'transparent'
      const startMs = Math.max(0, parseFloat(fields.audioStartMs) || 0)
      const durationMs = Math.max(200, Math.min(MAX_AUDIO_SEC * 1000, parseFloat(fields.audioDurationMs) || 5000))

      if (audioMode === 'video' && !VIDEO_EXT.has(ext)) {
        return sendJson(res, { ok: false, error: 'El modo "Audio del video" requiere mp4, mov, webm o mkv.' }, 400)
      }
      if (audioMode === 'file') {
        if (!audioFile?.data?.length) return sendJson(res, { ok: false, error: 'Falta el archivo de audio.' }, 400)
        const aext = extname(audioFile.filename).toLowerCase()
        if (!AUDIO_EXT.has(aext)) {
          return sendJson(res, { ok: false, error: `Formato de audio no soportado (${aext}).` }, 400)
        }
      }

      const td = await mkdtemp(join(tmpdir(), 'stiksound-job-'))
      try {
        const srcPath = join(td, `input${ext}`)
        await writeFile(srcPath, mediaFile.data)

        let audioSrcPath = null
        if (audioMode === 'video') {
          const info = await probeMedia(srcPath).catch(() => ({ hasAudio: false }))
          if (!info.hasAudio) {
            return sendJson(res, { ok: false, error: 'El video no contiene pista de audio.' }, 400)
          }
          audioSrcPath = srcPath
        } else if (audioMode === 'file') {
          const aext = extname(audioFile.filename).toLowerCase() || '.mp3'
          audioSrcPath = join(td, `audio${aext}`)
          await writeFile(audioSrcPath, audioFile.data)
        }

        const base = slug(fields.name || mediaFile.filename.replace(/\.[^.]+$/, ''))
        let outName = `${base}.webp`
        let idx = 1
        while (existsSync(join(STICKERS_DIR, outName)) || existsSync(join(STICKERS_DIR, sidecarOf(outName)))) {
          outName = `${base}-${++idx}.webp`
        }

        const destWebp = join(STICKERS_DIR, outName)
        const stickerMeta = await convertToSticker(srcPath, destWebp, {
          fps,
          fit,
          cropX,
          cropY,
          matte,
          maxDur: audioSrcPath ? Math.min(MAX_AUDIO_SEC, durationMs / 1000) : MAX_AUDIO_SEC
        })

        let audioMeta = null
        if (audioSrcPath) {
          const destOgg = join(STICKERS_DIR, sidecarOf(outName))
          try {
            audioMeta = await convertAudio(audioSrcPath, destOgg, { startMs, durationMs })
          } catch (err) {
            await rm(destWebp, { force: true }).catch(() => {})
            await rm(destOgg, { force: true }).catch(() => {})
            return sendJson(res, { ok: false, error: err.message || 'Error al convertir el audio.' }, 400)
          }
        }

        return sendJson(res, {
          ok: true,
          name: outName,
          sticker: stickerMeta,
          audio: audioMeta
        })
      } finally {
        await rm(td, { recursive: true, force: true }).catch(() => {})
      }
    }

    // API: Export sound sticker as MP4 video
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'export' && seg.length === 3) {
      const reqName = basename(decodeURIComponent(seg[2]))
      if (!reqName.endsWith('.mp4')) return sendJson(res, { ok: false, error: 'Formato inválido.' }, 400)
      const webpName = reqName.replace(/\.mp4$/i, '.webp')
      const webpPath = join(STICKERS_DIR, webpName)
      const oggPath = join(STICKERS_DIR, sidecarOf(webpName))
      if (!existsSync(webpPath) || !existsSync(oggPath)) {
        return sendJson(res, { ok: false, error: 'Se requiere un sticker con audio para exportar MP4.' }, 404)
      }
      const td = await mkdtemp(join(tmpdir(), 'stiksound-dl-'))
      try {
        const outMp4 = join(td, reqName)
        await exportMp4FromSticker(webpPath, oggPath, outMp4)
        const data = await readFile(outMp4)
        return sendBytes(res, data, 'video/mp4', {
          'Content-Disposition': `attachment; filename="${reqName}"`
        })
      } finally {
        await rm(td, { recursive: true, force: true }).catch(() => {})
      }
    }

    // API: Delete sticker + sidecar
    if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'stickers' && seg.length === 3) {
      const name = basename(decodeURIComponent(seg[2]))
      const webpPath = join(STICKERS_DIR, name)
      if (!name.endsWith('.webp') || !existsSync(webpPath)) {
        return sendJson(res, { ok: false, error: 'Sticker no encontrado.' }, 404)
      }
      await rm(webpPath, { force: true, maxRetries: 3, retryDelay: 100 })
      await rm(join(STICKERS_DIR, sidecarOf(name)), { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
      return sendJson(res, { ok: true })
    }

    // API: Send sticker (with field-26 audio if present) via WhatsApp Baileys
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
      const name = basename(String(body.name || ''))
      const webpPath = join(STICKERS_DIR, name)
      if (!name.endsWith('.webp') || !existsSync(webpPath)) {
        return sendJson(res, { ok: false, error: 'Sticker no encontrado.' }, 404)
      }
      const oggPath = join(STICKERS_DIR, sidecarOf(name))
      let audioDur = 1
      if (existsSync(oggPath)) {
        const info = await probeMedia(oggPath).catch(() => ({ audioDur: 1 }))
        audioDur = info.audioDur || 1
      }
      const result = await wa.sendSticker({
        target: body.number,
        webpPath,
        oggPath: existsSync(oggPath) ? oggPath : null,
        audioDurationSec: audioDur
      })
      return sendJson(res, { ok: true, ...result })
    }

    res.writeHead(404)
    res.end('Not found')
  } catch (err) {
    console.error('[HTTP ERROR]', err)
    sendJson(res, { ok: false, error: err?.message || 'Error interno del servidor.' }, 500)
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Puerto ${PORT} en uso. Cierra la otra instancia o usa PORT=3848 npm start.`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, HOST, () => {
  console.log(`Sticker Sound listo en http://${HOST}:${PORT}`)
})
