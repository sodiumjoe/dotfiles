---
description: Append a note, link, or discovery to today's daily note
allowed-tools: Read, Edit, Bash(date:*), Bash(work:*), Bash(obsidian:*)
---

# Note

Append a freeform entry to today's daily note log.

## Steps

### 1. Ensure daily note

Run `work ensure`.

### 2. Append to log

Read the daily note. Add to `## Log`:

```
- HH:MM — Note content here
```

Use `date +%H:%M` for the time. Include wikilinks to plans or projects if relevant.