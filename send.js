import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { probeMedia } from './lib/media.js'
import { WhatsAppSession } from './lib/whatsapp.js'

const ROOT_DIR = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const useCode = args.includes('--code')
const cleanArgs = args.filter((a) => !a.startsWith('--'))
const [webpArg, targetArg] = cleanArgs

if (!webpArg || !targetArg) {
  console.log('Uso: node send.js <ruta/sticker.webp> <numero-con-ddi> [--code]')
  process.exit(1)
}

if (!existsSync(webpArg)) {
  console.error('No se encontró el archivo:', webpArg)
  process.exit(1)
}

const oggArg = webpArg.replace(/\.webp$/i, '.ogg')
const hasSound = existsSync(oggArg)

const wa = new WhatsAppSession({
  authDir: join(ROOT_DIR, 'auth'),
  logger: (...m) => console.log('[WA]', ...m)
})

await wa.ensureSocket()

if (!wa.registered && useCode) {
  const selfNum = process.env.WA_NUMBER || ''
  if (!selfNum) {
    console.error('Define WA_NUMBER=54911... para emparejar con código desde CLI, o usa el panel web.')
    process.exit(1)
  }
  const res = await wa.requestPairingCode(selfNum)
  if (res.code) console.log('Código de vinculación:', res.code)
}

await wa.waitOpen(90000)

let dur = 1
if (hasSound) {
  const info = await probeMedia(oggArg).catch(() => ({ audioDur: 1 }))
  dur = info.audioDur || 1
}

const sent = await wa.sendSticker({
  target: targetArg,
  webpPath: webpArg,
  oggPath: hasSound ? oggArg : null,
  audioDurationSec: dur
})

console.log(`Sticker enviado a ${sent.jid} (con audio: ${sent.withSound})`)
process.exit(0)
