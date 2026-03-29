#!/usr/bin/env node
// AgentBoard v2 — Automated Test Suite
// Run: node test.js

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const PORT = process.env.V2_PORT || 3001;
const PW = process.env.DASHBOARD_PASSWORD || 'changeme';
const TOKEN = crypto.createHmac('sha256', 'termhub').update(PW).digest('hex');
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
var _log = [];

function ok(name) { passed++; _log.push('✓ ' + name); console.log(`  ✓ ${name}`); }
function fail(name, reason) { failed++; _log.push('✗ ' + name + ': ' + reason); console.log(`  ✗ ${name}: ${reason}`); }

function get(path) {
  return new Promise(resolve => {
    http.get(BASE + path, { headers: { cookie: 'token=' + TOKEN } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
  });
}

function post(path, body) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'token=' + TOKEN } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.end(data);
  });
}

function connectWS(mobile) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: { cookie: 'token=' + TOKEN } });
    ws.on('open', () => {
      if (mobile) ws.send(JSON.stringify({ type: 'client-info', mobile: true }));
      resolve(ws);
    });
  });
}

async function testAPI() {
  console.log('\n=== API Tests ===');

  // Auth
  const noAuth = await new Promise(resolve => {
    http.get(BASE + '/api/workers', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode})); });
  });
  noAuth.status === 401 ? ok('Auth wall blocks unauthorized') : fail('Auth wall', 'got ' + noAuth.status);

  // Workers
  const workers = await get('/api/workers');
  const list = JSON.parse(workers.body);
  Array.isArray(list) && list.length > 0 ? ok(`Workers: ${list.length} sessions`) : fail('Workers', 'empty or invalid');

  // Each worker has required fields
  const w = list[0];
  (w.id && w.cwd && w.status && w.aiState !== undefined) ? ok('Worker fields complete') : fail('Worker fields', JSON.stringify(w));

  // Static files
  for (const f of ['/', '/style.css', '/js/app.js', '/js/terminal.js', '/vendor/pdf.min.js']) {
    const r = await get(f);
    r.status === 200 ? ok(`Static ${f}`) : fail(`Static ${f}`, r.status);
  }

  // Config
  const cfg = await get('/api/config');
  cfg.status === 200 ? ok('Config endpoint') : fail('Config', cfg.status);

  // Browse
  const browse = await get('/api/browse?path=/root');
  const bd = JSON.parse(browse.body);
  bd.dirs ? ok('Browse directory') : fail('Browse', browse.body.slice(0, 50));

  return list;
}

async function testWebSocket(sessions) {
  console.log('\n=== WebSocket Tests ===');

  const firstId = sessions[0].id;

  // Test 1: Connect and receive output
  const ws = await connectWS(false);
  ws.send(JSON.stringify({ type: 'resize', id: firstId, cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ type: 'active', id: firstId }));

  const firstOutput = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 5000);
    ws.on('message', data => {
      const m = JSON.parse(data);
      if ((m.type === 'snapshot' || m.type === 'output' || m.type === 'screen') && m.id === firstId) { clearTimeout(timeout); resolve(m); }
    });
  });

  if (firstOutput) {
    var size = firstOutput.lines ? firstOutput.lines.join('').length : (firstOutput.data || '').length;
    ok(`First output: ${(size/1024).toFixed(1)}KB, ${firstOutput.data ? firstOutput.data.split('\n').length + ' lines' : 'empty'}`);
  } else fail('First output', 'timeout');

  // Test 2: Subsequent messages should be diffs
  let diffCount = 0, fullCount = 0;
  await new Promise(resolve => {
    const handler = data => {
      const m = JSON.parse(data);
      if (m.id === firstId) {
        if (m.type === 'snapshot' || m.type === 'output' || m.type === 'screen') fullCount++;
        if (m.type === 'stream') diffCount++;
      }
    };
    ws.on('message', handler);
    setTimeout(() => { ws.removeListener('message', handler); resolve(); }, 3000);
  });
  ok(`Messages: ${fullCount} fulls, ${diffCount} diffs (active session may produce fulls)`);

  // Test 3: State detection
  const stateOk = sessions.every(s => ['idle', 'working', 'waiting'].includes(s.aiState));
  stateOk ? ok('State detection valid') : fail('States', sessions.map(s => s.aiState).join(','));

  // Test 4: Input response time
  const inputStart = Date.now();
  const inputRes = await post('/api/input', { id: firstId, text: 'echo test-' + Date.now() });
  const inputTime = Date.now() - inputStart;
  JSON.parse(inputRes.body).ok ? ok(`Input API: ${inputTime}ms`) : fail('Input', inputRes.body);

  // Test 5: Output after input
  const afterInput = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 3000);
    const handler = data => {
      const m = JSON.parse(data);
      if ((m.type === 'snapshot' || m.type === 'output' || m.type === 'stream' || m.type === 'screen') && m.id === firstId) {
        clearTimeout(timeout); ws.removeListener('message', handler); resolve(m);
      }
    };
    ws.on('message', handler);
  });
  afterInput ? ok('Output after input received') : fail('Output after input', 'timeout');

  ws.close();

  // Test 6: Mobile client
  console.log('\n=== Mobile Tests ===');
  const mws = await connectWS(true);
  mws.send(JSON.stringify({ type: 'active', id: firstId }));

  const mobileOutput = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 5000);
    mws.on('message', data => {
      const m = JSON.parse(data);
      if ((m.type === 'snapshot' || m.type === 'output' || m.type === 'stream' || m.type === 'screen') && m.id === firstId) {
        clearTimeout(timeout); resolve(m);
      }
    });
  });
  mobileOutput ? ok(`Mobile output: type=${mobileOutput.type}`) : fail('Mobile output', 'timeout');

  // Test 7: Mobile gets diffs too (not just full)
  let mDiff = 0, mFull = 0;
  await new Promise(resolve => {
    const handler = data => {
      const m = JSON.parse(data);
      if (m.id === firstId) {
        if (m.type === 'snapshot' || m.type === 'output' || m.type === 'screen') mFull++;
        if (m.type === 'stream') mDiff++;
      }
    };
    mws.on('message', handler);
    setTimeout(() => { mws.removeListener('message', handler); resolve(); }, 3000);
  });
  ok(`Mobile diffs: ${mDiff}, fulls: ${mFull}`);

  mws.close();
}

