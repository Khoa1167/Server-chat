const http = require('http');
const assert = require('assert');

const TEST_URL = process.env.TEST_URL || 'http://localhost:5000';
const parsedUrl = new URL(TEST_URL);
const HOST = parsedUrl.hostname;
const PORT = parsedUrl.port || 80;

// Cookie-jar tối giản — server giờ dùng cookie (token httpOnly + csrf_token) thay vì trả token
// trong body, nên request sau phải tự mang theo cookie nhận được từ response trước.
const jar = {};
const parseSetCookie = (setCookieHeader) => {
  if (!setCookieHeader) return;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // Set-Cookie rỗng (Max-Age=0) = server xóa cookie (vd logout) — xóa luôn khỏi jar để request
    // sau không vô tình còn gửi lại cookie đã bị thu hồi.
    if (!value) delete jar[name];
    else jar[name] = value;
  }
};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// withCsrf=true (mặc định) tự gắn X-CSRF-Token từ cookie csrf_token đã nhận trước đó — khớp
// hành vi thật của client (client/src/api/client.js). Set false để cố tình test thiếu CSRF.
const sendRequest = (method, path, body = null, { headers = {}, withCsrf = true } = {}) => {
  return new Promise((resolve, reject) => {
    const requestBody = body ? JSON.stringify(body) : '';
    const reqHeaders = { ...headers };
    if (cookieHeader()) reqHeaders.Cookie = cookieHeader();
    if (withCsrf && jar.csrf_token) reqHeaders['X-CSRF-Token'] = jar.csrf_token;
    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: method,
      headers: reqHeaders,
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(requestBody);
    }
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        parseSetCookie(res.headers['set-cookie']);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });
    req.on('error', (err) => reject(err));
    if (body) {
      req.write(requestBody);
    }
    req.end();
  });
};

const runTests = async () => {
  console.log("==================================================");
  console.log("🚀 Starting Automated Security Verification Tests");
  console.log(`Target: ${TEST_URL}`);
  console.log("==================================================");

  let passedCount = 0;
  let failedCount = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passedCount++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`     Reason: ${err.message}`);
      failedCount++;
    }
  };

  // 0. Lấy cookie csrf_token ban đầu (server cấp cho mọi request, kể cả chưa đăng nhập) — mọi
  // request mutate bên dưới cần cookie này để qua được middleware CSRF.
  await sendRequest('GET', '/');

  // 1. Test HTTP Security Headers
  await test("Verify HTTP Security Headers presence", async () => {
    const res = await sendRequest('GET', '/');

    // Check X-Powered-By is absent
    assert.strictEqual(res.headers['x-powered-by'], undefined, "X-Powered-By header should be hidden");

    // Check security headers presence
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', "X-Content-Type-Options should be set to nosniff");
    assert.strictEqual(res.headers['x-frame-options'], 'DENY', "X-Frame-Options should be set to DENY");
    assert.strictEqual(res.headers['x-xss-protection'], '1; mode=block', "X-XSS-Protection should be set to 1; mode=block");
    assert.strictEqual(res.headers['content-security-policy'], "default-src 'self'; frame-ancestors 'none';", "CSP should be set correctly");
    assert.strictEqual(res.headers['permissions-policy'], "camera=(), microphone=(), geolocation=()", "Permissions-Policy should be set correctly");
  });

  // 2. Test Cache-Control headers on API routes
  await test("Verify Cache-Control disabled on dynamic API routes", async () => {
    const res = await sendRequest('POST', '/api/auth/check-username', { username: 'testuser' });

    assert.strictEqual(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate', "Cache-Control should disable caching");
    assert.strictEqual(res.headers['pragma'], 'no-cache', "Pragma should be set to no-cache");
    assert.strictEqual(res.headers['expires'], '0', "Expires should be set to 0");
  });

  // 3. Test NoSQL Injection block in login
  await test("Verify NoSQL Injection protection in /api/auth/login", async () => {
    const injectionPayload = {
      username: { "$ne": "" },
      password: "any"
    };
    const res = await sendRequest('POST', '/api/auth/login', injectionPayload);

    assert.strictEqual(res.statusCode, 400, "Should return 400 Bad Request for invalid username parameter type");
    const json = JSON.parse(res.body);
    assert.strictEqual(json.message, 'Tên tài khoản hoặc mật khẩu không hợp lệ', "Should return invalid credentials message");
  });

  // 4. Test NoSQL Injection block in check-username
  await test("Verify NoSQL Injection protection in /api/auth/check-username", async () => {
    const injectionPayload = {
      username: { "$gt": "" }
    };
    const res = await sendRequest('POST', '/api/auth/check-username', injectionPayload);

    // Route trả 200 + available:false cho MỌI input sai kiểu (không phân biệt status riêng cho
    // injection) — an toàn vì isValidUsername() chặn typeof !== 'string' TRƯỚC KHI chạm
    // User.findOne(), object payload không bao giờ tới được truy vấn Mongo.
    assert.strictEqual(res.statusCode, 200, "Should return 200 with available:false, not error out");
    const json = JSON.parse(res.body);
    assert.strictEqual(json.available, false, "Should mark malicious/malformed username as unavailable");
  });

  // 5. Test CSRF protection — thiếu X-CSRF-Token phải bị chặn, kể cả route không cần đăng nhập
  await test("Verify CSRF protection blocks mutating request without X-CSRF-Token", async () => {
    const res = await sendRequest('POST', '/api/auth/check-username', { username: 'testuser' }, { withCsrf: false });
    assert.strictEqual(res.statusCode, 403, "Missing X-CSRF-Token should return 403");
  });

  // 6. Test Normal Valid Login — token giờ nằm trong cookie HttpOnly, không còn trong body
  await test("Verify valid user login authentication works", async () => {
    const validPayload = {
      username: 'user2',
      password: '123456'
    };
    const res = await sendRequest('POST', '/api/auth/login', validPayload);

    assert.strictEqual(res.statusCode, 200, "Valid login should return 200 OK");
    const json = JSON.parse(res.body);
    assert.strictEqual(json.user.username, 'user2', "Should return user details");
    assert.strictEqual(json.token, undefined, "Token should NOT be in response body anymore");
    const setCookie = (res.headers['set-cookie'] || []).join(';');
    assert.ok(/token=/.test(setCookie), "Should set token cookie");
    assert.ok(/HttpOnly/i.test(setCookie), "Token cookie should be HttpOnly");
    assert.ok(/SameSite=Lax/i.test(setCookie), "Token cookie should be SameSite=Lax");
  });

  // 7. Cookie vừa nhận phải dùng được cho route bảo vệ
  await test("Verify cookie from login authenticates protected route", async () => {
    const res = await sendRequest('GET', '/api/auth/me');
    assert.strictEqual(res.statusCode, 200, "/me should succeed with cookie from login");
  });

  console.log("==================================================");
  console.log(`📊 Test Summary: ${passedCount} passed, ${failedCount} failed`);
  console.log("==================================================");

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runTests().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
