/**
 * ACX Audio Compliance Checker — frontend logic.
 *
 * States: idle → uploading → processing → results (pass|fail) | error
 *
 * API:
 *   POST /api/acx-check          → 202 { checkId }
 *   GET  /api/acx-check-jobs/:id → { status, report?, error?, progress? }
 */

const POLL_INTERVAL_MS = 3000

// ── DOM refs ──────────────────────────────────────────────────────────────────
const fileInput       = document.getElementById('file-input')
const uploadZone      = document.getElementById('upload-zone')
const processingState = document.getElementById('processing-state')
const processingName  = document.getElementById('processing-name')
const processingStage = document.getElementById('processing-stage')
const resultsSection  = document.getElementById('results')
const errorSection    = document.getElementById('error-section')
const errorMsg        = document.getElementById('error-msg')

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer = null

// ── Upload zone interactions ──────────────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click())

uploadZone.addEventListener('dragover', e => {
  e.preventDefault()
  uploadZone.classList.add('dragging')
})

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragging')
})

uploadZone.addEventListener('drop', e => {
  e.preventDefault()
  uploadZone.classList.remove('dragging')
  const file = e.dataTransfer.files[0]
  if (file) handleFile(file)
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (file) handleFile(file)
})

document.getElementById('browse-btn').addEventListener('click', e => {
  e.stopPropagation()
  fileInput.click()
})

document.getElementById('reset-btn').addEventListener('click', resetToIdle)

// ── Core flow ─────────────────────────────────────────────────────────────────
async function handleFile(file) {
  showProcessing(file.name)

  const formData = new FormData()
  formData.append('file', file)

  let checkId
  try {
    const resp = await fetch('/api/acx-check', { method: 'POST', body: formData })
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error || `Upload failed (${resp.status})`)
    }
    const { checkId: id } = await resp.json()
    checkId = id
  } catch (err) {
    showError(err.message)
    return
  }

  pollTimer = setInterval(() => poll(checkId), POLL_INTERVAL_MS)
}

async function poll(checkId) {
  try {
    const resp = await fetch(`/api/acx-check-jobs/${checkId}`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error || `Poll failed (${resp.status})`)
    }
    const data = await resp.json()

    if (data.status === 'processing') {
      if (data.progress) processingStage.textContent = data.progress
      return
    }

    clearInterval(pollTimer)
    pollTimer = null

    if (data.status === 'error') {
      showError(data.error || 'Analysis failed. Please try again.')
      return
    }

    if (data.status === 'done') {
      showResults(data.report)
    }
  } catch (err) {
    clearInterval(pollTimer)
    pollTimer = null
    showError(err.message)
  }
}

// ── State transitions ─────────────────────────────────────────────────────────
function showProcessing(filename) {
  hide(uploadZone)
  hide(resultsSection)
  hide(errorSection)
  processingName.textContent = filename
  processingStage.textContent = 'Uploading…'
  show(processingState)
}

function resetToIdle() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  hide(processingState)
  hide(resultsSection)
  hide(errorSection)
  fileInput.value = ''
  show(uploadZone)
}

function showError(message) {
  hide(processingState)
  hide(resultsSection)
  errorMsg.textContent = message
  show(errorSection)
}

