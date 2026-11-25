import { mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import { patchSoundStickerProto, buildSoundStickerMessage } from './sound-sticker.js'

patchSoundStickerProto()

export function phoneOf(jid) {
  const m = String(jid || '').match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/)
  return m ? m[1] : ''
}

export function normalizeTargetJid(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('Número o JID destino vacío.')
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) return trimmed
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 10) throw new Error('Número destino inválido (incluye código de país, ej. 54911...).')
  return `${digits}@s.whatsapp.net`
}

export class WhatsAppSession {
  constructor({ authDir, logger = () => {} }) {
    this.authDir = authDir
    this.log = logger
    this.sock = null
    this.me = null
    this.status = 'off' // off | waiting | on
    this.registered = false
    this.qrText = null
    this.qrDataUrl = null
    this.qrReady = false
    this.pairBusy = false
    this.gen = 0
    this.reconnectTimer = null
    this.reconnectTries = 0
    this.lastCloseAt = 0
    this.lastError = null
  }

  getState() {
    return {
      connected: this.status === 'on',
      status: this.status,
      me: this.me,
      phone: phoneOf(this.me),
      registered: this.registered,
      qrReady: this.qrReady,
      qrDataUrl: this.status === 'on' ? null : this.qrDataUrl,
      lastError: this.lastError
    }
  }

  scheduleReconnect(ms) {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.sock) return
      this.ensureSocket().catch((err) => this.log('reconnect err:', err?.message || err))
    }, ms)
  }

  async ensureSocket() {
    if (this.sock) return this.sock
    await mkdir(this.authDir, { recursive: true })
    let st = await useMultiFileAuthState(this.authDir)

    if (!st.state.creds.registered && (st.state.creds.me || st.state.creds.account)) {
      this.log('Half-paired auth state detected; cleaning auth directory.')
      await rm(this.authDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(this.authDir, { recursive: true })
      st = await useMultiFileAuthState(this.authDir)
    }

    const { state, saveCreds } = st
    this.registered = !!state.creds.registered
    const myGen = ++this.gen
    this.qrReady = false
    this.qrText = null
    this.qrDataUrl = null
    this.lastError = null

    const s = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    })

    this.sock = s
    this.status = 'waiting'
    this.me = null

    s.ev.on('creds.update', (c) => {
      if (c?.registered) this.registered = true
      saveCreds()
    })

    s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (myGen !== this.gen) return

      if (qr) {
        this.qrReady = true
        this.qrText = qr
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 })
        } catch {
          this.qrDataUrl = null
        }
        return
      }

      if (connection === 'open') {
        this.status = 'on'
        this.me = s.user?.id || null
        this.registered = true
        this.reconnectTries = 0
        this.qrReady = false
        this.qrText = null
        this.qrDataUrl = null
        this.lastError = null
        this.log('WhatsApp connected:', this.me)
        return
      }

      if (connection === 'close') {
        this.status = 'off'
        this.me = null
        this.sock = null
        this.qrReady = false
        this.qrText = null
        this.qrDataUrl = null
        this.lastCloseAt = Date.now()
        const code = lastDisconnect?.error?.output?.statusCode
        const msg = lastDisconnect?.error?.message || ''
        this.lastError = code ? `Código ${code}: ${msg}` : msg || null
        this.log('WhatsApp closed:', code, msg)

        if (code === DisconnectReason.loggedOut) {
          await rm(this.authDir, { recursive: true, force: true }).catch(() => {})
          this.registered = false
          this.reconnectTries = 0
          return
        }

        const shouldRestart =
          code === DisconnectReason.restartRequired || code === 428 || code === 408 || code === 503
        const noCode = code === undefined || code === null
        const wait =
          code === DisconnectReason.restartRequired
            ? 300
            : Math.min(15000, 1000 * 2 ** Math.min(this.reconnectTries, 4))

        if ((shouldRestart || noCode) && this.reconnectTries < 20) {
          this.reconnectTries++
          this.scheduleReconnect(wait)
        }
      }
    })

    return s
  }

  async waitQrReady(ms = 25000) {
    const t0 = Date.now()
    while (!this.qrReady && this.status !== 'on' && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 200))
    }
    return this.qrReady || this.status === 'on'
  }

  async waitOpen(ms = 45000) {
    if (this.status === 'on') return
    await this.ensureSocket()
    const t0 = Date.now()
    while (this.status !== 'on' && Date.now() - t0 < ms) {
      if (!this.sock && Date.now() - this.lastCloseAt > 3000) {
        throw new Error(this.lastError || 'La sesión de WhatsApp no está conectada.')
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    if (this.status !== 'on') {
      throw new Error('Tiempo de espera agotado conectando con WhatsApp.')
    }
  }

  async requestPairingCode(phoneInput) {
    const num = String(phoneInput || '').replace(/\D/g, '')
    if (num.length < 10) throw new Error('Número inválido (incluye código de país, ej. 54911...).')
    if (this.pairBusy) throw new Error('Ya se está generando un código, espera un momento.')

    this.pairBusy = true
    try {
      const s = await this.ensureSocket()
      if (this.registered) return { already: true }
      const ready = await this.waitQrReady()
      if (!ready) throw new Error('WhatsApp aún está inicializando el socket. Intenta de nuevo en unos segundos.')
      if (this.status === 'on') return { already: true }
      const code = await s.requestPairingCode(num)
      if (!code) throw new Error('No se recibió código de vinculación.')
      return { already: false, code }
    } finally {
      this.pairBusy = false
    }
  }

  async logout() {
    this.gen++
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sock) {
      try {
        await this.sock.logout()
      } catch {}
      try {
        this.sock.end(undefined)
      } catch {}
      this.sock = null
    }
    this.status = 'off'
    this.me = null
    this.registered = false
    this.qrReady = false
    this.qrText = null
    this.qrDataUrl = null
    this.reconnectTries = 0
    await rm(this.authDir, { recursive: true, force: true }).catch(() => {})
  }

  async resolveCanonicalJid(targetInput) {
    const rawJid = normalizeTargetJid(targetInput)
    if (rawJid.endsWith('@g.us')) return rawJid
    try {
      const [contact] = await this.sock.onWhatsApp(rawJid)
      if (contact && contact.exists === false) {
        throw new Error('Ese número no está registrado en WhatsApp.')
      }
      if (contact?.jid) return contact.jid
    } catch (err) {
      if (err?.message?.includes('no está registrado')) throw err
    }
    return rawJid
  }

  async sendSticker({ target, webpPath, oggPath = null, audioDurationSec = 1 }) {
    await this.waitOpen()
    const jid = await this.resolveCanonicalJid(target)
    const stickerBuf = await readFile(webpPath)

    if (oggPath && existsSync(oggPath)) {
      const audioBuf = await readFile(oggPath)
      const full = await buildSoundStickerMessage({
        jid,
        userJid: this.sock.user.id,
        stickerBuf,
        audioBuf,
        seconds: audioDurationSec,
        upload: this.sock.waUploadToServer
      })
      await this.sock.relayMessage(jid, full.message, { messageId: full.key.id })
      return { jid, withSound: true }
    }

    await this.sock.sendMessage(jid, { sticker: stickerBuf })
    return { jid, withSound: false }
  }
}
