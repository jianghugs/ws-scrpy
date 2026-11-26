// 验证 index.ts 的参数解析：?query 与 #! 两种写法都要能读到
const fs = require('fs');
const src = fs.readFileSync('/data/ws-scrcpy-new/src/app/index.ts', 'utf8');
const lines = src.split('\n');

const start = lines.findIndex((l) => l.includes('const hash = location.hash'));
const end = lines.findIndex((l) => l.includes("const action = parsedQuery.get('action');"));
if (start < 0 || end < 0) { console.log('FAIL: 找不到解析代码块'); process.exit(1); }

// 去掉 TS 类型标注（: string）以便直接执行
const block = lines.slice(start, end + 1).join('\n').replace(/:\s*string/g, '');
console.log('提取代码块行数:', end - start + 1, '\n');

const parse = new Function('location', block + '\nreturn parsedQuery;');
let failed = 0;

function check(name, loc, expectAction, expectHide) {
  const pq = parse(loc);
  const action = pq.get('action');
  const hide = pq.get('hideToolbar');
  const ok = action === expectAction && hide === expectHide;
  if (!ok) failed++;
  console.log(
    name.padEnd(34),
    'action=' + String(action).padEnd(14),
    'hideToolbar=' + String(hide).padEnd(6),
    ok ? 'PASS' : 'FAIL'
  );
}

// 1. 参数全在 #! 里（原生写法）
check('全在 #! 里', { hash: '#!action=stream&udid=a&hideToolbar=1', search: '' }, 'stream', '1');

// 2. hideToolbar 在 ?query 里（用户测试的写法）
check('hideToolbar 在 ?query', { hash: '#!action=stream&udid=a', search: '?key=k&hideToolbar=1' }, 'stream', '1');

// 3. 两边都有同名参数，hash 优先
check('冲突时 hash 优先', { hash: '#!action=stream&hideToolbar=0', search: '?hideToolbar=1' }, 'stream', '0');

// 4. 都没有
check('都没传', { hash: '#!action=stream&udid=a', search: '?key=k' }, 'stream', null);

// 5. 上游 fitToScreen 写在 ?query
const pq = parse({ hash: '#!action=stream&udid=a', search: '?key=k&fitToScreen=1&captureKeyboard=1' });
const ft = pq.get('fitToScreen') === '1' && pq.get('captureKeyboard') === '1';
if (!ft) failed++;
console.log('fitToScreen/captureKeyboard 在 ?query'.padEnd(34), ft ? 'PASS' : 'FAIL');

// 6. key 不会被误当作 action
const pq2 = parse({ hash: '', search: '?key=abc&hideToolbar=1' });
const ok6 = pq2.get('action') === null && pq2.get('hideToolbar') === '1';
if (!ok6) failed++;
console.log('只有 ?query 且无 action（首页）'.padEnd(34), ok6 ? 'PASS' : 'FAIL');

console.log('\n' + (failed === 0 ? '全部 PASS' : failed + ' 项 FAIL'));
process.exit(failed === 0 ? 0 : 1);
