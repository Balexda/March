# smithy-guidance

Shared rules that apply to all smithy workflow agents. Read and follow these
whenever you are executing shell commands as part of a smithy workflow.

---

## Shell Best Practices

### Never embed subshells in commands

Do **not** use `$(...)` or backtick subshells inside a command. The host CLI's
permission system evaluates the literal command string and cannot verify commands
that contain subshell expansions, even when both the outer and inner commands are
individually permitted.

**Bad:**
```bash
gh pr list --head "$(git branch --show-current)" --json number,title,url
```

**Good — run the inner command first, then use the literal result:**
```bash
# Step 1: get the value
git branch --show-current
# (returns e.g. "strike/my-feature")

# Step 2: use the literal value
gh pr list --head "strike/my-feature" --json number,title,url
```

This applies to all commands, not just `gh`. Whenever you need the output of one
command as an argument to another, run them as separate steps.

### Prefer simple, single-purpose commands

Break complex pipelines into individual steps. This makes each command easier to
approve and debug.
