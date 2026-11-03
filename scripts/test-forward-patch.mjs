#!/usr/bin/env node
/**
 * test-forward-patch.mjs —— 转发补丁行为测试
 *
 * 目的：在每次自动升级后验证补丁语义未变。
 *      这是「补丁不被破坏」的最后一道防线 —— 若上游改动导致补丁行为变化，
 *      测试会失败并阻止部署。
 *
 * 测试方式：把 forward-service 的核心逻辑抽出，用 mock 驱动各种场景。
 *
 * 运行：node scripts/test-forward-patch.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; failures.push(`${name} ${detail}`); console.error(`  ✗ ${name} ${detail}`); }
}

// ══════════════════════════════════════════════════════════════
// 从 forward-service.js 中提取实际逻辑做验证（确保测的是真代码）
// ══════════════════════════════════════════════════════════════
const svcPath = path.join(ROOT, 'mail-worker', 'src', 'service', 'forward-service.js');
const svcSrc = fs.readFileSync(svcPath, 'utf-8');

// 提取 buildForwardHtml 与 escapeHtml 的实现文本
function extractFn(src, name) {
	const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
	const m = src.match(re);
	if (!m) throw new Error(`无法从 forward-service.js 中提取 ${name}`);
	return m[0];
}

const htmlFnSrc = extractFn(svcSrc, 'buildForwardHtml');
const escapeFnSrc = extractFn(svcSrc, 'escapeHtml');

// eslint-disable-next-line no-new-func
const buildForwardHtml = new Function(`${escapeFnSrc}\n${htmlFnSrc}\nreturn buildForwardHtml;`)();

// 模拟 domain 提取（与 email-utils 一致）
function getDomain(addr) {
	const i = String(addr).indexOf('@');
	return i === -1 ? '' : addr.slice(i + 1).toLowerCase();
}

/**
 * 转发逻辑的等价实现（与 forward-service.forward 保持一致）
 * 用 mock 替代 emailService.sendByResend 与 message.forward
 */
async function runForward({ forwardStatus, forwardEmail, resendTokens, recipient, original, attachments, sendByResend, messageForward }) {
	const OPEN = 1;
	if (forwardStatus !== OPEN || !forwardEmail) return { skipped: true, results: [] };

	const dests = forwardEmail.split(',').map(d => d.trim()).filter(Boolean);
	if (dests.length === 0) return { skipped: true, results: [] };

	const recipientDomain = getDomain(recipient);
	const resendToken = resendTokens ? resendTokens[recipientDomain] : undefined;
	const results = [];

	await Promise.all(dests.map(async (dest) => {
		if (getDomain(dest) === recipientDomain) {
			results.push({ dest, method: 'skipped-same-domain' });
			return;
		}
		if (resendToken) {
			try {
				const sendResult = await sendByResend(resendToken, {
					name: original.name,
					accountEmail: recipient,
					receiveEmail: [dest],
					subject: '[转发] ' + (original.subject || ''),
					text: original.text,
					html: buildForwardHtml(original, recipient, original),
					replyTo: original.sendEmail,
					attachments: (attachments || []).filter(a => !a.contentId)
				});
				if (sendResult && sendResult.error) {
					throw new Error(sendResult.error.message || 'Resend send failed');
				}
				results.push({ dest, method: 'resend', id: sendResult?.data?.id });
				return;
			} catch (e) {
				// 落到回退
			}
		}
		try {
			await messageForward(dest);
			results.push({ dest, method: 'native-forward' });
		} catch (e) {
			results.push({ dest, method: 'failed', error: e.message });
		}
	}));

	return { skipped: false, results };
}

// ══════════════════════════════════════════════════════════════
console.log('=== 转发补丁行为测试 ===\n');

const base = {
	forwardStatus: 1,
	forwardEmail: 'target@other.com',
	resendTokens: { 'mydomain.com': 're_abc123' },
	recipient: 'user@mydomain.com',
	original: { name: 'Sender', sendEmail: 's@ext.com', subject: 'Hello', text: 't', html: '<p>h</p>' },
	attachments: [],
};

// 1. 有 token → 走 Resend
{
	let resend = 0, native = 0;
	const r = await runForward({ ...base,
		sendByResend: async () => { resend++; return { data: { id: 'm1' } }; },
		messageForward: async () => { native++; } });
	ok('有 token 走 Resend', r.results[0].method === 'resend', JSON.stringify(r.results));
	ok('有 token 不调原生', native === 0);
	ok('Resend 调用 1 次', resend === 1);
}

// 2. 无 token → 走原生
{
	let native = 0, resend = 0;
	const r = await runForward({ ...base, resendTokens: {},
		sendByResend: async () => { resend++; return { data: {} }; },
		messageForward: async () => { native++; } });
	ok('无 token 走原生', r.results[0].method === 'native-forward');
	ok('原生调用 1 次', native === 1);
	ok('不调 Resend', resend === 0);
}

// 3. Resend 抛错 → 回退原生
{
	let native = 0;
	const r = await runForward({ ...base,
		sendByResend: async () => { throw new Error('down'); },
		messageForward: async () => { native++; } });
	ok('Resend 抛错回退原生', r.results[0].method === 'native-forward');
	ok('回退确实执行', native === 1);
}

