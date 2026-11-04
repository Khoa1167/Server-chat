const assert = require('node:assert/strict');
const test = require('node:test');

const aiService = require('../src/services/ai.service');

const originalFetch = global.fetch;
const originalKey = process.env.GEMINI_API_KEY;
const originalTimeout = process.env.GEMINI_TIMEOUT_MS;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
  if (originalTimeout === undefined) delete process.env.GEMINI_TIMEOUT_MS;
  else process.env.GEMINI_TIMEOUT_MS = originalTimeout;
});

test('Gemini trả nội dung hợp lệ và nhận đúng lịch sử', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: ' Xin chào ' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const reply = await aiService.getReply([{ role: 'user', content: 'Chào' }]);

  assert.equal(reply, 'Xin chào');
  assert.match(request.url, /:generateContent$/);
  assert.deepEqual(JSON.parse(request.options.body).contents, [
    { role: 'user', parts: [{ text: 'Chào' }] },
  ]);
  assert.equal(JSON.parse(request.options.body).generationConfig.maxOutputTokens, 800);
});

test('Gemini response luôn nằm trong giới hạn lưu trữ của tin nhắn AI', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'a'.repeat(5000) }] } }],
  }), { status: 200 });

  const reply = await aiService.getReply([{ role: 'user', content: 'Chào' }]);
  assert.equal(reply.length, 4000);
  assert.equal(reply.at(-1), '…');
});

test('Gemini response rỗng bị từ chối', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });

  await assert.rejects(
    aiService.getReply([{ role: 'user', content: 'Chào' }]),
    { statusCode: 502 },
  );
});

test('Gemini 429 báo hết hạn mức ngay, không retry kể cả khi body không phải JSON', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('busy', { status: 429 });
  };

  await assert.rejects(
    aiService.getReply([{ role: 'user', content: 'Chào' }]),
    { statusCode: 429, extra: { code: 'AI_QUOTA_EXCEEDED' } },
  );
  assert.equal(calls, 1);
});

test('Gemini retry 503 ngay cả khi body không phải JSON', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Đã sẵn sàng' }] } }],
    }), { status: 200 });
  };

  assert.equal(await aiService.getReply([{ role: 'user', content: 'Chào' }]), 'Đã sẵn sàng');
  assert.equal(calls, 2);
});

test('Gemini request hết thời gian bị hủy', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_TIMEOUT_MS = '10';
  global.fetch = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });

  await assert.rejects(
    aiService.getReply([{ role: 'user', content: 'Chào' }]),
    { statusCode: 504 },
  );
});
