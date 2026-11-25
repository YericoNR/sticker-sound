const $ = (id) => document.getElementById(id)

const state = {
  mediaFile: null,
  mediaUrl: null,
  isVideo: false,
  mediaW: 0,
  mediaH: 0,
  fit: 'cover',
  cropX: 0.5,
  cropY: 0.5,
  matte: 'transparent',
  audioMode: 'none', // none | file | video
  audioFile: null,
  audioTitle: '',
  audioDurationMs: 0,
  audioStartMs: 0,
  maxWinMs: 5000,
  peaks: [],
  playing: false,
  audioEl: null,
  playTimer: null,
  selectedSticker: null,
  gallery: [],
  busy: false
}

function toast(msg, isError = false) {
  const el = $('toast')
  el.textContent = msg
  el.className = `toast show${isError ? ' error' : ''}`
  clearTimeout(el._t)
  el._t = setTimeout(() => {
    el.className = 'toast'
  }, 3400)
}

function formatSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

// ---------- WhatsApp Status & Pairing ----------
async function refreshStatus() {
  try {
    const res = await fetch('/api/status')
    const j = await res.json()
    const dot = $('statusDot')
    const txt = $('statusText')

    if (j.connected) {
      dot.className = 'dot on'
      txt.textContent = `Conectado · ${j.phone || j.me || ''}`
      $('logoutBtn').hidden = false
      $('connPanel').hidden = true
      if (j.phone && !$('targetPhone').value) $('targetPhone').value = j.phone
    } else if (j.registered) {
      dot.className = 'dot waiting'
      txt.textContent = 'Sincronizando sesión…'
      $('logoutBtn').hidden = false
    } else {
      dot.className = 'dot'
      txt.textContent = j.qrReady ? 'Esperando vinculación' : 'Desconectado'
      $('logoutBtn').hidden = true
      if (j.qrDataUrl) {
        $('qrImg').src = j.qrDataUrl
        $('qrBox').hidden = false
      }
    }
  } catch {}
}

$('toggleConnBtn').onclick = () => {
  $('connPanel').hidden = !$('connPanel').hidden
}
$('closeConnBtn').onclick = () => {
  $('connPanel').hidden = true
}

document.querySelectorAll('[data-conn-tab]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-conn-tab]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    const tab = btn.dataset.connTab
    $('connTabCode').hidden = tab !== 'code'
    $('connTabQr').hidden = tab !== 'qr'
  }
})

$('pairCodeBtn').onclick = async () => {
  const num = $('pairPhone').value.replace(/\D/g, '')
  if (num.length < 10) return toast('Ingresa un número válido con DDI (ej: 54911...).', true)
  $('pairCodeBtn').disabled = true
  $('pairCodeBtn').textContent = 'Generando…'
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: num })
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error)
    if (j.already) {
      toast('La sesión ya está vinculada.')
      refreshStatus()
      return
    }
    $('pairCodeBox').textContent = j.code.length === 8 ? `${j.code.slice(0, 4)}-${j.code.slice(4)}` : j.code
    $('pairCodeBox').hidden = false
    $('pairCodeHint').hidden = false
    toast('Código generado. Ingrésalo en tu WhatsApp.')
  } catch (err) {
    toast(err.message, true)
  } finally {
    $('pairCodeBtn').disabled = false
    $('pairCodeBtn').textContent = 'Generar código'
  }
}

$('genQrBtn').onclick = async () => {
  $('genQrBtn').disabled = true
  try {
    await fetch('/api/connect', { method: 'POST' })
    toast('Generando código QR…')
    setTimeout(refreshStatus, 1200)
    setTimeout(refreshStatus, 2800)
  } catch (err) {
    toast(err.message, true)
  } finally {
    $('genQrBtn').disabled = false
  }
}

$('logoutBtn').onclick = async () => {
  if (!confirm('¿Desvincular esta cuenta de WhatsApp?')) return
  await fetch('/api/logout', { method: 'POST' })
  $('pairCodeBox').hidden = true
  $('qrBox').hidden = true
  toast('Sesión cerrada.')
  refreshStatus()
}