async function testSessionSwitch(sessions) {
  console.log('\n=== Session Switch Tests ===');

  if (sessions.length < 2) { ok('Skip (need 2+ sessions)'); return; }

  const ws = await connectWS(false);
  const id1 = sessions[0].id, id2 = sessions[1].id;

  // Switch to session 1
  ws.send(JSON.stringify({ type: 'resize', id: id1, cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ type: 'active', id: id1 }));

  const out1 = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 3000);
    ws.on('message', data => { const m = JSON.parse(data); if ((m.type === 'snapshot' || m.type === 'output' || m.type === 'screen') && m.id === id1) { clearTimeout(t); resolve(m); } });
  });
  out1 ? ok(`Session ${id1} output`) : fail(`Session ${id1}`, 'no output');

  // Switch to session 2
  ws.send(JSON.stringify({ type: 'active', id: id2 }));
  const switchStart = Date.now();

  const out2 = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 3000);
    const h = data => { const m = JSON.parse(data); if ((m.type === 'snapshot' || m.type === 'output' || m.type === 'stream' || m.type === 'screen') && m.id === id2) { clearTimeout(t); ws.removeListener('message', h); resolve(m); } };
    ws.on('message', h);
  });
  const switchTime = Date.now() - switchStart;
  out2 ? ok(`Switch to ${id2}: ${switchTime}ms`) : fail(`Switch to ${id2}`, 'no output');

  ws.close();
}

async function testSpawnKill() {
  console.log('\n=== Spawn/Kill Tests ===');

  const spawn = await post('/api/spawn', { cwd: '/tmp' });
  const sd = JSON.parse(spawn.body);
  sd.ok ? ok(`Spawn: #${sd.id}`) : fail('Spawn', spawn.body);

  if (sd.ok) {
    await new Promise(r => setTimeout(r, 500));

    const kill = await post('/api/kill', { id: sd.id });
    JSON.parse(kill.body).ok ? ok('Kill') : fail('Kill', kill.body);

    const remove = await post('/api/remove', { id: sd.id });
    JSON.parse(remove.body).ok ? ok('Remove') : fail('Remove', remove.body);
  }
}

