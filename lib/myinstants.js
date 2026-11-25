import { lookup } from 'node:dns/promises'

export const ALLOWED_MYINSTANTS_HOSTS = ['myinstants.com', 'www.myinstants.com']
const DIRECT_MEDIA_PATH_REGEX = /^\/media\/sounds\/[^/]+\.(mp3|wav|ogg|m4a)$/i
const INSTANT_PAGE_PATH_REGEX = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?instant\/[^/]+\/?$/i
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/

const PRIMARY_BUTTON_REGEX =
  /id=["']instant-page-button(?:-element)?["'][^>]*?(?:data-url|onclick)=["'][^"']*?(\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))/i
const DOWNLOAD_LINK_REGEX =
  /href=["'](\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))["'][^>]*?download/i
const MEDIA_PATH_REGEX =
  /(?:https:\/\/(?:www\.)?myinstants\.com)?(\/media\/sounds\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.(?:mp3|wav|ogg|m4a))(?:\?[^"'\s<>)]*)?/i

const OG_TITLE_REGEX = /<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i
const OG_TITLE_REV_REGEX = /<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i
const TITLE_TAG_REGEX = /<title[^>]*>([^<]+)<\/title>/i

const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12000
const MAX_REDIRECTS = 3

export function isPrivateOrReservedIp(ip) {
  const normalized = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!normalized) return true

  if (normalized.includes(':')) {
    if (normalized === '::1' || normalized === '::') return true
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (normalized.startsWith('::ffff:')) {
      return isPrivateOrReservedIp(normalized.slice(7))
    }
    return false
  }

  if (!IPV4_PATTERN.test(normalized)) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts

  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

export function validateMyInstantsUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) throw new Error('URL vacía.')

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('URL inválida.')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Solo se permiten URLs https.')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('No se permiten credenciales en la URL.')
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new Error('Puerto no permitido.')
  }

  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || IPV4_PATTERN.test(host) || host.includes(':')) {
    throw new Error('Host no permitido.')
  }
  if (!ALLOWED_MYINSTANTS_HOSTS.includes(host)) {
    throw new Error(`Dominio no permitido: ${host}. Usa enlaces de myinstants.com.`)
  }
  if (!DIRECT_MEDIA_PATH_REGEX.test(parsed.pathname) && !INSTANT_PAGE_PATH_REGEX.test(parsed.pathname)) {
    throw new Error('El enlace debe ser de un sonido o página /instant/ de MyInstants.')
  }

  return parsed
}

function decodeBasicEntities(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function cleanTitle(rawTitle) {
  if (!rawTitle) return null
  const decoded = decodeBasicEntities(rawTitle)
    .replace(/\s*[-|]\s*(?:Myinstants|Bot[oó]n de sonido|Instant Sound Button|Sound Button).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return decoded ? decoded.slice(0, 120) : null
}

export function extractMyInstantsFromHtml(html) {
  const mediaMatch =
    html.match(PRIMARY_BUTTON_REGEX) ?? html.match(DOWNLOAD_LINK_REGEX) ?? html.match(MEDIA_PATH_REGEX)
  if (!mediaMatch || !mediaMatch[1]) {
    throw new Error('No se encontró el archivo de audio en esa página de MyInstants.')
  }
  const candidateUrl = `https://www.myinstants.com${mediaMatch[1]}`
  const validated = validateMyInstantsUrl(candidateUrl)
  const ogMatch = html.match(OG_TITLE_REGEX) ?? html.match(OG_TITLE_REV_REGEX)
  const titleMatch = html.match(TITLE_TAG_REGEX)
  return {
    title: cleanTitle(ogMatch?.[1] ?? titleMatch?.[1] ?? null),
    mediaUrl: validated.toString()
  }
}

async function assertPublicDns(hostname) {
  const records = await lookup(hostname, { all: true })
  if (!records.length) throw new Error('No se pudo resolver el host.')
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('Dirección IP privada bloqueada.')
    }
  }
}

async function fetchLimitedBytes(targetUrl, maxBytes, fetchFn = globalThis.fetch) {
  let currentUrl = validateMyInstantsUrl(targetUrl).toString()

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = validateMyInstantsUrl(currentUrl)
    await assertPublicDns(parsed.hostname)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    let res
    try {
      res = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'User-Agent': 'Sticker-Sound/1.0' },
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(timer)
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc || i === MAX_REDIRECTS) throw new Error('Demasiadas redirecciones.')
      currentUrl = validateMyInstantsUrl(new URL(loc, currentUrl).toString()).toString()
      continue
    }

    if (!res.ok) throw new Error(`MyInstants respondió HTTP ${res.status}.`)

    const cl = Number(res.headers.get('content-length') || 0)
    if (cl > maxBytes) throw new Error('El archivo remoto supera el límite permitido.')

    const arr = new Uint8Array(await res.arrayBuffer())
    if (arr.byteLength > maxBytes) throw new Error('El cuerpo remoto supera el límite permitido.')
    return Buffer.from(arr)
  }

  throw new Error('Límite de redirecciones excedido.')
}

export async function resolveMyInstantsAudio(rawUrl, fetchFn = globalThis.fetch) {
  const parsed = validateMyInstantsUrl(rawUrl)

  if (DIRECT_MEDIA_PATH_REGEX.test(parsed.pathname)) {
    const buffer = await fetchLimitedBytes(parsed.toString(), MAX_AUDIO_BYTES, fetchFn)
    const filename = parsed.pathname.split('/').pop() || 'myinstants.mp3'
    return { title: filename.replace(/\.[^.]+$/, ''), mediaUrl: parsed.toString(), filename, buffer }
  }

  const normalizedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
  const pageUrl = `${parsed.origin}${normalizedPath}`
  const htmlBuf = await fetchLimitedBytes(pageUrl, MAX_HTML_BYTES, fetchFn)
  const extracted = extractMyInstantsFromHtml(htmlBuf.toString('utf8'))
  const audioBuf = await fetchLimitedBytes(extracted.mediaUrl, MAX_AUDIO_BYTES, fetchFn)
  const filename = new URL(extracted.mediaUrl).pathname.split('/').pop() || 'myinstants.mp3'

  return {
    title: extracted.title || filename.replace(/\.[^.]+$/, ''),
    mediaUrl: extracted.mediaUrl,
    filename,
    buffer: audioBuf
  }
}