// ---------- Visual Editor (Stage, Crop, Matte) ----------
function updateStagePreview() {
  const stage = $('stage')
  const img = $('stageImg')
  const vid = $('stageVideo')
  const hasMedia = !!state.mediaFile

  stage.classList.toggle('empty', !hasMedia)
  $('stageEmpty').hidden = hasMedia
  $('stageBadge').hidden = !hasMedia
  $('stageAudioBadge').hidden = state.audioMode === 'none' || (state.audioMode === 'file' && !state.audioFile)

  if (state.matte === 'transparent') {
    stage.classList.add('checkerboard')
    stage.style.backgroundColor = ''
  } else {
    stage.classList.remove('checkerboard')
    stage.style.backgroundColor = state.matte
  }

  const objFit = state.fit === 'contain' ? 'contain' : 'cover'
  const objPos = `${Math.round(state.cropX * 100)}% ${Math.round(state.cropY * 100)}%`

  img.style.objectFit = objFit
  img.style.objectPosition = objPos
  vid.style.objectFit = objFit
  vid.style.objectPosition = objPos

  const nonSquare = state.mediaW > 0 && state.mediaH > 0 && state.mediaW !== state.mediaH
  $('stageBadge').textContent =
    state.fit === 'cover' && nonSquare ? '1:1 · 512×512 · mueve para encuadrar' : '1:1 · 512×512'

  updateCreateState()
}

function setMediaFile(file) {
  if (!file) return
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl)
  const isVid = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(file.name)
  state.mediaFile = file
  state.mediaUrl = URL.createObjectURL(file)
  state.isVideo = isVid
  state.cropX = 0.5
  state.cropY = 0.5
  state.mediaW = 0
  state.mediaH = 0

  if (isVid) {
    $('stageImg').hidden = true
    $('stageVideo').hidden = false
    $('stageVideo').src = state.mediaUrl
    $('stageVideo').onloadedmetadata = () => {
      state.mediaW = $('stageVideo').videoWidth
      state.mediaH = $('stageVideo').videoHeight
      updateStagePreview()
    }
    $('videoAudioBtn').disabled = false
  } else {
    $('stageVideo').hidden = true
    $('stageVideo').removeAttribute('src')
    $('stageImg').hidden = false
    $('stageImg').src = state.mediaUrl
    $('stageImg').onload = () => {
      state.mediaW = $('stageImg').naturalWidth
      state.mediaH = $('stageImg').naturalHeight
      updateStagePreview()
    }
    $('videoAudioBtn').disabled = true
    if (state.audioMode === 'video') setAudioMode('none')
  }

  if (!$('stickerName').value) {
    $('stickerName').value = file.name.replace(/\.[^.]+$/, '')
  }
  updateStagePreview()
}

$('stage').onclick = () => {
  if (!state.mediaFile) $('mediaInput').click()
  else if (state.audioMode === 'file' && state.audioFile) toggleAudioPreview()
}

$('stage').onmousemove = (e) => {
  if (!state.mediaFile || state.fit !== 'cover') return
  if (state.mediaW && state.mediaH && state.mediaW === state.mediaH) return
  const rect = e.currentTarget.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  state.cropX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  state.cropY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
  updateStagePreview()
}

$('stage').ondragover = (e) => {
  e.preventDefault()
  $('stage').classList.add('dragover')
}
$('stage').ondragleave = () => $('stage').classList.remove('dragover')
$('stage').ondrop = (e) => {
  e.preventDefault()
  $('stage').classList.remove('dragover')
  const f = e.dataTransfer.files[0]
  if (!f) return
  if (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|opus|flac)$/i.test(f.name)) {
    setAudioMode('file')
    loadAudioFile(f)
  } else {
    setMediaFile(f)
  }
}

$('mediaInput').onchange = (e) => {
  const f = e.target.files[0]
  if (f) setMediaFile(f)
  e.target.value = ''
}

$('fitSelect').onchange = (e) => {
  state.fit = e.target.value
  updateStagePreview()
}

document.querySelectorAll('[data-matte]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('[data-matte]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    state.matte = btn.dataset.matte
    updateStagePreview()
  }
})

$('customMatte').oninput = (e) => {
  document.querySelectorAll('[data-matte]').forEach((b) => b.classList.remove('active'))
  state.matte = e.target.value.toUpperCase()
  updateStagePreview()
}

// Global Ctrl+V paste for images OR MyInstants URLs
window.addEventListener('paste', async (e) => {
  const tag = e.target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const items = e.clipboardData?.items || []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) {
        e.preventDefault()
        setMediaFile(new File([f], f.name || 'pegado.png', { type: f.type }))
        toast('Imagen pegada desde el portapapeles.')
        return
      }
    }
  }
  const text = e.clipboardData?.getData('text/plain')?.trim()
  if (text && /^https?:\/\/(?:www\.)?myinstants\.com\//i.test(text)) {
    e.preventDefault()
    setAudioMode('file')
    $('myInstantsInput').value = text
    await importMyInstants(text)
  }
})

