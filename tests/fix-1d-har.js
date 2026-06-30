// Generate HAR with non-target entries for 1d test
module.exports = {
  log: {
    version: '1.2',
    entries: [
      {
        request: { url: 'https://example.com/api/data', method: 'GET', headers: [], queryString: [] },
        response: { status: 200, content: { size: 100, mimeType: 'text/html' } }
      }
    ]
  }
};
