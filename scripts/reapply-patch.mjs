#!/usr/bin/env node
/**
 * reapply-patch.mjs —— 补丁自动重放器
 *
 * 用途：跟随上游自动升级时，把「转发补丁」重新应用到新版 email.js 上。
 *
 * ═══ 为什么需要它 ═══
 *   本仓库对上游 email/email.js 只做两处极小改动（1 行 import + 1 行调用）。
 *   上游升级时 git merge 几乎必然在这两处冲突。
 *   本脚本用「语义定位」而非行号定位，把补丁重新贴到新版结构上。
 *
 * ═══ 关键设计：替换而非并存 ═══
 *   上游自带一个原生转发块（用 message.forward）。
 *   补丁的功能是「用 Resend 优先转发，失败再回退 message.forward」。
 *   若两者并存 → 同一封邮件会被转发两次。
 *   因此本脚本必须【删除】上游原生转发块，再插入我们的调用。
 *
 *   判定上游原生块的特征（三个同时满足）：
 *     ① 注释含「转发到其他邮箱」
 *     ② 代码含 settingConst.forwardStatus.OPEN
 *     ③ 代码含 message.forward 且【不含】sendByResend
 *   条件 ③ 是关键 —— 它保证不会误删已经是补丁版的块。
 *
 * ═══ 幂等 ═══
 *   可重复执行，不会重复插入。
 *
 * 用法：node scripts/reapply-patch.mjs [--check]
 *   --check  只检查不修改（CI 校验补丁是否完好）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(__dirname, '..', 'mail-worker', 'src', 'email', 'email.js');
const CHECK_ONLY = process.argv.includes('--check');

const IMPORT_LINE = "import forwardService from '../service/forward-service';";
const CALL_BLOCK =
	'// 转发到其他邮箱（自定义补丁：Resend 优先 + 失败回退 + 同域跳过）\n' +
	'\t\t// 逻辑见 service/forward-service.js\n' +
	'\t\tawait forwardService.forward({ env }, { message, email, params, attachments, resendTokens });';

let src = fs.readFileSync(TARGET, 'utf-8');
const original = src;
const changes = [];

/**
 * 从「//转发到其他邮箱」注释开始，找到配对的结束括号，返回整块文本。
 * 用于精确删除上游原生转发块。
 */
function extractForwardBlock(text) {
	const marker = text.indexOf('//转发到其他邮箱');
	if (marker === -1) return null;

	// 回退到该行行首（含缩进）
	const lineStart = text.lastIndexOf('\n', marker) + 1;

	// 从 marker 起找 "if (" 后的第一个 "{"，然后做括号配对
	const ifIdx = text.indexOf('if (', marker);
	if (ifIdx === -1) return null;
	const braceStart = text.indexOf('{', ifIdx);
	if (braceStart === -1) return null;

	let depth = 0;
	let end = -1;
	for (let i = braceStart; i < text.length; i++) {
		const ch = text[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	if (end === -1) return null;

	// 把结尾的 } 之后到行尾的空白一起吃掉
	let blockEnd = end + 1;
	while (blockEnd < text.length && (text[blockEnd] === '\t' || text[blockEnd] === ' ')) blockEnd++;

	return { start: lineStart, end: blockEnd, text: text.slice(lineStart, blockEnd) };
}

// ---------------------------------------------------------------- 1. 删除上游原生转发块
const existing = extractForwardBlock(src);
if (existing) {
	const isPatchVersion = existing.text.includes('sendByResend') || existing.text.includes('forwardService');
	const isNative = existing.text.includes('settingConst.forwardStatus.OPEN') &&
		existing.text.includes('message.forward') &&
		!isPatchVersion;

	if (isNative) {
		src = src.slice(0, existing.start) + src.slice(existing.end);
		changes.push('移除上游原生转发块（避免与补丁重复转发）');
	} else if (isPatchVersion) {
		// 已是补丁版，跳过删除，后续会确保调用存在
	}
}

// ---------------------------------------------------------------- 2. import
if (!src.includes(IMPORT_LINE)) {
	const importRe = /^import .* from '\.\.\/service\/[^']+';$/gm;
	let anchor = null, m;
	while ((m = importRe.exec(src)) !== null) anchor = m[0];

	if (!anchor) {
		const allImports = [...src.matchAll(/^import .*;$/gm)];
		if (allImports.length === 0) {
			console.error('✗ 找不到任何 import 语句，无法定位插入点');
			process.exit(2);
		}
		const last = allImports[allImports.length - 1];
		src = src.slice(0, last.index + last[0].length) + '\n' + IMPORT_LINE + src.slice(last.index + last[0].length);
	} else {
		src = src.replace(anchor, anchor + '\n' + IMPORT_LINE);
	}
	changes.push('新增 import: forwardService');
}

// ---------------------------------------------------------------- 3. 解构补 resendTokens
// 上游 v3.4 起移除了解构里的 resendTokens（它只在发件用），但收件转发仍需要
const destructureMatch = src.match(/const\s*\{([^}]*)\}\s*=\s*await settingService\.query\(\{\s*env\s*\}\);/);
if (!destructureMatch) {
	console.error('✗ 找不到 settingService.query 的解构语句，无法确保 resendTokens');
	process.exit(2);
}
if (!/\bresendTokens\b/.test(destructureMatch[1])) {
	const fields = destructureMatch[1];
	let newFields = fields.replace(/(\n\s*forwardEmail,)/, '$1\n\t\t\tresendTokens,');
	if (newFields === fields) {
		newFields = fields.replace(/\s*$/, '\n\t\t\tresendTokens,\n\t\t');
	}
	src = src.replace(destructureMatch[0], destructureMatch[0].replace(fields, newFields));
	changes.push('解构中补回 resendTokens');
}

