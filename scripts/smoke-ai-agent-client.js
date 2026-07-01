#!/usr/bin/env node
'use strict';

const http = require('http');
const { AiAgentClient } = require('../backend/services/ai-agent-client');

function readJson(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function assertOk(name, condition, detail) {
  if (!condition) {
    console.error(`[FAIL] ${name}: ${detail || ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[PASS] ${name}`);
}

async function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.url === '/v1/chat/completions') {
      return sendJson(res, 200, {
        model: body.model,
        choices: [
          { message: { content: '{"tool":"run_best_chain","input":{"dryRun":true},"reason":"mock openai compatible"}' } }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    }
    if (req.url === '/v1/messages') {
      return sendJson(res, 200, {
        model: body.model,
        content: [
          { type: 'text', text: '{"tool":"get_chain_status","input":{},"reason":"mock anthropic native"}' }
        ],
        usage: { input_tokens: 1, output_tokens: 1 }
      });
    }
    return sendJson(res, 404, { error: 'not found', url: req.url });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

(async () => {
  const { server, baseUrl } = await startMockServer();
  try {
    const openai = new AiAgentClient({
      mode: 'dry_run',
      type: 'openai_compatible',
      baseUrl,
      apiKey: 'test-key',
      modelId: 'mock-openai-model'
    });
    const openaiResult = await openai.completeJson({
      system: 'Return JSON only.',
      payload: { message: 'run best chain' }
    });
    assertOk('openai-compatible client extracts JSON', openaiResult.success && openaiResult.parsed.tool === 'run_best_chain', JSON.stringify(openaiResult));

    const anthropic = new AiAgentClient({
      mode: 'dry_run',
      type: 'anthropic_native',
      baseUrl,
      apiKey: 'test-key',
      modelId: 'mock-claude-model'
    });
    const anthropicResult = await anthropic.completeJson({
      system: 'Return JSON only.',
      payload: { message: 'status' }
    });
    assertOk('anthropic-native client extracts JSON', anthropicResult.success && anthropicResult.parsed.tool === 'get_chain_status', JSON.stringify(anthropicResult));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('[smoke-ai-agent-client] failed:', error);
  process.exit(1);
});
