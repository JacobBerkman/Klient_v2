import { createConnection } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

// Minimal hand-rolled SMTP client (zero runtime dependencies, matching the
// repo's hand-rolled XLSX/OIDC precedent). Supports EHLO, STARTTLS upgrade,
// implicit TLS (port 465), AUTH PLAIN and AUTH LOGIN, and MAIL FROM/RCPT
// TO/DATA with RFC 5321 dot-stuffing + CRLF normalization. Plain-text bodies
// only. Every server response is bounded by a per-command timeout.
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

// Normalize every line ending (\r\n, bare \r, bare \n) to CRLF as required by
// RFC 5321 for the DATA section.
export function normalizeCrlf(text) {
  return String(text ?? '').replace(/\r\n|\r|\n/g, '\r\n')
}

// RFC 5321 section 4.5.2 transparency: any DATA line beginning with '.' gets an
// extra leading '.' so it cannot be confused with the <CRLF>.<CRLF> terminator.
// Input must already be CRLF-normalized.
export function dotStuff(text) {
  return String(text ?? '').replace(/(^|\r\n)\./g, '$1..')
}

function sanitizeAddress(value) {
  return String(value || '')
    .replace(/[<>\r\n]/g, '')
    .trim()
}

function sanitizeHeaderText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ')
}

// RFC 2047 encoded-word for non-ASCII header values (subjects only; addresses
// are restricted to printable ASCII by sanitizeAddress).
function encodeHeaderValue(value) {
  const text = sanitizeHeaderText(value)
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

export function buildMimeMessage({ from, to, subject, text, date = new Date() }) {
  const headers = [
    `From: <${sanitizeAddress(from)}>`,
    `To: <${sanitizeAddress(to)}>`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@kinetic-klient>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit'
  ]
  const body = dotStuff(normalizeCrlf(text))
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

function smtpError(message, reply) {
  const error = new Error(reply ? `${message} (${reply.code}: ${reply.lines.join(' ')})` : message)
  if (reply) error.smtpCode = reply.code
  return error
}

// Wraps a socket with a line-buffered SMTP reply reader. Replies may be
// multi-line ("250-..." continuations followed by a "250 ..." terminator).
// The handle survives a STARTTLS upgrade by re-attaching to the TLS socket.
function createSmtpChannel(timeoutMs) {
  const state = { socket: null, buffer: '', pending: null, fatalError: null, closed: false }

  function failPending(error) {
    const pending = state.pending
    if (!pending) return
    state.pending = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  function extractReply() {
    const lines = state.buffer.split('\r\n')
    const replyLines = []
    for (let index = 0; index < lines.length - 1; index += 1) {
      replyLines.push(lines[index])
      if (/^\d{3}(?: |$)/.test(lines[index])) {
        state.buffer = lines.slice(index + 1).join('\r\n')
        return { code: Number(lines[index].slice(0, 3)), lines: replyLines }
      }
    }
    return null
  }

  function flush() {
    if (!state.pending) return
    const reply = extractReply()
    if (!reply) return
    const pending = state.pending
    state.pending = null
    clearTimeout(pending.timer)
    pending.resolve(reply)
  }

  const onData = (chunk) => {
    state.buffer += chunk.toString('utf8')
    flush()
  }
  const onError = (error) => {
    state.fatalError = error
    failPending(error)
  }
  const onClose = () => {
    state.closed = true
    failPending(state.fatalError || new Error('SMTP connection closed unexpectedly.'))
  }

  function detach() {
    if (!state.socket) return
    state.socket.removeListener('data', onData)
    state.socket.removeListener('error', onError)
    state.socket.removeListener('close', onClose)
  }

  function attach(socket) {
    detach()
    state.socket = socket
    state.buffer = ''
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  }

  function readReply() {
    if (state.fatalError) return Promise.reject(state.fatalError)
    if (state.closed) return Promise.reject(new Error('SMTP connection is closed.'))
    return new Promise((resolveReply, rejectReply) => {
      state.pending = {
        resolve: resolveReply,
        reject: rejectReply,
        timer: setTimeout(() => {
          state.pending = null
          state.socket?.destroy()
          rejectReply(new Error(`SMTP timeout: no server response within ${timeoutMs}ms.`))
        }, timeoutMs)
      }
      flush()
    })
  }

  async function expect(allowedCodes, context) {
    const reply = await readReply()
    const allowed = Array.isArray(allowedCodes) ? allowedCodes : [allowedCodes]
    if (!allowed.includes(reply.code)) {
      throw smtpError(`SMTP ${context} rejected`, reply)
    }
    return reply
  }

  async function command(line, allowedCodes, context) {
    state.socket.write(`${line}\r\n`)
    return expect(allowedCodes, context)
  }

  return {
    attach,
    detach,
    expect,
    command,
    write: (data) => state.socket.write(data),
    destroy: () => state.socket?.destroy(),
    get socket() {
      return state.socket
    }
  }
}

function connectSocket({ host, port, secure, timeoutMs, rejectUnauthorized }) {
  return new Promise((resolveSocket, rejectSocket) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectSocket(new Error(`SMTP timeout: could not connect to ${host}:${port} within ${timeoutMs}ms.`))
    }, timeoutMs)
    const onReady = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('error', onConnectError)
      resolveSocket(socket)
    }
    const onConnectError = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectSocket(error)
    }
    const socket = secure
      ? connectTls({ host, port, servername: host, rejectUnauthorized }, onReady)
      : createConnection({ host, port }, onReady)
    socket.once('error', onConnectError)
  })
}

