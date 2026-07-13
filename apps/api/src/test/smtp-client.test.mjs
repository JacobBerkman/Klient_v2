import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { sendSmtpMail, normalizeCrlf, dotStuff, buildMimeMessage } from '../mailer/smtp-client.mjs'

// In-process fake SMTP server (node:net, plaintext). The hand-rolled client is
// exercised end-to-end against a scripted dialogue: greeting, EHLO capability
// advertisement, AUTH PLAIN / AUTH LOGIN, MAIL FROM / RCPT TO / DATA with the
// <CRLF>.<CRLF> terminator, QUIT. `behavior` knobs simulate 5xx rejections and
// a server that stops responding (timeout path).
function startFakeSmtpServer(behavior = {}) {
  const seen = { commands: [], auth: null, data: null }
  const server = createServer((socket) => {
    const session = { buffer: '', inData: false, authState: null }
    const capabilities = behavior.capabilities || ['AUTH PLAIN LOGIN']
    socket.write('220 fake.test ESMTP ready\r\n')

    const handleLine = (line) => {
      seen.commands.push(line)
      if (session.authState === 'username') {
        seen.auth = { mechanism: 'LOGIN', username: Buffer.from(line, 'base64').toString('utf8') }
        session.authState = 'password'
        socket.write('334 UGFzc3dvcmQ6\r\n')
        return
      }
      if (session.authState === 'password') {
        seen.auth.password = Buffer.from(line, 'base64').toString('utf8')
        session.authState = null
        socket.write('235 2.7.0 Authentication successful\r\n')
        return
      }
      const verb = line.split(/\s+/)[0].toUpperCase()
      if (verb === 'EHLO') {
        if (behavior.silentAfterGreeting) return
        const lines = ['250-fake.test greets you', ...capabilities.map((cap) => `250-${cap}`)]
        socket.write(`${lines.join('\r\n')}\r\n250 OK\r\n`)
        return
      }
      if (verb === 'AUTH') {
        const parts = line.split(/\s+/)
        if (parts[1]?.toUpperCase() === 'PLAIN') {
          const decoded = Buffer.from(parts[2] || '', 'base64')
            .toString('utf8')
            .split('\u0000')
          seen.auth = { mechanism: 'PLAIN', username: decoded[1], password: decoded[2] }
          socket.write('235 2.7.0 Authentication successful\r\n')
          return
        }
        if (parts[1]?.toUpperCase() === 'LOGIN') {
          session.authState = 'username'
          socket.write('334 VXNlcm5hbWU6\r\n')
          return
        }
        socket.write('504 unsupported auth mechanism\r\n')
        return
      }
      if (verb === 'MAIL') {
        socket.write(behavior.rejectMailFrom ? '550 5.1.0 sender rejected\r\n' : '250 OK\r\n')
        return
      }
      if (verb === 'RCPT') {
        socket.write('250 OK\r\n')
        return
      }
      if (verb === 'DATA') {
        session.inData = true
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        return
      }
      if (verb === 'QUIT') {
        socket.write('221 bye\r\n')
        socket.end()
        return
      }
      socket.write('250 OK\r\n')
    }

    socket.on('data', (chunk) => {
      session.buffer += chunk.toString('utf8')
      for (;;) {
        if (session.inData) {
          const terminator = session.buffer.indexOf('\r\n.\r\n')
          if (terminator === -1) return
          seen.data = session.buffer.slice(0, terminator)
          session.buffer = session.buffer.slice(terminator + 5)
          session.inData = false
          socket.write('250 2.0.0 queued\r\n')
          continue
        }
        const lineEnd = session.buffer.indexOf('\r\n')
        if (lineEnd === -1) return
        const line = session.buffer.slice(0, lineEnd)
        session.buffer = session.buffer.slice(lineEnd + 2)
        handleLine(line)
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({
        seen,
        port: server.address().port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
      })
    })
  })
}

test('normalizeCrlf converts every line-ending style to CRLF', () => {
  assert.equal(normalizeCrlf('a\nb\rc\r\nd'), 'a\r\nb\r\nc\r\nd')
})

test('dotStuff escapes leading dots at the start and after CRLF', () => {
  assert.equal(dotStuff('.hidden\r\nplain\r\n..double'), '..hidden\r\nplain\r\n...double')
})

test('buildMimeMessage emits plain-text headers and a dot-stuffed body', () => {
  const message = buildMimeMessage({
    from: 'sender@example.test',
    to: 'rcpt@example.test',
    subject: 'Hello',
    text: '.starts with dot\nsecond line'
  })
  assert.match(message, /^From: <sender@example\.test>\r\n/)
  assert.match(message, /Content-Type: text\/plain; charset=utf-8/)
  assert.ok(message.endsWith('\r\n\r\n..starts with dot\r\nsecond line'))
})

test('full dialogue with AUTH PLAIN: EHLO, auth, envelope, dot-stuffed DATA, QUIT', async () => {
  const fake = await startFakeSmtpServer()
  try {
    const result = await sendSmtpMail({
      host: '127.0.0.1',
      port: fake.port,
      username: 'mailer-user',
      password: 'mailer-pass',
      from: 'no-reply@example.test',
      to: 'client@example.test',
      subject: 'Portal link',
      text: 'Line one\n.dot-led line\nLine three',
      allowInsecure: true,
      timeoutMs: 2000
    })
    assert.deepEqual(result, { accepted: true, to: 'client@example.test' })
    assert.deepEqual(fake.seen.auth, { mechanism: 'PLAIN', username: 'mailer-user', password: 'mailer-pass' })
    assert.ok(
      fake.seen.commands.some((line) => /^EHLO /.test(line)),
      'EHLO was sent'
    )
    assert.ok(fake.seen.commands.includes('MAIL FROM:<no-reply@example.test>'))
    assert.ok(fake.seen.commands.includes('RCPT TO:<client@example.test>'))
    assert.ok(fake.seen.commands.includes('QUIT'))
    // Dot-stuffing on the wire: the '.'-led body line arrives doubled and the
    // whole body is CRLF-normalized.
    assert.match(fake.seen.data, /Line one\r\n\.\.dot-led line\r\nLine three$/)
    assert.match(fake.seen.data, /Subject: Portal link\r\n/)
  } finally {
    await fake.close()
  }
})

test('falls back to AUTH LOGIN when the server only offers LOGIN', async () => {
  const fake = await startFakeSmtpServer({ capabilities: ['AUTH LOGIN'] })
  try {
    const result = await sendSmtpMail({
      host: '127.0.0.1',
      port: fake.port,
      username: 'login-user',
      password: 'login-pass',
      from: 'no-reply@example.test',
      to: 'client@example.test',
      subject: 'Invite',
      text: 'Welcome',
      allowInsecure: true,
      timeoutMs: 2000
    })
    assert.equal(result.accepted, true)
    assert.deepEqual(fake.seen.auth, { mechanism: 'LOGIN', username: 'login-user', password: 'login-pass' })
  } finally {
    await fake.close()
  }
})

test('a 5xx response fails the send with the server reply in the error', async () => {
  const fake = await startFakeSmtpServer({ rejectMailFrom: true })
  try {
    await assert.rejects(
      sendSmtpMail({
        host: '127.0.0.1',
        port: fake.port,
        from: 'no-reply@example.test',
        to: 'client@example.test',
        subject: 'x',
        text: 'x',
        allowInsecure: true,
        timeoutMs: 2000
      }),
      /MAIL FROM rejected \(550/
    )
  } finally {
    await fake.close()
  }
})

test('a server that stops responding trips the per-command timeout', async () => {
  const fake = await startFakeSmtpServer({ silentAfterGreeting: true })
  try {
    await assert.rejects(
      sendSmtpMail({
        host: '127.0.0.1',
        port: fake.port,
        from: 'no-reply@example.test',
        to: 'client@example.test',
        subject: 'x',
        text: 'x',
        allowInsecure: true,
        timeoutMs: 300
      }),
      /SMTP timeout: no server response within 300ms/
    )
  } finally {
    await fake.close()
  }
})

test('refuses a plaintext server without allowInsecure', async () => {
  const fake = await startFakeSmtpServer()
  try {
    await assert.rejects(
      sendSmtpMail({
        host: '127.0.0.1',
        port: fake.port,
        from: 'no-reply@example.test',
        to: 'client@example.test',
        subject: 'x',
        text: 'x',
        timeoutMs: 2000
      }),
      /does not offer STARTTLS/
    )
  } finally {
    await fake.close()
  }
})

test('allowInsecure is ignored when NODE_ENV=production', async () => {
  const fake = await startFakeSmtpServer()
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await assert.rejects(
      sendSmtpMail({
        host: '127.0.0.1',
        port: fake.port,
        from: 'no-reply@example.test',
        to: 'client@example.test',
        subject: 'x',
        text: 'x',
        allowInsecure: true,
        timeoutMs: 2000
      }),
      /does not offer STARTTLS/
    )
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    await fake.close()
  }
})
