/**
 * forward-service.js —— 邮件转发服务（自定义补丁，独立模块）
 *
 * ★ 这个文件是「自有代码」，不随上游版本变动 ★
 *
 * 设计目的：让本仓库能跟随上游自动升级而不产生冲突。
 * 原本补丁直接写在 email/email.js 里，占了 50+ 行、且在解构语句中插入了字段。
 * 上游每次改动 email.js 都会导致大面积冲突，无法自动合并。
 *
 * 现在补丁逻辑全部收敛到本文件，email/email.js 里只留两行：
 *   ① import forwardService from '../service/forward-service';
 *   ② await forwardService.forward({ message, email, params, attachments, resendTokens });
 *
 * 升级时上游若改了 email.js，冲突面只剩这两行，且可用 git rerere 或
 * 自动合并脚本无冲突解决。
 *
 * 功能说明：
 *   收件时若「收件域名」配置了 Resend token，则用 Resend 转发到目标邮箱
 *   - 带上原始发件人/收件人/主题信息
 *   - 带上非内嵌附件
 *   - 主题加 [转发] 前缀便于识别
 *   Resend 失败时自动回退到 Cloudflare 原生 message.forward
 *   跳过同域名转发，避免自转循环
 */

import emailService from './email-service';
import { emailConst, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';

const forwardService = {

	/**
	 * 转发到其他邮箱
	 *
	 * @param {object} c            hono context
	 * @param {object} message      Cloudflare EmailMessage
	 * @param {object} email        PostalMime 解析结果
	 * @param {object} params       邮件入库参数（含 name / sendEmail）
	 * @param {array}  attachments  附件列表
	 * @param {object} resendTokens 域名 -> Resend token 映射
	 */
	async forward(c, { message, email, params, attachments, resendTokens }) {

		const { forwardStatus, forwardEmail } = await settingServiceQuery(c);

		if (forwardStatus !== settingConst.forwardStatus.OPEN || !forwardEmail) {
			return;
		}

		const dests = forwardEmail.split(',').map(d => d.trim()).filter(Boolean);
		if (dests.length === 0) {
			return;
		}

		const recipientDomain = emailUtils.getDomain(message.to);
		const resendToken = resendTokens ? resendTokens[recipientDomain] : undefined;

		await Promise.all(dests.map(async (dest) => {

			// 同域名转发会造成死循环，直接跳过
			if (emailUtils.getDomain(dest) === recipientDomain) {
				console.log('Skipping forward to same domain:', dest);
				return;
			}

			if (resendToken) {
				// 优先用 Resend 转发：不受 Cloudflare 原生转发限制，可带附件
				try {
					const sendResult = await emailService.sendByResend(resendToken, {
						name: params.name,
						accountEmail: message.to,
						receiveEmail: [dest],
						subject: '[转发] ' + (email.subject || ''),
						text: email.text,
						html: buildForwardHtml(params, message.to, email),
						replyTo: params.sendEmail,
						attachments: (attachments || []).filter(a => !a.contentId)
					});
					if (sendResult && sendResult.error) {
						throw new Error(sendResult.error.message || 'Resend send failed');
					}
					console.log('Forwarded via Resend to ' + dest + ':',
						sendResult && sendResult.data && sendResult.data.id);
					return;
				} catch (e) {
					console.error('Resend forward to ' + dest +
						' failed, falling back to message.forward:', e);
				}
			}

			// 回退：Cloudflare 原生转发（无 Resend token，或 Resend 失败时）
			try {
				await message.forward(dest);
			} catch (e) {
				console.error(`转发邮箱 ${dest} 失败：`, e);
			}
		}));

	}
}

/**
 * 构造转发邮件的 HTML 正文，附带原始信息便于溯源
 */
function buildForwardHtml(params, recipient, email) {
	const header = '<div>' +
		'<p>Original sender: ' + escapeHtml(params.name) + ' &lt;' + escapeHtml(params.sendEmail) + '&gt;</p>' +
		'<p>Original recipient: ' + escapeHtml(recipient) + '</p>' +
		'<p>Original subject: ' + escapeHtml(email.subject || '') + '</p>' +
		'</div><hr />';
	return header + (email.html || '');
}

/**
 * 基础 HTML 转义，防止原始邮件内容注入
 */
function escapeHtml(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * 读取系统设置（延迟引入避免循环依赖）
 */
async function settingServiceQuery(c) {
	const settingService = (await import('./setting-service')).default;
	return settingService.query(c);
}

export default forwardService;