// ---------------------------------------------------------------- 4. 插入调用
if (!src.includes('forwardService.forward(')) {
	// 锚点：转发到TG 块之后（上游注释格式为「//转发到TG」）
	const tgBlock = /(\t\t\/\/转发到TG[\s\S]*?\n\t\t\}\n)/;
	if (tgBlock.test(src)) {
		src = src.replace(tgBlock, `$1\n\t\t${CALL_BLOCK}\n`);
		changes.push('插入 forwardService.forward 调用（转发到TG 之后）');
	} else {
		const webhookBlock = /(\t\t\/\/转发到 Webhook)/;
		if (webhookBlock.test(src)) {
			src = src.replace(webhookBlock, `\t\t${CALL_BLOCK}\n\n$1`);
			changes.push('插入 forwardService.forward 调用（Webhook 块之前）');
		} else {
			console.error('✗ 找不到插入锚点（转发到TG / 转发到 Webhook 块）');
			process.exit(2);
		}
	}
}

// ---------------------------------------------------------------- 5. 校验
const checks = [
	['import 已就位', src.includes(IMPORT_LINE)],
	['调用已就位', src.includes('forwardService.forward(')],
	['resendTokens 已解构', /const\s*\{[^}]*resendTokens[^}]*\}\s*=\s*await settingService\.query/.test(src)],
	['转发到TG 块保留', src.includes('转发到TG')],
	['上游原生转发块已移除', !extractForwardBlock(src)],
];

let failed = false;
for (const [name, ok] of checks) {
	if (!ok) { console.error(`  ✗ ${name}`); failed = true; }
	else { console.log(`  ✓ ${name}`); }
}

if (failed) {
	console.error('\n✗ 补丁重放失败：上游结构变化超出预期，需人工介入');
	process.exit(1);
}

if (CHECK_ONLY) {
	if (src === original) {
		console.log('\n✓ 补丁完好，无需重放');
	} else {
		console.log('\n✗ --check 模式发现补丁缺失，需要重放');
		process.exit(1);
	}
	process.exit(0);
}

if (src === original) {
	console.log('\n✓ 补丁已存在，无需改动');
} else {
	fs.writeFileSync(TARGET, src, 'utf-8');
	console.log(`\n✓ 补丁已重放（${changes.length} 处改动）：`);
	changes.forEach(c => console.log(`   · ${c}`));
}
