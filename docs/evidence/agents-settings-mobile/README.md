# Agents and Settings loading

Verified on October 23, 2026, with Aside.
Branch: `fix/agents-settings-mobile`. Base: `7cc4ee2f`.
The local web app and API both run from this worktree.
Web: `http://localhost:3107`. API: `http://localhost:8107`.
The API uses this worktree's `.localdata` SQLite directory.
The account is Mobile QA. The workspace is Personal.

| Loading dependency | Before | After |
| --- | --- | --- |
| Agents: recent tasks and member names | Route waits for both reads | Reads run in the background |
| Settings: other sections | Profile downloads all sections | Each section loads when selected |
| Browser view transitions | Enabled globally | Disabled, as the router comments intend |

## Delayed history

A temporary local proxy on port 8108 forwards requests to the owned API.
It holds `GET /v1/jobs?limit=200` for 60 seconds, then returns 503.
The web app uses that proxy during this check.
No production requests are changed.

1. Start a fresh app session with the original Agents loader from the base commit.
2. Open `/agents` at 390 × 844.
3. Keep the recent-tasks request pending.
4. Observe that the Agents heading and roster do not render after seven seconds.
5. Restore the changed loader and open a fresh frame with the same fault.
6. Observe the Agents heading, tabs, and empty roster while history still waits.

The roster does not depend on recent history. Tasks retains its own loading and error states.

![Agents opens while recent history waits](agents-mobile-after.png)

## Settings and mobile navigation

Open Settings with the signed-in local account.
Select Profile, Sources, Security, and Members.
The navigation stays visible while a section loads.
The loading placeholder gives way to the selected section.

Profile and Sources load at 390 × 844.
Security loads at 320 × 568.
The measured body width equals the frame width at both sizes.
Agents also opens through the mobile navigation drawer.

![Profile at 390 pixels](settings-profile-mobile.png)

![Sources at 390 pixels](settings-sources-mobile.png)

![Security at 320 pixels](settings-security-320.png)

## Build and browser evidence

The production web build passes after the final code change.
The Settings route chunk falls from 212.30 KB to 23.61 KB.
Its compressed size falls from 68.11 KB to 9.10 KB.
These values describe the route chunk, not all shared dependencies.
The split sections use TanStack's existing lazy loader, including stale-chunk recovery.

Before the router change, the browser reports:
`InvalidStateError: Transition was aborted because of invalid state. Document hidden`.
Global transitions are now disabled. Navigation no longer starts those transitions.

## Limits

Desktop Agents and Settings also load on derive.to during this session.
The local fault reproduces one loading failure, not the exact reported phone session.
Mobile checks use real iframe viewports in Aside, not a physical phone or Safari.
The screenshots use the existing dark theme.
This branch is not deployed. No CI status is inspected.
