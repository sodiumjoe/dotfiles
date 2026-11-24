---
name: agency-delegation
description: Use when the user asks you to delegate, hand off, or farm out work to another agent, a child agent, or another devbox with `agy delegate`, or when a message labelled `[Agency child …]` arrives.
---

# Agency delegation

## Overview

`agy delegate` starts a child agent on a pool box. The child is an ordinary Agency agent: it gets only your task text and a fresh checkout of a ref, works on its own, and its answers come back to you as new messages.

## When to delegate

Delegate only when the user's message explicitly asks for it: it says to delegate or hand off the work, to use another agent or child agent, to run it on another box, or to use `agy delegate`.

These are **not** requests to delegate:

| What the user said or the situation | What to do |
|---|---|
| "As fast as you can", "today", "ASAP" | Do the work yourself |
| "I'm stepping away", "I'll be back in an hour" | Do the work yourself |
| A slow test suite, or work that could run in parallel | Do the work yourself |
| "Do whatever it takes", "you have full autonomy" | Do the work yourself |
| "Same as last time", or delegation in an earlier session | Do the work yourself |
| This skill being available | Do the work yourself |

When delegating would clearly help, say so in your reply, for example "I could run the fees suite on a pool box while I refactor; want me to?", and wait for a yes. Reading urgency as permission to delegate is the mistake this section exists to prevent.

## Starting a child

1. **Make the ref fetchable.** The box runs `git fetch origin <ref>`, so the ref must exist on `origin`. Commit what the child needs and push the branch, then pass the pushed branch name or SHA. If the user has not approved pushing, ask before you push. Uncommitted and unpushed work is invisible to the child. `start` does not check this: it still returns `starting`, and the fetch failure arrives later as a `failed` answer.
2. **Write a self-contained task.** The child knows nothing about this conversation. Include the goal, the relevant paths, what has been ruled out, what not to change, and exactly what its final message must contain.
3. **Start it** and keep `result.childId` from the reply:
   ```
   agy delegate start --input-json - <<'EOF'
   {"task": "...", "ref": "moon/fee-rounding"}
   EOF
   ```
   Every reply is an envelope; the useful part is under `result`.
4. **End your turn** once you have told the user the child started, or carry on with your own work. Do not wait for the child.

## While it works

- **Its answers arrive by themselves.** Each child turn's final reply is delivered to you as a new message starting `[Agency child 1a2b3c4d · <box> · answer]`. Failures arrive the same way, labelled `failed` or `interrupted`. Never poll `agy delegate list` or send status asks to find out whether it is done.
- **Follow-ups only while it is idle.** `agy delegate ask <childId> --input-json -` with `{"text": "..."}`. If it replies `BUSY`, tell the user the message is not delivered yet, and send it again after the child's next answer arrives, which is when it is idle.
- `agy delegate list` shows your children and their state when the user asks about them.

## Finishing

- Relay the child's answer to the user, including `failed` answers and their reasons.
- When the child's work is done and reported, run `agy delegate stop <childId>`, unless the user said to keep it running. Idle children are also stopped automatically after an hour.

## Limits

- One child per pool box. "no free pool box" or "pool names are unavailable" arrive as a `failed` answer: tell the user; do not retry in a loop.
- A child cannot start children.
- On a devbox, delegation works only while the devbox is connected to the laptop.
- `agy delegate` only works inside an Agency agent.