// ---------- Audio & Waveform Trimmer ----------
function stopAudioPreview() {
  clearTimeout(state.playTimer)
  if (state.audioEl) {
    state.audioEl.pause()
    URL.revokeObjectURL(state.audioEl.src)
    state.audioEl = null
  }
  state.playing = false
  $('playAudioBtn').textContent = '▶'
}

function toggleAudioPreview() {
  if (state.playing) return stopAudioPreview()
  if (!state.audioFile) return
  const url = URL.createObjectURL(state.audioFile)
  const el = new Audio(url)
  const startSec = state.audioStartMs / 1000
  const durMs = Math.min(state.maxWinMs, Math.max(200, state.audioDurationMs - state.audioStartMs))
  el.currentTime = startSec
  state.audioEl = el
  state.playing = true
  $('playAudioBtn').textContent = '■'
  state.playTimer = setTimeout(stopAudioPreview, durMs)
  el.play().catch(stopAudioPreview)
}

$('playAudioBtn').onclick = toggleAudioPreview

function setAudioMode(mode) {
  stopAudioPreview()
  state.audioMode = mode
  document.querySelectorAll('[data-audio-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.audioMode === mode)
  })
  $('audioFileControls').hidden = mode !== 'file'
  $('videoAudioHint').hidden = mode !== 'video'
  updateStagePreview()
}

document.querySelectorAll('[data-audio-mode]').forEach((btn) => {
  btn.onclick = () => setAudioMode(btn.dataset.audioMode)
})

function drawWaveform() {
  const canvas = $('waveformCanvas')
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  const bars = state.peaks.length ? state.peaks : Array.from({ length: 64 }, () => 0.35)
  const bw = w / bars.length
  ctx.fillStyle = '#4c5468'
  bars.forEach((amp, i) => {
    const bh = Math.max(4, amp * (h - 10))
    const x = i * bw + 1
    const y = (h - bh) / 2
    ctx.fillRect(x, y, Math.max(2, bw - 2), bh)
  })

  const total = Math.max(1, state.audioDurationMs)
  const winLen = Math.min(state.maxWinMs, total)
  const leftPct = (state.audioStartMs / total) * 100
  const widthPct = (winLen / total) * 100
  $('trimWindow').style.left = `${leftPct}%`
  $('trimWindow').style.width = `${Math.max(4, widthPct)}%`
  $('trimReadout').textContent = `${formatSec(state.audioStartMs)} – ${formatSec(state.audioStartMs + winLen)}`

  const slider = $('trimSlider')
  const maxStart = Math.max(0, total - winLen)
  slider.hidden = maxStart <= 0
  slider.max = String(maxStart)
  slider.value = String(state.audioStartMs)
}

async function decodeWaveformPeaks(file) {
  try {
    const buf = await file.arrayBuffer()
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    const ctx = new AudioCtx()
    const decoded = await ctx.decodeAudioData(buf.slice(0))
    const durMs = Math.round(decoded.duration * 1000)
    const ch = decoded.getChannelData(0)
    const buckets = 64
    const step = Math.max(1, Math.floor(ch.length / buckets))
    const peaks = []
    for (let i = 0; i < buckets; i++) {
      let peak = 0
      const start = i * step
      const end = Math.min(ch.length, start + step)
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j])
        if (v > peak) peak = v
      }
      peaks.push(Math.max(0.1, Math.min(1, peak)))
    }
    await ctx.close().catch(() => {})
    return { durMs, peaks }
  } catch {
    return { durMs: 5000, peaks: Array.from({ length: 64 }, () => 0.4) }
  }
}

async function loadAudioFile(file, displayTitle = null) {
  stopAudioPreview()
  state.audioFile = file
  state.audioTitle = displayTitle || file.name
  state.audioStartMs = 0
  $('audioTitle').textContent = state.audioTitle
  $('trimmerBox').hidden = false

  const { durMs, peaks } = await decodeWaveformPeaks(file)
  state.audioDurationMs = durMs
  state.peaks = peaks
  drawWaveform()
  updateStagePreview()
}

$('pickAudioBtn').onclick = () => $('audioInput').click()
$('audioInput').onchange = (e) => {
  const f = e.target.files[0]
  if (f) loadAudioFile(f)
  e.target.value = ''
}

