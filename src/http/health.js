import http from 'http'

export function startHealthServer(port) {
  return http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK\n')
    })
    .listen(port, () => {
      console.log('HTTP server listening on port', port)
    })
}
