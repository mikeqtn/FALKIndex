---
name: GitHub access checks
description: Interpreting conflicting Replit GitHub connection and repository authentication signals.
---

Treat a successful repository operation as the access check, not merely a healthy GitHub integration status.

**Why:** In this workspace, the source-control integration reported healthy authorization and an already-active binding while GitHub fetches still rejected authentication. Integration connection prompts also failed despite that metadata.

**How to apply:** Do not promise that attaching an existing authorization has fixed access before verifying a repository operation. If connection metadata and actual access disagree and inline authorization cannot open, consult current Replit documentation for Git Providers reconnection steps rather than repeatedly retrying the same fetch or requesting credentials in chat.