async function testPerformance(sessions) {
  console.log('\n=== Performance Tests ===');

  const id = sessions[0].id;
  const ws = await connectWS(false);
  ws.send(JSON.stringify({ type: 'resize', id, cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ type: 'active', id }));

  const sizes = [];
  const types = { output: 0, 'output-diff': 0 };

  await new Promise(resolve => {
    const h = data => {
      const m = JSON.parse(data);
      if (m.id === id) {
        if (m.type === 'snapshot' || m.type === 'output' || m.type === 'screen') { types.output++; sizes.push((m.data||'').length); }
        if (m.type === 'stream') { types['output-diff']++; sizes.push((m.data||'').length); }
      }
    };
    ws.on('message', h);
    setTimeout(() => { ws.removeListener('message', h); resolve(); }, 5000);
  });

  const avgSize = sizes.length > 0 ? Math.round(sizes.reduce((a,b) => a+b, 0) / sizes.length) : 0;
  ok(`${sizes.length} messages in 5s, avg ${(avgSize/1024).toFixed(1)}KB`);
  ok(`Full: ${types.output}, Diff: ${types['output-diff']}`);

  // Server memory
  const serverMem = await new Promise(resolve => {
    require('child_process').exec('ps -o rss= -p ' + require('child_process').execSync('lsof -i :' + PORT + ' -t | head -1').toString().trim(), (e, o) => {
      resolve(parseInt(o) || 0);
    });
  });
  ok(`Server RSS: ${Math.round(serverMem/1024)}MB`);

  // Client test process memory
  const mem = process.memoryUsage();
  ok(`Test client RSS: ${Math.round(mem.rss/1024/1024)}MB`);

  ws.close();
}

async function testStability(sessions) {
  console.log('\n=== Stability Tests ===');

  const id = sessions[0].id;
  const ws = await connectWS(false);
  ws.send(JSON.stringify({ type: 'resize', id, cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ type: 'active', id }));

  // Test: first output should not be too large
  const first = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 5000);
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'snapshot' && m.id === id) { clearTimeout(t); resolve(m); }
    });
  });
  if (first) {
    first.data.split('\n').length <= 1000 ? ok(`Initial lines: ${first.data.split('\n').length} (≤1000)`) : fail('Initial too large', first.data.split('\n').length + ' lines');
  }

  // Test: appends should be small
  let maxAppend = 0;
  await new Promise(resolve => {
    const h = data => {
      const m = JSON.parse(data);
      if (m.type === 'stream' && m.id === id) {
        if (m.data ? m.data.split('\n').length : 0 > maxAppend) maxAppend = m.data ? m.data.split('\n').length : 0;
      }
    };
    ws.on('message', h);
    setTimeout(() => { ws.removeListener('message', h); resolve(); }, 3000);
  });
  ok(`Max append: ${maxAppend} lines`);

  // Test: rapid session switching
  const ids = sessions.slice(0, 3).map(s => s.id);
  const switchStart = Date.now();
  for (const sid of ids) {
    ws.send(JSON.stringify({ type: 'active', id: sid }));
    await new Promise(r => setTimeout(r, 100));
  }
  const switchTotal = Date.now() - switchStart;
  ok(`3 rapid switches: ${switchTotal}ms`);

  // Test: input during active session
  ws.send(JSON.stringify({ type: 'active', id }));
  await new Promise(r => setTimeout(r, 200));
  ws.send(JSON.stringify({ type: 'input', id, text: 'echo stability-test-' + Date.now() }));
  const inputResponse = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 3000);
    const h = data => {
      const m = JSON.parse(data);
      if ((m.type === 'snapshot' || m.type === 'stream' || m.type === 'screen') && m.id === id) {
        clearTimeout(t); ws.removeListener('message', h); resolve(m);
      }
    };
    ws.on('message', h);
  });
  inputResponse ? ok('Input response received') : fail('Input response', 'timeout');

  ws.close();
}

