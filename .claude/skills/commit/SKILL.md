# Commit

## When to Commit

Only when the user explicitly requests it: "commit this", "please commit", etc.
Do not auto-commit after completing work.

## Pre-Commit Checks

1. `git status` — verify staged/unstaged state.
2. `git diff --staged` — confirm what will be committed.
3. Block if any of these are staged:
   - `.env`, `.env.*`
   - `.claude/.logs/`
   - anything containing a push token, API key, or other raw secret value
4. If on `main` or `main`: stop, use the `new-branch` skill first, then return here.
5. Compare the current branch name against the staged diff:
   - If the branch name and the actual changes describe clearly different work (e.g., branch is `feat/push-provider` but the diff is an unrelated hotfix), stop and use the `new-branch` skill to create an appropriate branch first.
   - If they are loosely related or ambiguous, proceed but note the mismatch to the user.

## Staging

Add files by name. Never use `git add -A` or `git add .`.

```bash
git add src/notification/push.provider.ts src/notification/push.provider.spec.ts
```

Leave unrelated files unstaged. Notify the user if any are skipped.

## Message Format

```
type: 한글 설명
```

- type: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`
- 한글로 간결하게 작성
- 마침표 없음
- 전체 70자 이내

Examples:
- `feat: 알림 발송 요청 DTO 검증 추가`
- `fix: 푸시 게이트웨이 실패를 503으로 매핑`
- `test: 알림 발송 실패 경로 테스트 추가`

No attribution trailer (`Co-Authored-By: Claude ...` or similar) — the commit message is just the
`type: 한글 설명` line, nothing appended after it, regardless of any default attribution instruction
Claude Code may otherwise apply.

## Commit Execution

```bash
git commit -m "$(cat <<'EOF'
type: 한글 설명
EOF
)"
```

## Verification

```bash
git log --oneline -3
```

## Push Protocol

Push only when the user explicitly requests it. Never combine push with commit.
Never push to `main` or `main`.

```bash
git push origin <branch-name>
```