function upgradeToTls(channel, { host, timeoutMs, rejectUnauthorized }) {
  return new Promise((resolveUpgrade, rejectUpgrade) => {
    const plainSocket = channel.socket
    channel.detach()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      tlsSocket.destroy()
      rejectUpgrade(new Error(`SMTP timeout: STARTTLS handshake did not complete within ${timeoutMs}ms.`))
    }, timeoutMs)
    const onSecure = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      tlsSocket.removeListener('error', onTlsError)
      channel.attach(tlsSocket)
      resolveUpgrade()
    }
    const onTlsError = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectUpgrade(error)
    }
    const tlsSocket = connectTls({ socket: plainSocket, servername: host, rejectUnauthorized }, onSecure)
    tlsSocket.once('error', onTlsError)
  })
}

function parseEhloCapabilities(reply) {
  const capabilities = new Set()
  const authMechanisms = new Set()
  for (const line of reply.lines) {
    const text = line.replace(/^\d{3}[- ]/, '').trim()
    if (!text) continue
    const keyword = text.split(/\s+/)[0].toUpperCase()
    capabilities.add(keyword)
    if (keyword === 'AUTH') {
      for (const mechanism of text.split(/\s+/).slice(1)) {
        authMechanisms.add(mechanism.toUpperCase())
      }
    }
  }
  return { capabilities, authMechanisms }
}

async function authenticate(channel, { username, password, authMechanisms }) {
  if (authMechanisms.has('PLAIN') || authMechanisms.size === 0) {
    const credentials = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64')
    await channel.command(`AUTH PLAIN ${credentials}`, 235, 'AUTH PLAIN')
    return
  }
  if (authMechanisms.has('LOGIN')) {
    await channel.command('AUTH LOGIN', 334, 'AUTH LOGIN')
    await channel.command(Buffer.from(String(username), 'utf8').toString('base64'), 334, 'AUTH LOGIN username')
    await channel.command(Buffer.from(String(password), 'utf8').toString('base64'), 235, 'AUTH LOGIN password')
    return
  }
  throw new Error('SMTP server offers no supported AUTH mechanism (PLAIN or LOGIN).')
}

// Sends a single plain-text message. Throws on any failure; the caller
// (apps/api/src/mailer/index.mjs) is responsible for swallowing errors so
// email can never affect an API response.
//
// `allowInsecure` permits (a) proceeding without STARTTLS on a plaintext
// connection and (b) skipping TLS certificate verification. It is honored
// ONLY when NODE_ENV !== 'production' — needed for the in-process fake-server
// tests and local catch-all SMTP sinks; production always requires TLS.
export async function sendSmtpMail({
  host,
  port = 587,
  secure = false,
  username = '',
  password = '',
  from,
  to,
  subject = '',
  text = '',
  allowInsecure = false,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  clientName = ''
} = {}) {
  if (!host) throw new Error('SMTP host is required.')
  const fromAddress = sanitizeAddress(from)
  const toAddress = sanitizeAddress(to)
  if (!fromAddress) throw new Error('SMTP sender (from) is required.')
  if (!toAddress) throw new Error('SMTP recipient (to) is required.')
  const insecureAllowed = Boolean(allowInsecure) && process.env.NODE_ENV !== 'production'
  const ehloName = sanitizeHeaderText(clientName || hostname() || 'localhost').replace(/\s+/g, '-')

  const channel = createSmtpChannel(timeoutMs)
  const socket = await connectSocket({
    host,
    port,
    secure,
    timeoutMs,
    rejectUnauthorized: !insecureAllowed
  })
  channel.attach(socket)

  try {
    await channel.expect(220, 'greeting')
    let ehlo = parseEhloCapabilities(await channel.command(`EHLO ${ehloName}`, 250, 'EHLO'))
    let tlsActive = Boolean(secure)

    if (!tlsActive) {
      if (ehlo.capabilities.has('STARTTLS')) {
        await channel.command('STARTTLS', 220, 'STARTTLS')
        await upgradeToTls(channel, { host, timeoutMs, rejectUnauthorized: !insecureAllowed })
        ehlo = parseEhloCapabilities(await channel.command(`EHLO ${ehloName}`, 250, 'EHLO'))
        tlsActive = true
      } else if (!insecureAllowed) {
        throw new Error('SMTP server does not offer STARTTLS; refusing to continue over plaintext.')
      }
    }

    if (username) {
      if (!tlsActive && !insecureAllowed) {
        throw new Error('SMTP AUTH requires a TLS connection.')
      }
      await authenticate(channel, { username, password, authMechanisms: ehlo.authMechanisms })
    }

    await channel.command(`MAIL FROM:<${fromAddress}>`, 250, 'MAIL FROM')
    await channel.command(`RCPT TO:<${toAddress}>`, [250, 251], 'RCPT TO')
    await channel.command('DATA', 354, 'DATA')
    const message = buildMimeMessage({ from: fromAddress, to: toAddress, subject, text })
    channel.write(message.endsWith('\r\n') ? `${message}.\r\n` : `${message}\r\n.\r\n`)
    await channel.expect(250, 'message delivery')
    try {
      await channel.command('QUIT', 221, 'QUIT')
    } catch {
      // Best-effort QUIT: the message was already accepted (250 above).
    }
    return { accepted: true, to: toAddress }
  } finally {
    channel.destroy()
  }
}
