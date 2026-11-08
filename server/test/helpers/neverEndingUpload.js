import http from 'node:http'

/**
 * POST a multipart upload whose body never finishes and resolve with the
 * response status. Only a server that answers WITHOUT reading the body can
 * respond at all — so a status here proves the refusal came before multer,
 * with no reliance on the shared uploads directory (which other test files
 * write to concurrently).
 */
export function neverEndingUpload(url, token, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const boundary = 'never-ending'
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(64 * 1024 * 1024),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => {
        req.destroy()
        resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null })
      })
    })
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error('no response: the server is reading the upload'))
    }, timeoutMs)
    req.on('close', () => clearTimeout(timer))
    req.on('error', err => { if (err.code !== 'ECONNRESET') reject(err) })
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n`)
    req.write(Buffer.alloc(1024))
    // …and never end().
  })
}