$('maxWinSelect').onchange = (e) => {
  state.maxWinMs = Number(e.target.value)
  const maxStart = Math.max(0, state.audioDurationMs - state.maxWinMs)
  state.audioStartMs = Math.min(state.audioStartMs, maxStart)
  drawWaveform()
}

$('trimSlider').oninput = (e) => {
  state.audioStartMs = Number(e.target.value)
  drawWaveform()
}

$('waveformWrap').onclick = (e) => {
  if (!state.audioDurationMs) return
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const winLen = Math.min(state.maxWinMs, state.audioDurationMs)
  const centerMs = ratio * state.audioDurationMs
  state.audioStartMs = Math.max(0, Math.min(state.audioDurationMs - winLen, Math.round(centerMs - winLen / 2)))
  drawWaveform()
}

async function importMyInstants(rawUrl) {
  const url = String(rawUrl || '').trim()
  if (!url) return toast('Pega un enlace de MyInstants primero.', true)
  $('fetchMyInstantsBtn').disabled = true
  $('fetchMyInstantsBtn').textContent = 'Descargando…'
  try {
    const res = await fetch('/api/myinstants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error)

    const bin = atob(j.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], j.filename, { type: j.mimeType })
    await loadAudioFile(file, j.title || j.filename)
    toast(`Audio importado: ${j.title || j.filename}`)
  } catch (err) {
    toast(err.message, true)
  } finally {
    $('fetchMyInstantsBtn').disabled = false
    $('fetchMyInstantsBtn').textContent = 'Importar'
  }
}

$('fetchMyInstantsBtn').onclick = () => importMyInstants($('myInstantsInput').value)
$('myInstantsInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    importMyInstants($('myInstantsInput').value)
  }
}

// ---------- Reset & Create Sticker ----------
function resetEditor() {
  stopAudioPreview()
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl)
  state.mediaFile = null
  state.mediaUrl = null
  state.isVideo = false
  state.mediaW = 0
  state.mediaH = 0
  state.cropX = 0.5
  state.cropY = 0.5
  state.audioFile = null
  state.audioTitle = ''
  state.audioDurationMs = 0
  state.audioStartMs = 0
  state.peaks = []
  $('stageImg').hidden = true
  $('stageImg').removeAttribute('src')
  $('stageVideo').hidden = true
  $('stageVideo').removeAttribute('src')
  $('stickerName').value = ''
  $('myInstantsInput').value = ''
  $('trimmerBox').hidden = true
  $('videoAudioBtn').disabled = true
  setAudioMode('none')
  updateStagePreview()
}

$('resetEditorBtn').onclick = resetEditor

function updateCreateState() {
  const ready =
    !state.busy &&
    !!state.mediaFile &&
    (state.audioMode !== 'file' || !!state.audioFile)
  $('createBtn').disabled = !ready
}

$('createBtn').onclick = async () => {
  if (!state.mediaFile || state.busy) return
  stopAudioPreview()
  state.busy = true
  updateCreateState()
  $('createBtn').textContent = 'Convirtiendo…'

  try {
    const fd = new FormData()
    fd.append('media', state.mediaFile)
    fd.append('name', $('stickerName').value.trim())
    fd.append('fps', $('fpsSelect').value)
    fd.append('fit', state.fit)
    fd.append('cropX', state.cropX.toFixed(3))
    fd.append('cropY', state.cropY.toFixed(3))
    fd.append('matte', state.matte)
    fd.append('audioMode', state.audioMode)

    if (state.audioMode === 'file' && state.audioFile) {
      const winLen = Math.min(state.maxWinMs, Math.max(200, state.audioDurationMs - state.audioStartMs))
      fd.append('audio', state.audioFile)
      fd.append('audioStartMs', String(Math.round(state.audioStartMs)))
      fd.append('audioDurationMs', String(Math.round(winLen)))
    }

    const res = await fetch('/api/create', { method: 'POST', body: fd })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error)

    state.selectedSticker = j.name
    await refreshGallery()
    toast(
      j.audio
        ? `Sticker creado (${j.sticker.kb} KB + ${j.audio.dur}s audio)`
        : `Sticker creado (${j.sticker.kb} KB)`
    )
  } catch (err) {
    toast(err.message, true)
  } finally {
    state.busy = false
    $('createBtn').textContent = 'Crear Sticker'
    updateCreateState()
  }
}

