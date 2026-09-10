# Phishing Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Bing userscript reduce spoof-site misclicks through explicit URL risk classification, cautious matching, confirmation gates, and race-safe DOM updates.

**Architecture:** Keep the userscript self-contained, but separate pure URL/matching helpers from side-effectful fetching and DOM rendering inside the existing file. The script will treat Baidu's official marker as a reference signal, never as an absolute security guarantee; generated nodes use private `data-bom-*` markers and all navigation decisions pass through one risk classifier.

**Tech Stack:** Tampermonkey UserScript, browser DOM APIs, `GM_xmlhttpRequest`, `sessionStorage`, Node.js built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-09-phishing-protection-design.md`

## Global Constraints

- Only `https:` URLs with normalized hostnames can receive the strict trusted-reference state.
- Same registrable domain with a different hostname requires confirmation.
- HTTP, IP, unusual ports, URL credentials, short links, explicit redirects, and unreliable URLs are high risk and blocked by default.
- Baidu requests must not forward user cookies or a forged User-Agent.
- Injected content must be clearly identified as a Baidu-certified reference, not native Bing content.
- Existing behavior must remain local to Bing search pages and must not touch unrelated DOM markers.

---

### Task 1: URL Security Helpers

**Files:**
- Modify: `baidudreamourbings.user.js` around `isBlockedUrl`, `getMainDomain`, and `getMatchType`
- Create: `tests/security-helpers.test.js`

**Interfaces:**
- Produce `normalizeHttpUrl(value) -> URL|null`.
- Produce `classifyUrl(value) -> { level: 'trusted'|'confirm'|'high-risk', reasons: string[], url: URL|null }`.
- Produce `getMatchType(candidateUrl, officialUrl) -> 'exact'|'main'|'none'` with public-suffix-safe matching.

- [ ] **Step 1: Write failing Node tests** for HTTPS exact matches, subdomain confirmation, public suffix isolation (`a.github.io` vs `b.github.io`), HTTP, IP hosts, credentials, unusual ports, explicit redirects, encoded URLs, malformed values, and default ports.
- [ ] **Step 2: Run `node --test tests/security-helpers.test.js`** and confirm the tests fail because the helper module is not yet exported.
- [ ] **Step 3: Implement the smallest pure helper layer** in the userscript, using `URL`, explicit protocol checks, hostname normalization, IP detection, default-port removal, redirect-host detection, and a conservative public-suffix rule set. Expose helpers for Node tests without changing browser behavior, for example by placing the pure functions in a separate CommonJS-compatible test fixture or by extracting them to `src/security-helpers.js` and loading that logic from the userscript.
- [ ] **Step 4: Run the focused test command** and confirm all security-helper cases pass.

### Task 2: Safe Fetching and Search State

**Files:**
- Modify: `baidudreamourbings.user.js` around metadata, `fetchBaiduOfficialLinks`, and `main`
- Modify: `README.md` installation, privacy, and known-limit sections

**Interfaces:**
- `fetchBaiduOfficialLinks(keyword, signalOrRequestId) -> Promise<OfficialLink[]>` returns normalized, deduplicated records only.
- `runSearch(searchKey) -> void` owns a monotonically increasing request id and rejects stale results.

- [ ] **Step 1: Add tests or deterministic checks** for duplicate official URLs, stale request completion, timeout resolution, and cache hit/miss behavior.
- [ ] **Step 2: Run the focused checks** and confirm they fail against the current unbounded request and shared state.
- [ ] **Step 3: Restrict metadata to the Baidu search origin**, remove Cookie and User-Agent headers, add a finite timeout, validate response status/content before parsing, deduplicate normalized URLs, cache successful results briefly in `sessionStorage`, and prevent stale searches from mutating the current page.
- [ ] **Step 4: Update README** to document the limited request target, local session cache, and that Baidu data is only a reference signal.
- [ ] **Step 5: Run syntax and focused checks** with `node --check baidudreamourbings.user.js` and the relevant Node test command.

### Task 3: Risk-Aware Result Marking and Click Gate

**Files:**
- Modify: `baidudreamourbings.user.js` around `createTag`, result matching, injected result creation, and startup listeners
- Create or extend: `tests/security-helpers.test.js` for rendered-state decision inputs where practical

**Interfaces:**
- `getResultLink(item) -> HTMLAnchorElement|null` selects the title/main Bing result link and rejects non-http(s) targets.
- `createNavigationGuard(anchor, decision) -> void` blocks `confirm` and `high-risk` navigation until explicit confirmation.
- `clearOwnedMarkup() -> void` removes only `[data-bom-tag]` and `[data-bom-injected]` nodes.

- [ ] **Step 1: Add deterministic tests** for title-link selection, owned-marker cleanup, exact HTTPS labeling, confirmation labeling, and high-risk reasons.
- [ ] **Step 2: Run the focused checks** and confirm the current generic first-anchor lookup and global cleanup do not satisfy them.
- [ ] **Step 3: Implement title-link selection and match decisions** so exact HTTPS matches use a restrained “官网参考” label, same-domain subdomains use “需确认”, and high-risk targets receive a visible risk label instead of a trusted label.
- [ ] **Step 4: Add capture-phase click handling** that prevents default navigation for confirmation/high-risk results, displays the target URL, official reference URL, and reasons, then opens only after explicit confirmation. Preserve modifier-key and keyboard activation behavior as far as browser APIs permit.
- [ ] **Step 5: Mark injected entries as “百度认证参考”**, retain safe `textContent` assignment, and never present them as native Bing results. Use only `data-bom-*` markers during cleanup.
- [ ] **Step 6: Replace full-document mutation work with a debounced observer** scoped to the results region and rerun only when the current search key changes or result nodes are added.
- [ ] **Step 7: Run focused tests and manually inspect the generated DOM** in a local fixture or browser page for duplicate execution and dynamic results.

### Task 4: Full Verification and Audit Report

**Files:**
- Modify: `README.md` for final behavior and limitations
- Review: `baidudreamourbings.user.js`, `docs/superpowers/specs/2026-09-09-phishing-protection-design.md`

- [ ] **Step 1: Run `node --check baidudreamourbings.user.js`.**
- [ ] **Step 2: Run `node --test tests/*.test.js`.**
- [ ] **Step 3: Inspect UserScript metadata** and verify there is no wildcard `@connect *`, no cookie forwarding, and no forged browser identity header.
- [ ] **Step 4: Exercise representative URLs**: a strict HTTPS match, a subdomain match, `github.io` tenant mismatch, HTTP, IP, shortener, credentials, unusual port, and redirect URL.
- [ ] **Step 5: Review the final diff** for unrelated changes, stale wording, unsafe DOM selectors, and claims stronger than the actual protection.
- [ ] **Step 6: Record remaining limitations**: domain identity does not prove page integrity, Baidu certification can be stale, and final third-party redirects cannot be fully known before navigation.
