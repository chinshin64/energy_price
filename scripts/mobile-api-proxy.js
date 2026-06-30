const http = require('http');
const PORT = 50080;
const UPSTREAM = { host: '127.0.0.1', port: 80 };

const ALLOWED = [
  '/api/mobile-sync/',
  '/api/mobile-control/'
];

function isAllowed(path) {
  return ALLOWED.some(p => path.startsWith(p));
}

const server = http.createServer((req, res) => {
  if (!isAllowed(req.url)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const proxy = http.request({
    hostname: UPSTREAM.host,
    port: UPSTREAM.port,
    path: req.url,
    method: req.method,
    headers: req.headers
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  proxy.on('error', () => {
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxy);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mobile-api-proxy listening on 127.0.0.1:${PORT}`);
});