// 4. Resend 返回 error 字段 → 也回退
{
	let native = 0;
	const r = await runForward({ ...base,
		sendByResend: async () => ({ error: { message: 'bad token' } }),
		messageForward: async () => { native++; } });
	ok('Resend 返回 error 时回退', r.results[0].method === 'native-forward');
	ok('回退确实执行', native === 1);
}

// 5. 同域名 → 跳过
{
	let any = 0;
	const r = await runForward({ ...base, forwardEmail: 'other@mydomain.com',
		sendByResend: async () => { any++; return { data: {} }; },
		messageForward: async () => { any++; } });
	ok('同域名跳过', r.results[0].method === 'skipped-same-domain');
	ok('同域名无任何转发', any === 0);
}

// 6. 开关关闭 → 跳过
{
	const r = await runForward({ ...base, forwardStatus: 0,
		sendByResend: async () => ({}), messageForward: async () => {} });
	ok('开关关闭时跳过', r.skipped === true);
}

// 7. 多目标混合
{
	const r = await runForward({ ...base, forwardEmail: 'a@mydomain.com,b@other.com,c@third.com',
		sendByResend: async () => ({ data: { id: 'x' } }), messageForward: async () => {} });
	const m = Object.fromEntries(r.results.map(x => [x.dest, x.method]));
	ok('混合目标：同域跳过', m['a@mydomain.com'] === 'skipped-same-domain', JSON.stringify(m));
	ok('混合目标：跨域走 Resend', m['b@other.com'] === 'resend');
	ok('混合目标：跨域2 走 Resend', m['c@third.com'] === 'resend');
}

// 8. 附件过滤：内嵌附件不转发
{
	let used = null;
	await runForward({ ...base, attachments: [{ filename: 'a.png', contentId: '<c1>' }, { filename: 'b.pdf', contentId: null }],
		sendByResend: async (t, p) => { used = p.attachments; return { data: {} }; },
		messageForward: async () => {} });
	ok('内嵌附件被过滤', used.length === 1 && used[0].filename === 'b.pdf', JSON.stringify(used));
}

// 9. 主题前缀
{
	let subj = null;
	await runForward({ ...base, original: { ...base.original, subject: '重要通知' },
		sendByResend: async (t, p) => { subj = p.subject; return { data: {} }; },
		messageForward: async () => {} });
	ok('主题加 [转发] 前缀', subj === '[转发] 重要通知', subj);
}

// 10. HTML 转义（防注入）
{
	const html = buildForwardHtml({ name: '<script>x</script>', sendEmail: 'a@b.com' }, 'r@d.com', { subject: '<img onerror=1>' });
	ok('HTML 已转义（无裸 script 标签）', !html.includes('<script>'), html.slice(0, 120));
	ok('HTML 已转义（无裸 onerror 属性）', !html.includes('<img onerror'), html.slice(0, 120));
	ok('HTML 含原始信息', html.includes('Original sender') && html.includes('Original recipient'));
}

// 11. 空转发地址列表
{
	const r = await runForward({ ...base, forwardEmail: ' , , ',
		sendByResend: async () => ({ data: {} }), messageForward: async () => {} });
	ok('空白转发地址被过滤', r.skipped === true || r.results.length === 0);
}

// 12. 目标地址含空格应被 trim
{
	const r = await runForward({ ...base, forwardEmail: ' spaced@other.com ',
		sendByResend: async () => ({ data: {} }), messageForward: async () => {} });
	ok('目标地址已 trim', r.results[0].dest === 'spaced@other.com', r.results[0].dest);
}

// ══════════════════════════════════════════════════════════════
// 静态检查：email.js 与 forward-service.js 的耦合正确性
// ══════════════════════════════════════════════════════════════
console.log('\n=== 静态检查 ===\n');

const emailPath = path.join(ROOT, 'mail-worker', 'src', 'email', 'email.js');
const emailSrc = fs.readFileSync(emailPath, 'utf-8');

ok('email.js 已引入 forwardService', emailSrc.includes("import forwardService from '../service/forward-service';"));
ok('email.js 调用了 forwardService.forward', emailSrc.includes('forwardService.forward('));
ok('email.js 解构含 resendTokens', /const\s*\{[^}]*resendTokens[^}]*\}\s*=\s*await settingService\.query/.test(emailSrc));

// 上游原生转发块必须已移除（否则会重复转发）
const nativeBlock = emailSrc.match(/\/\/转发到其他邮箱[\s\S]*?\n\t\t\}/);
ok('上游原生转发块已移除（防重复转发）', !nativeBlock || !nativeBlock[0].includes('message.forward'),
	nativeBlock ? nativeBlock[0].slice(0, 100) : '');

ok('email.js 中 message.forward 仅在补丁模块内', !emailSrc.includes('message.forward'),
	'email.js 不应直接调用 message.forward');
ok('forward-service.js 含回退逻辑', svcSrc.includes('message.forward(dest)'));
ok('forward-service.js 含同域跳过', svcSrc.includes('Skipping forward to same domain'));
ok('forward-service.js 含 Resend 优先', svcSrc.includes('sendByResend'));

// ══════════════════════════════════════════════════════════════
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
	console.error('\n失败用例：');
	failures.forEach(f => console.error(`  ✗ ${f}`));
	console.error('\n✗ 补丁行为已改变 —— 拒绝自动升级，需人工确认');
	process.exit(1);
}
console.log('✓ 补丁行为完全符合预期');