// ---------- Gallery & Send ----------
function renderSelected() {
  const item = state.gallery.find((f) => f.name === state.selectedSticker)
  if (!item) {
    $('selectedBox').hidden = true
    $('selAudio').pause()
    $('selAudio').hidden = true
    return
  }

  $('selectedBox').hidden = false
  const webpUrl = `/stickers/${encodeURIComponent(item.name)}?t=${Date.now()}`
  $('selImg').src = webpUrl
  $('selName').textContent = item.name
  $('selStats').textContent = item.hasSound
    ? `${item.kb} KB WebP · ${item.soundKb} KB OGG/Opus`
    : `${item.kb} KB WebP (sin audio)`

  $('dlWebpBtn').href = `/stickers/${encodeURIComponent(item.name)}`
  $('dlWebpBtn').download = item.name

  const mp4Btn = $('dlMp4Btn')
  const aud = $('selAudio')
  aud.pause()

  if (item.hasSound) {
    const oggName = item.name.replace(/\.webp$/i, '.ogg')
    aud.src = `/stickers/${encodeURIComponent(oggName)}?t=${Date.now()}`
    aud.hidden = false
    mp4Btn.href = `/api/export/${encodeURIComponent(item.name.replace(/\.webp$/i, '.mp4'))}`
    mp4Btn.download = item.name.replace(/\.webp$/i, '.mp4')
    mp4Btn.hidden = false
  } else {
    aud.removeAttribute('src')
    aud.hidden = true
    mp4Btn.hidden = true
  }
}

async function deleteSticker(name) {
  if (!confirm(`¿Eliminar ${name}?`)) return
  const res = await fetch(`/api/stickers/${encodeURIComponent(name)}`, { method: 'DELETE' })
  const j = await res.json()
  if (!j.ok) return toast(j.error || 'No se pudo eliminar', true)
  if (state.selectedSticker === name) state.selectedSticker = null
  await refreshGallery()
  toast('Sticker eliminado.')
}

async function refreshGallery() {
  const res = await fetch('/api/stickers')
  const j = await res.json()
  state.gallery = j.files || []
  $('galleryCount').textContent = String(state.gallery.length)

  if (!state.selectedSticker && state.gallery.length) {
    state.selectedSticker = state.gallery[0].name
  }

  const grid = $('galleryGrid')
  if (!state.gallery.length) {
    grid.innerHTML = '<div class="empty-gallery">Aún no has creado stickers. Crea el primero en el editor.</div>'
    renderSelected()
    return
  }

  grid.innerHTML = ''
  for (const item of state.gallery) {
    const tile = document.createElement('div')
    tile.className = `sticker-tile${state.selectedSticker === item.name ? ' selected' : ''}`
    tile.innerHTML = `
      ${item.hasSound ? '<span class="tile-sound">🔊</span>' : ''}
      <button type="button" class="tile-del" title="Eliminar">×</button>
      <img loading="lazy" class="checkerboard" src="/stickers/${encodeURIComponent(item.name)}" alt="${item.name}">
      <div class="tile-cap">
        <strong>${item.name}</strong>
        <span>${item.kb} KB${item.hasSound ? ' · audio' : ''}</span>
      </div>
    `
    tile.onclick = (e) => {
      if (e.target.classList.contains('tile-del')) return
      state.selectedSticker = item.name
      refreshGallery()
    }
    tile.querySelector('.tile-del').onclick = (e) => {
      e.stopPropagation()
      deleteSticker(item.name)
    }
    grid.appendChild(tile)
  }
  renderSelected()
}

$('delSelBtn').onclick = () => {
  if (state.selectedSticker) deleteSticker(state.selectedSticker)
}

$('sendWaBtn').onclick = async () => {
  if (!state.selectedSticker) return toast('Selecciona un sticker primero.', true)
  const number = $('targetPhone').value.trim()
  if (!number) return toast('Ingresa el número de WhatsApp destino.', true)

  $('sendWaBtn').disabled = true
  $('sendWaBtn').textContent = 'Enviando…'
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: state.selectedSticker, number })
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error)
    toast(j.withSound ? `Sticker con sonido enviado a ${j.jid}` : `Sticker enviado a ${j.jid}`)
  } catch (err) {
    toast(err.message, true)
  } finally {
    $('sendWaBtn').disabled = false
    $('sendWaBtn').textContent = 'Enviar por WhatsApp'
  }
}

// Init
refreshStatus()
refreshGallery()
setInterval(refreshStatus, 4000)
