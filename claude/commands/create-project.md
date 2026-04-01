---
description: Brainstorm scope and create a new project
---

# Create Project

## Overview

Entry point for new work. Turn an idea into a fully formed design through collaborative dialogue, then create the project in the Obsidian vault.

**Announce at start:** "I'm using the work:create-project skill to set up this project."

<HARD-GATE>
Do NOT create the project directory, write any code, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A single-function utility, a config change, a bug fix — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore context** — check files, docs, recent commits relevant to the idea
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Create the project** — directory, project file with populated sections, open in neovim
6. **Assess scope** — decide whether the work needs a formal plan or can execute from the task list

## The Process

**Understanding the idea:**
- Check out the current state first (files, docs, recent commits)
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message — if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## Creating the Project

Once the design is approved:

1. Derive a slug from the project name (lowercase, hyphens, no spaces)
2. Create the project directory and file:
   ```bash
   mkdir -p ~/stripe/work/projects/<slug>
   ```
3. Write the project file at `~/stripe/work/projects/<slug>/project.md` with:
   - Frontmatter: `status: active`, `id: <slug>`
   - `## Links` — relevant URLs, repos, docs
   - `## Plans` — empty initially
   - `## Tasks` — initial task breakdown from brainstorming
   - `## Changelog` — empty initially
   - `## Notes` — any investigation output from brainstorming
4. Open the project file in neovim:
   ```bash
   nvim-open --editor '~/stripe/work/projects/<slug>/project.md'
   ```

## Assess Scope

- **Small work** (can be done from the task list alone): stop here. Tell the user the project is ready and they can work from the task list.
- **Larger work** (needs a formal implementation plan): hand off to `work:write-plan`. Do NOT invoke `superpowers:writing-plans` or any other writing/implementation skill — `work:write-plan` is the only valid handoff.

## Key Principles

- **One question at a time** — don't overwhelm with multiple questions
- **Multiple choice preferred** — easier to answer than open-ended when possible
- **YAGNI ruthlessly** — remove unnecessary features from all designs
- **Explore alternatives** — always propose 2-3 approaches before settling
- **Incremental validation** — present design, get approval before moving on
- The project file is the persistent home for this work — tasks, changelog, notes all live here
- Plans are short-lived execution artifacts created only when needed