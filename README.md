# dsh-prompt-diff

World-state diff injection for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH). A `system-prompt/assemble` hook hashes large context blocks; when a block is unchanged it injects only a one-line digest instead of the full text, cutting token cost (borrowed from codex `world_state` render_diff).

> 中文简介：dsh-prompt-diff 是 world-state diff 注入插件：system-prompt/assemble 钩子对大块上下文做 hash+diff，未变只注入一行缩略，省 token（借鉴 codex world_state render_diff）。

## Behavior

- No new tools — it operates purely as a `system-prompt/assemble` hook.
- Unchanged blocks → one-line digest; changed blocks → full injection.

## Installation

```bash
dsh plugin --profile web add github:boomzikazita/dsh-prompt-diff
```