// ── Results rendering ─────────────────────────────────────────────────────────
function showResults(report) {
  hide(processingState)
  hide(errorSection)

  const cert    = report.acx_certification
  const isPass  = cert?.certificate === 'pass'
  const metrics = report.quality_metrics
  const meta    = report.file_metadata
  const meas    = report.measurements

  // Overall badge
  const badge = document.getElementById('overall-badge')
  badge.className = `overall-badge ${isPass ? 'pass' : 'fail'}`
  document.getElementById('badge-icon').textContent    = isPass ? '✅' : '❌'
  document.getElementById('badge-verdict').textContent = isPass
    ? 'Passes ACX Requirements'
    : 'Does Not Pass ACX Requirements'
  document.getElementById('badge-filename').textContent = report.filename || ''
  document.getElementById('badge-subtext').textContent  = isPass
    ? 'Your file meets all 6 ACX technical requirements.'
    : `${failCount(cert)} of 6 checks failed. See the details below.`

  // Compliance table
  renderComplianceTable(cert, meas)

  // File info strip
  renderFileInfo(meta, report.duration_seconds)

  // Quality metrics
  renderQualityMetrics(metrics, report.duration_seconds)

  // CTA messaging
  renderCta(isPass, cert, metrics)

  show(resultsSection)
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderComplianceTable(cert, meas) {
  const checks = cert?.checks ?? {}
  const rows = [
    {
      name:   'RMS Level',
      value:  fmt(meas?.rms_dbfs, ' dBFS'),
      target: `Target: −23 to −18 dBFS`,
      pass:   checks.rms?.pass,
    },
    {
      name:   'True Peak',
      value:  fmt(meas?.true_peak_dbfs, ' dBFS'),
      target: `Ceiling: −3 dBFS`,
      pass:   checks.true_peak?.pass,
    },
    {
      name:   'Noise Floor',
      value:  fmt(meas?.noise_floor_dbfs, ' dBFS'),
      target: `Ceiling: −60 dBFS`,
      pass:   checks.noise_floor?.pass,
    },
    {
      name:   'Sample Rate',
      value:  checks.sample_rate?.value_hz ? `${(checks.sample_rate.value_hz / 1000).toFixed(1)} kHz` : '—',
      target: 'Required: 44.1 kHz',
      pass:   checks.sample_rate?.pass,
    },
    {
      name:   'Bit Depth',
      value:  checks.bit_depth?.value || '—',
      target: 'Required: 16-bit PCM',
      pass:   checks.bit_depth?.pass,
    },
    {
      name:   'Channel',
      value:  checks.channel?.value ? capitalise(checks.channel.value) : '—',
      target: 'Required: Mono',
      pass:   checks.channel?.pass,
    },
  ]

  const tbody = document.getElementById('acx-tbody')
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="check-name">${r.name}</td>
      <td class="check-value">${r.value}</td>
      <td class="check-target">${r.target}</td>
      <td class="check-status">
        <span class="pill ${r.pass ? 'pass' : 'fail'}">
          ${r.pass ? '✓ Pass' : '✗ Fail'}
        </span>
      </td>
    </tr>
  `).join('')
}

function renderFileInfo(meta, durationSeconds) {
  const strip = document.getElementById('file-strip')
  const parts = []

  if (meta?.codec)          parts.push(`<span class="file-stat">Format <strong>${meta.codec.toUpperCase()}</strong></span>`)
  if (meta?.sample_rate_hz) parts.push(`<span class="file-stat">Sample rate <strong>${(meta.sample_rate_hz / 1000).toFixed(1)} kHz</strong></span>`)
  if (meta?.channels)       parts.push(`<span class="file-stat">Channels <strong>${meta.channels === 1 ? 'Mono' : meta.channels === 2 ? 'Stereo' : meta.channels}</strong></span>`)
  if (meta?.bit_depth)      parts.push(`<span class="file-stat">Bit depth <strong>${meta.bit_depth}</strong></span>`)
  if (durationSeconds)      parts.push(`<span class="file-stat">Duration <strong>${formatDuration(durationSeconds)}</strong></span>`)
  if (meta?.size_bytes)     parts.push(`<span class="file-stat">Size <strong>${formatBytes(meta.size_bytes)}</strong></span>`)

  strip.innerHTML = parts.join('')
}

function renderQualityMetrics(metrics, durationSeconds) {
  const grid = document.getElementById('quality-grid')
  const rows = []

  // Crest factor / dynamics
  const cf = metrics?.crest_factor
  if (cf?.db !== null && cf?.db !== undefined) {
    const { label, badge, icon, desc } = crestFactorDisplay(cf.rating, cf.db)
    rows.push(metricRow(icon, 'Dynamics (Crest Factor)', `${cf.db.toFixed(1)} dB`, desc, badge))
  }

  // Hum detection
  const hum = metrics?.hum
  if (hum?.detected !== null && hum?.detected !== undefined) {
    const { label, badge, icon, desc } = humDisplay(hum)
    rows.push(metricRow(icon, 'Hum Detection', label, desc, badge))
  }

  // Sibilance
  const sib = metrics?.sibilant_events
  if (sib?.count !== null && sib?.count !== undefined) {
    const { label, badge, icon, desc } = sibilanceDisplay(sib, durationSeconds)
    rows.push(metricRow(icon, 'Sibilant Events', label, desc, badge))
  }

  grid.innerHTML = rows.join('') || '<p style="color:var(--muted);font-size:.85rem">Quality metrics unavailable for this file.</p>'
}

function renderCta(isPass, cert, metrics) {
  const ctaHeading = document.getElementById('cta-heading')
  const ctaPoints  = document.getElementById('cta-points')
  const ctaBtn     = document.getElementById('cta-btn')

  if (isPass) {
    ctaHeading.textContent = 'Already passing? Make it sound even better.'
    renderCtaPoints(ctaPoints, [
      'Remove background noise and room tone with DeepFilterNet3',
      'Balance EQ and add professional vocal warmth',
      'One-click ACX mastering — certifies at export',
    ])
  } else {
    const checks   = cert?.checks ?? {}
    const failures = Object.entries(checks).filter(([, v]) => !v.pass).map(([k]) => k)
    let headline   = 'Fix every failing check automatically.'
    let points     = [
      'Normalizes to −20 dBFS RMS with true-peak limiting to −3 dBFS',
      'Reduces noise floor to −60 dBFS or better',
      'Converts stereo to mono, resamples to 44.1 kHz, exports 16-bit WAV',
    ]

    if (failures.includes('noise_floor')) {
      headline = 'Your noise floor is too high — Instant Polish can fix it.'
      points = [
        'DeepFilterNet3 removes background noise in one click',
        'Normalizes to ACX levels and limits true peak',
        'Verifies compliance before you download',
      ]
    } else if (failures.includes('rms') || failures.includes('true_peak')) {
      headline = 'Your loudness levels are off — Instant Polish corrects them exactly.'
      points = [
        'Targets −20 dBFS RMS with ±0.5 dB accuracy',
        'True-peak limiter holds at −3 dBFS',
        'Certifies the processed file before download',
      ]
    } else if (failures.includes('channel')) {
      headline = 'ACX requires mono — Instant Polish converts and optimizes.'
      points = [
        'Mid-channel mono mixdown preserves vocal clarity',
        'Full ACX preset chain applied after conversion',
        'One click from stereo recording to ACX-ready file',
      ]
    }

    ctaHeading.textContent = headline
    renderCtaPoints(ctaPoints, points)
  }

  ctaBtn.href = '/'
}

function renderCtaPoints(el, points) {
  el.innerHTML = points.map(p => `<li class="cta-point">${p}</li>`).join('')
}

// ── Display helpers ───────────────────────────────────────────────────────────
function crestFactorDisplay(rating, db) {
  const map = {
    over_compressed: {
      icon: '📉', badge: 'red',    label: 'Over-compressed',
      desc: 'Too much dynamic range compression — audio sounds squashed. ACX human reviewers may flag this.',
    },
    ideal: {
      icon: '✅', badge: 'green',  label: 'Ideal',
      desc: 'Great dynamic range for audiobook narration. Controlled and natural-sounding.',
    },
    good: {
      icon: '👍', badge: 'green',  label: 'Good',
      desc: 'Good dynamic range. Suitable for most narration. May benefit from light compression.',
    },
    very_dynamic: {
      icon: '📈', badge: 'yellow', label: 'Very Dynamic',
      desc: 'High dynamic range. Consider applying compression before ACX submission.',
    },
  }
  return map[rating] ?? { icon: '📊', badge: 'gray', label: `${db.toFixed(1)} dB`, desc: '' }
}

function humDisplay(hum) {
  if (hum.detected) {
    const freqs = hum.frequencies.length ? hum.frequencies.map(f => `${f} Hz`).join(', ') : ''
    return {
      icon:  '⚠️',
      badge: 'yellow',
      label: 'Detected',
      desc:  `Mains hum at ${freqs || 'one or more harmonics'}. Can reduce clarity, especially in quiet passages.`,
    }
  }
  return {
    icon:  '✅',
    badge: 'green',
    label: 'Clean',
    desc:  'No mains hum detected. Good electrical grounding and clean signal chain.',
  }
}

function sibilanceDisplay(sib, durationSeconds) {
  const rate = sib.rate_per_minute
  const count = sib.count
  const rateStr = rate !== null ? ` (${rate.toFixed(1)}/min)` : ''
  const map = {
    low: {
      icon: '✅', badge: 'green',  label: `${count} events${rateStr}`,
      desc: 'Low sibilance. Your "s" and "sh" sounds are well-controlled.',
    },
    moderate: {
      icon: '⚠️', badge: 'yellow', label: `${count} events${rateStr}`,
      desc: 'Moderate sibilance. A de-esser may improve listenability for long-form audio.',
    },
    high: {
      icon: '🔴', badge: 'red',    label: `${count} events${rateStr}`,
      desc: 'High sibilance. "S" and "sh" sounds may be harsh. De-essing recommended before ACX submission.',
    },
  }
  return map[sib.rating] ?? { icon: '📊', badge: 'gray', label: `${count} events`, desc: '' }
}

function metricRow(icon, name, value, desc, badgeClass) {
  return `
    <div class="metric-row">
      <div class="metric-icon">${icon}</div>
      <div class="metric-body">
        <div class="metric-name">${name}</div>
        <div class="metric-value">${value}</div>
        ${desc ? `<div class="metric-desc">${desc}</div>` : ''}
      </div>
      <div class="metric-badge ${badgeClass}">${badgeLabelFor(badgeClass)}</div>
    </div>
  `
}

function badgeLabelFor(cls) {
  return { green: 'Good', yellow: 'Review', red: 'Issue', gray: 'Info' }[cls] ?? ''
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmt(val, suffix = '') {
  if (val === null || val === undefined) return '—'
  return `${val > 0 ? '+' : ''}${val.toFixed(1)}${suffix}`
}

function formatDuration(seconds) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatBytes(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function capitalise(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
}

function failCount(cert) {
  if (!cert?.checks) return 0
  return Object.values(cert.checks).filter(c => !c.pass).length
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function show(el) { el.hidden = false }
function hide(el) { el.hidden = true }
