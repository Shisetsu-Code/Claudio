# Claudio speed and dashboard implementation plan

> Execute inline, task by task, following superpowers:executing-plans.

**Goal:** Add adjustable game speed and live session tracking to the existing Claude MCP and publish the verified installation.
**Architecture:** Keep the stdio MCP entry point. Separate local telemetry, HTTP dashboard and browser speed into focused modules; wire existing tool callbacks into telemetry.
**Tech Stack:** Node.js 20+, Playwright, MCP SDK, node:test, plain HTML/CSS/JS.
**Spec:** ../specs/2026-10-24-speed-dashboard-design.md

## Global constraints
- Preserve existing tool names and arguments; new options are optional.
- Dashboard binds only 127.0.0.1 and does not expose network bodies.
- Session elapsed times always use Node real time; speed starts at 1×.
- Exclude session data, profiles, captures, node_modules and local configuration from Git.

## Review focus
- New game after close: previous session must stay frozen and current counters reset.
- Accelerated frames and navigation: rate must apply to frames and survive reload.
- Anomaly or time budget: partial progress must survive and a further batch must remain possible.
- Dashboard port collision: choose a free local port and return the actual URL.
- Shutdown, startup failure, browser crash: persist final status and close resources.

## Task 1: Telemetry and HTTP dashboard
- [x] Write tests for live counters, time freeze, history persistence, hostile HTTP requests, state endpoint and live event delivery. Run and observe failure.
- [x] Implement `SessionStore` in `lib/session.mjs` and `startDashboard({store,port,dataDir})` in `lib/dashboard.mjs`.
- [x] Add responsive dashboard assets with real time display, rate, progress, findings, activity and session selector. Use textContent for untrusted strings.
- [x] Verify tests pass.

## Task 2: Speed control
- [x] Write browser tests measuring scaled Date/performance/RAF/timers, return to 1× and new frame behavior. Run and observe failure.
- [x] Implement `installSpeedClock({rate})`, `prepareSpeed(context,rate)` and `setContextSpeed(context,rate)` in `lib/speed.mjs`; preserve monotonic time at rate changes.
- [x] Verify using real Chromium against local deterministic HTML.

## Task 3: MCP integration
- [x] Add end-to-end tests launching stdio, listing tools, recording findings, loading fixture, spinning while polling HTTP, errors, budgets and shutdown. Observe failure.
- [x] Integrate state transitions and batch progress into server.mjs. Add set_speed, get_status, get_dashboard and record_finding. Add interruptible batch stop through a tool, and enforce a real deadline within waitMotion/waitStable.
- [x] Update docs, package metadata, ignore patterns and CI. Verify the entire test suite and dashboard screenshot.
- [x] Review implementation; fix material findings with regression tests.
- [x] Back up and update the authorized Claude installation; verify installed server. Initialize Git and publish to the empty user repository without private runtime data.

## Execution ledger
- User authorized both speed approaches and delegated details. Implement inline without further approval gates.
- Original files are copied into an isolated directory in the writable workspace; installed source is preserved until verification.
- Repository was empty; no existing branches or upstream changes to overwrite.
- Independent review caught terminal-state, hidden tool-error and in-flight counting issues. Regression tests now cover all three and recovery after an abrupt process exit.
- Full verification: seven node:test cases passed with real Chromium, including continuous animation and no-motion deadlines. Desktop/mobile dashboard rendered without overflow or JavaScript errors.
- Runtime distinction: attempts, visually observed spins, in-flight actions and unconfirmed actions are separate counters. Completed batch iterations retain legacy MCP result field names for compatibility.
- Integration choice was explicitly authorized by the user: publish to the empty GitHub repository and update the existing Claude installation with a backup. No additional integration menu is needed.