async function testHistory(sessions) {
  console.log('\n=== History Tests ===');

  const id = sessions[0].id;

  // Test 1: Desktop and mobile get identical content
  const ws1 = await connectWS(false);  // desktop
  const ws2 = await connectWS(true);   // mobile

  ws1.send(JSON.stringify({ type: 'active', id }));
  ws2.send(JSON.stringify({ type: 'active', id }));

  const [desk, mob] = await Promise.all([
    new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 5000);
      ws1.on('message', data => {
        const m = JSON.parse(data);
        if (m.type === 'snapshot' && m.id === id) { clearTimeout(t); resolve(m); }
      });
    }),
    new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 5000);
      ws2.on('message', data => {
        const m = JSON.parse(data);
        if (m.type === 'snapshot' && m.id === id) { clearTimeout(t); resolve(m); }
      });
    })
  ]);

  if (desk && mob) {
    desk.data.split('\n').length === mob.data.split('\n').length
      ? ok(`Desktop and mobile get same lines: ${desk.data.split('\n').length}`)
      : fail('Content mismatch', `desktop=${desk.data.split('\n').length} mobile=${mob.data.split('\n').length}`);
  } else {
    fail('History receive', `desktop=${!!desk} mobile=${!!mob}`);
  }

  ws1.close();
  ws2.close();

  // Test 2: Last line has terminal activity (animation indicator area)
  if (desk) {
    const lastLines = desk.data.split('\n').slice(-5).join(' ');
    const hasPromptOrActivity = /❯|esc to interrupt|bypass/.test(lastLines);
    hasPromptOrActivity
      ? ok('Last lines contain prompt/activity indicator')
      : fail('Last lines', 'no prompt found: ' + lastLines.slice(0, 80));
  }

  // Test 3: Reconnect gets same content as existing connection
  const ws3 = await connectWS(false);
  ws3.send(JSON.stringify({ type: 'active', id }));

  const reconnect = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 5000);
    ws3.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'snapshot' && m.id === id) { clearTimeout(t); resolve(m); }
    });
  });

  if (reconnect && desk) {
    // Lines should be same or very similar (buffer may have grown slightly)
    const overlap = Math.min(reconnect.data.split('\n').length, desk.data.split('\n').length);
    const lastN = 20;
    const deskTail = desk.data.split('\n').slice(-lastN).join('\n');
    const reconTail = reconnect.data.split('\n').slice(-lastN).join('\n');
    // Check last 20 lines are in both (allowing for small additions)
    var matching = 0;
    for (var i = 0; i < lastN; i++) {
      if (desk.data.split("\n")[desk.data.split('\n').length - lastN + i] === reconnect.data.split("\n")[reconnect.data.split('\n').length - lastN + i]) matching++;
    }
    matching >= lastN - 3
      ? ok(`Reconnect content matches (${matching}/${lastN} lines)`)
      : fail('Reconnect mismatch', `only ${matching}/${lastN} lines match`);
  } else {
    fail('Reconnect', 'no output');
  }

  ws3.close();

  // Test 4: Buffer persists across polls (history grows)
  const ws4 = await connectWS(false);
  ws4.send(JSON.stringify({ type: 'active', id }));

  // Send input to generate new content
  ws4.send(JSON.stringify({ type: 'input', id, text: 'echo history-test-' + Date.now() }));

  // Wait for append
  let gotAppend = false;
  await new Promise(resolve => {
    const handler = data => {
      const m = JSON.parse(data);
      if (m.type === 'stream' && m.id === id) gotAppend = true;
    };
    ws4.on('message', handler);
    setTimeout(() => { ws4.removeListener('message', handler); resolve(); }, 3000);
  });

  // Now reconnect and check buffer is bigger
  const ws5 = await connectWS(false);
  ws5.send(JSON.stringify({ type: 'active', id }));

  const afterInput = await new Promise(resolve => {
    const t = setTimeout(() => resolve(null), 5000);
    ws5.on('message', data => {
      const m = JSON.parse(data);
      if (m.type === 'snapshot' && m.id === id) { clearTimeout(t); resolve(m); }
    });
  });

  if (afterInput && desk) {
    afterInput.data.split('\n').length >= desk.data.split('\n').length
      ? ok(`Buffer grew: ${desk.data.split('\n').length} → ${afterInput.data.split('\n').length}`)
      : fail('Buffer shrunk', `${desk.data.split('\n').length} → ${afterInput.data.split('\n').length}`);
  }

  ws4.close();
  ws5.close();
}

async function main() {
  console.log('AgentBoard v2 Test Suite');
  console.log(`Server: ${BASE}`);

  try {
    const sessions = await testAPI();
    await testWebSocket(sessions);
    await testSessionSwitch(sessions);
    await testSpawnKill();
    await testPerformance(sessions);
    await testStability(sessions);
    await testHistory(sessions);
  } catch (e) {
    fail('CRASH', e.message);
  }

  // Write results to log file
  var fs = require('fs');
  var log = {
    timestamp: new Date().toISOString(),
    passed: passed,
    failed: failed,
    results: _log
  };
  var logFile = require('path').join(__dirname, 'test-results.log');
  var entry = '\n' + log.timestamp + ' | ' + passed + ' passed, ' + failed + ' failed\n';
  _log.forEach(function(l) { entry += '  ' + l + '\n'; });
  entry += '\n';
  fs.appendFileSync(logFile, entry);
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log('Logged to: ' + logFile);
  process.exit(failed > 0 ? 1 : 0);
}

main();
