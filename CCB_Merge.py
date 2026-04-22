#!/usr/bin/env python3
"""
分析从 main 合并到 chinese 的合并提交，生成两份清单：
1. all_merge_files.csv  - 所有合并中修改过的文件（含时间）
2. conflict_candidates.csv - 高概率冲突文件（含冲突次数、最近冲突时间）
"""

import subprocess
import sys
import os
import re
from collections import defaultdict

COMMIT_HASH_PATTERN = re.compile(r'^[0-9a-f]{40}$')

def run_cmd(cmd, check=False):
    """运行 shell 命令并返回 (returncode, stdout_lines)"""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    lines = [line for line in result.stdout.strip().split('\n') if line]
    if check:
        return result.returncode, lines
    return lines if result.returncode == 0 else []

def is_file_path(line):
    return bool(line) and not COMMIT_HASH_PATTERN.match(line)

def get_commit_time(commit_hash):
    """返回 (timestamp, readable_time)"""
    ts_out = run_cmd(f"git show -s --format=%ct {commit_hash}")
    if not ts_out:
        return 0, "未知"
    timestamp = int(ts_out[0])
    readable_out = run_cmd(f"git show -s --format=%ci {commit_hash}")
    readable = readable_out[0] if readable_out else "未知"
    return timestamp, readable

def simulate_merge_conflicts(merge_commit):
    """
    使用 git merge-tree 模拟该合并提交的三路合并。
    返回：是否有冲突的布尔值，以及冲突文件列表（如有）。
    """
    # 获取该合并提交的两个父提交
    parents = run_cmd(f"git show -s --format=%P {merge_commit}")
    if not parents or len(parents[0].split()) != 2:
        # 非标准合并提交（可能没有两个父提交）
        return False, []
    parent1, parent2 = parents[0].split()

    # 模拟三路合并，写入临时树对象
    ret_code, output = run_cmd(
        f"git merge-tree {parent1} {parent2}",
        check=True
    )
    # 如果返回非0，说明合并过程有冲突
    if ret_code != 0:
        # 从输出中提取冲突文件（带有 "++<<<<<<< .our" 等标记）
        # 简单做法：冲突文件会在输出中以特定模式出现，这里我们用另一种更稳定的方式
        # 直接调用 git merge-tree --write-tree 然后捕获冲突文件列表
        # 更可靠：使用 git merge-tree --name-only --diff-filter=U ？但 merge-tree 不支持该选项
        # 我们用 git merge-tree 的详细输出解析
        conflict_files = set()
        for line in output:
            # 冲突标记行通常包含 "changed in both" 和 " +<<<<<<<"
            if 'changed in both' in line:
                # 提取文件名，格式类似： "100644 2d0... 1\tfile.txt"
                parts = line.split('\t')
                if len(parts) >= 2:
                    conflict_files.add(parts[-1])
        return True, list(conflict_files)
    return False, []

def main():
    all_output = sys.argv[1] if len(sys.argv) > 1 else "all_merge_files.csv"
    conflict_output = sys.argv[2] if len(sys.argv) > 2 else "conflict_candidates.csv"

    if not os.path.isdir(".git"):
        print("错误：当前目录不是一个 Git 仓库。")
        sys.exit(1)

    branch_out = run_cmd("git symbolic-ref --short HEAD")
    if not branch_out:
        print("错误：当前处于 detached HEAD 状态。")
        sys.exit(1)
    current_branch = branch_out[0]

    if current_branch != "chinese":
        print(f"警告：当前分支是 '{current_branch}'，而非 'chinese'。")
        if input("是否继续？(y/N) ").strip().lower() != 'y':
            sys.exit(0)

    print(f"正在查找从 main 合并到 {current_branch} 的所有合并提交...")
    merge_commits = run_cmd(f"git log --merges --format=%H --reverse main..{current_branch}")
    if not merge_commits:
        print("未找到任何合并提交。")
        sys.exit(0)

    print(f"找到 {len(merge_commits)} 个合并提交。")

    # 数据结构
    file_last_time = {}               # 所有文件 -> (timestamp, readable)
    conflict_count = defaultdict(int) # 文件 -> 冲突次数
    conflict_last_time = {}           # 文件 -> (timestamp, readable)

    total_conflict_merges = 0

    for idx, commit in enumerate(merge_commits, 1):
        print(f"处理合并提交 {idx}/{len(merge_commits)}: {commit[:8]}...", end=' ')
        timestamp, readable = get_commit_time(commit)
        if timestamp == 0:
            print("跳过（时间获取失败）")
            continue

        # 1. 提取该合并提交涉及的所有文件
        files = run_cmd(f"git diff-tree -c --name-only -r {commit}")
        all_files_this_merge = [f for f in files if is_file_path(f)]

        for f in all_files_this_merge:
            if f not in file_last_time or timestamp > file_last_time[f][0]:
                file_last_time[f] = (timestamp, readable)

        # 2. 模拟合并，检测冲突
        has_conflict, conflict_files = simulate_merge_conflicts(commit)
        if has_conflict:
            total_conflict_merges += 1
            for f in conflict_files:
                conflict_count[f] += 1
                if f not in conflict_last_time or timestamp > conflict_last_time[f][0]:
                    conflict_last_time[f] = (timestamp, readable)
            print(f"有冲突 ({len(conflict_files)} 个文件)")
        else:
            print("无冲突")

    # 写入第一个 CSV：所有文件
    all_sorted = sorted(file_last_time.items(), key=lambda x: x[1][0], reverse=True)
    with open(all_output, 'w', encoding='utf-8') as f:
        f.write("file_path,last_merge_time\n")
        for file_path, (_, readable) in all_sorted:
            f.write(f'"{file_path}","{readable}"\n')
    print(f"\n✅ 所有合并涉及文件：{len(all_sorted)} 个，已保存至 {all_output}")

    # 写入第二个 CSV：冲突文件
    conflict_sorted = sorted(conflict_last_time.items(), key=lambda x: x[1][0], reverse=True)
    with open(conflict_output, 'w', encoding='utf-8') as f:
        f.write("file_path,conflict_count,last_conflict_time\n")
        for file_path, (_, readable) in conflict_sorted:
            count = conflict_count[file_path]
            f.write(f'"{file_path}",{count},"{readable}"\n')
    print(f"✅ 高概率冲突文件：{len(conflict_sorted)} 个，已保存至 {conflict_output}")
    print(f"   （共 {total_conflict_merges} 个合并提交包含冲突）")

    # 控制台预览
    print("\n【冲突最多的前10个文件】")
    print("-" * 60)
    top_conflict = sorted(conflict_count.items(), key=lambda x: x[1], reverse=True)[:10]
    for i, (f, cnt) in enumerate(top_conflict, 1):
        last_time = conflict_last_time[f][1]
        print(f"{i:2d}. {f}  (冲突 {cnt} 次，最近: {last_time})")

if __name__ == "__main__":
    main()
