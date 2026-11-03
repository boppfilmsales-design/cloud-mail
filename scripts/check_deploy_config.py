#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署前自检：确认 wrangler 配置里的绑定完整，避免把线上部署坏。

背景
----
Cloud Mail 的 wrangler 配置有两份：
  · mail-worker/wrangler-action.toml  —— CI 部署用（绑定由 Secrets 注入）
  · mail-worker/wrangler.toml        —— 本地部署用（绑定写死在文件里）

上游默认状态下，这两份文件的绑定段都是**注释掉的**。
如果直接 `wrangler deploy`，wrangler 不会报错，但会**静默丢弃所有绑定**，
线上表现为「D1数据库未绑定 / KV database not bound」，站点实际不可用。

本脚本在部署前检查，缺绑定就明确报错并给出修复方法。

用法
----
  python check_deploy_config.py                 # 检查本地 wrangler.toml
  python check_deploy_config.py --config path   # 检查指定文件
  python check_deploy_config.py --fix           # 自动启用被注释的绑定段
"""
import argparse
import re
import sys
from pathlib import Path

# 真实资源 ID（与 GitHub Secrets 中的值一致）
EXPECTED = {
    "d1": {"binding": "db", "database_id": "8690dcbb-b344-4818-9a09-d9b1fffc303c"},
    "kv": {"binding": "kv", "id": "837a3e2f18cc4d7e83ca617b1fe65964"},
    "r2": {"binding": "r2", "bucket_name": "cloud-mail-r2"},
}

REQUIRED_VARS = {
    "domain": '["apigcl.com","worldman88.ccwu.cc"]',
    "admin": "admin@apigcl.com",
    "jwt_secret": "web3worldman88",
}


def load(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def has_binding(text: str, kind: str) -> bool:
    """判断绑定段是否处于「启用」状态（未被注释）。"""
    return re.search(rf"^\[\[{kind}\]\]", text, re.M) is not None


def has_var(text: str, name: str) -> bool:
    """判断 [vars] 里的变量是否启用（行首不是 #）。"""
    return re.search(rf"^{name}\s*=", text, re.M) is not None


def fix(text: str) -> str:
    """自动启用被注释的绑定段与 vars。

    需要处理两种注释形态：
      #[[d1_databases]]   整段被注释（上游默认写法）
      #[d1_databases]     段头被注释但内部是正常 key/value
    """
    out = text

    # 删除「已存在但被注释」的整段（含段内所有 key），
    # 避免修复后出现重复 key 导致 TOML 解析失败。
    # 段体范围：从被注释的段头到下一个段头（以 [ 开头且非注释）为止。
    for kind in ("d1_databases", "kv_namespaces", "r2_buckets", "send_email"):
        pat = re.compile(
            rf"^#+\[\[{kind}\]\].*\n"          # 被注释的段头
            rf"(?:(?!^\[)[^\n]*\n)*",           # 段内非段头行
            re.M)
        out = pat.sub("", out, count=1)

    blocks = {
        "d1_databases": ('[[d1_databases]]\nbinding = "db"\n'
                         'database_name = "cloud-mail-db"\n'
                         f'database_id = "{EXPECTED["d1"]["database_id"]}"\n'),
        "kv_namespaces": ('[[kv_namespaces]]\nbinding = "kv"\n'
                          f'id = "{EXPECTED["kv"]["id"]}"\n'),
        "r2_buckets": ('[[r2_buckets]]\nbinding = "r2"\n'
                       f'bucket_name = "{EXPECTED["r2"]["bucket_name"]}"\n'),
        "send_email": '[[send_email]]\nname = "email"\n',
    }

    for kind, block in blocks.items():
        if has_binding(out, kind):
            continue
        # 找到被注释的段头位置，在那里插入启用版本
        pat = re.compile(rf"^#+\[\[{kind}\]\].*$", re.M)
        m = pat.search(out)
        if m:
            out = out[:m.start()] + block + out[m.end():]
        else:
            # 段头完全不存在（上游用 # 注释掉了整段，含后续注释行）
            pat2 = re.compile(rf"^#\[{kind}\].*$", re.M)
            m2 = pat2.search(out)
            if m2:
                out = out[:m2.start()] + block + out[m2.end() + 1:]
            else:
                # 找 [ai] 之类的锚点插到它前面
                anchor = re.search(r"^\[ai\]$", out, re.M)
                pos = anchor.start() if anchor else out.index("[vars]")
                out = out[:pos] + block + "\n" + out[pos:]

    for name, value in REQUIRED_VARS.items():
        # 值本身含双引号（domain 是 JSON 数组），必须用单引号包裹，
        # 否则会生成 domain = "["a.com","b.com"]" 这种嵌套引号 ——
        # TOML 解析失败，wrangler 会静默丢弃所有绑定。
        if '"' in value:
            literal = f"{name} = '{value}'"
        else:
            literal = f'{name} = "{value}"'
        out = re.sub(rf"^#+\s*{name}\s*=.*$", literal, out,
                     count=1, flags=re.M)

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="mail-worker/wrangler.toml")
    ap.add_argument("--fix", action="store_true", help="自动启用被注释的绑定")
    args = ap.parse_args()

    path = Path(args.config)
    if not path.is_file():
        print(f"✗ 找不到配置文件: {path}")
        return 1

    text = load(path)
    problems = []

    for kind in ("d1_databases", "kv_namespaces", "r2_buckets", "send_email"):
        if not has_binding(text, kind):
            problems.append(f"绑定 [[{kind}]] 未启用（仍是注释状态）")

    for name in REQUIRED_VARS:
        if not has_var(text, name):
            problems.append(f"变量 {name} 未启用")

    if problems:
        print(f"✗ {path} 配置不完整，部署会导致线上绑定丢失：")
        for p in problems:
            print(f"    · {p}")

        if args.fix:
            fixed = fix(text)
            if fixed != text:
                path.write_text(fixed, encoding="utf-8")
                print()
                print("✓ 已自动修复，重新检查：")
                return main()
            print()
            print("⚠️ 自动修复未能处理全部问题，请手动检查。")
        else:
            print()
            print("运行 `python check_deploy_config.py --fix` 可自动修复，")
            print("或手动取消注释并填入正确的资源 ID。")
        return 1

    print(f"✓ {path} 配置完整，绑定与变量均已启用。")
    print()
    print("  D1  =", EXPECTED["d1"]["database_id"])
    print("  KV  =", EXPECTED["kv"]["id"])
    print("  R2  =", EXPECTED["r2"]["bucket_name"])
    print("  邮件域名 =", REQUIRED_VARS["domain"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
