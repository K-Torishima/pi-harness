---
name: security
description: Review a change for security problems an attacker or a leak could exploit — secrets, injection, auth and access checks, unsafe input handling, new dependencies, and data sent where it should not go. Use before opening a PR (the reviewed gate requires it), when the user says "/skill:security", "セキュリティ見て", or asks whether a change is safe. Reports findings; does not edit unless asked to fix.
---

# security

Find the ways this change could be abused or could leak, and only those. One real hole beats ten "consider hardening" notes.
Do not edit files, post comments, or push while reviewing. If the request says to fix, finish the review first, then fix, then run this again on the fix.

## 1. Pin down the change

The same diff `/skill:review` reads:

- A PR number: `gh pr view <n> --json title,body,baseRefName,headRefName,files` and `gh pr diff <n>`
- A branch or path: the diff of that branch against the default branch, or of that path
- Nothing given: uncommitted changes (`git diff HEAD`, plus untracked files). If there are none, the current branch against the default branch (`git diff $(git merge-base HEAD origin/HEAD)...HEAD`)

If the diff is empty, say so in one line and stop.

## 2. Decide what is exposed

In two or three lines for yourself: where does untrusted input enter this change (HTTP requests, URL and deep-link parameters, files, environment, tool or model output, other users' data), and what can the code reach (shell, database, file system, network, credentials, other users' records)?

If the change touches none of that (docs only, styling, a pure function with trusted input), report `Security: nothing exposed (<why>)` and stop.

## 3. Check the change against each risk

Read around each hunk, not just the `+` lines: the caller that feeds it, and where its output goes.

1. **Secrets and personal data**: keys, tokens, passwords, or `.env` values in code, tests, logs, error messages, or analytics; personal data (email, phone, location) logged or sent to a third party; secrets kept in plain storage on a device instead of the keychain or secure store
2. **Injection**: input reaching a shell command, an SQL or GraphQL query, a regular expression, a template, HTML (XSS), or a file path (`../` traversal) without escaping, parameters, or an allow-list
3. **Authentication and access**: a new endpoint, screen, or query that skips the auth check; a check on the client only; an ID taken from the request and used without checking it belongs to the caller (IDOR); a token that never expires or is not verified
4. **Untrusted input**: missing validation of type, size, or range; parsing untrusted data with `eval`, unsafe deserialization, or `dangerouslySetInnerHTML`; a URL fetched from user input (SSRF); an open redirect; a deep link or WebView that loads any URL
5. **Configuration and permissions**: CORS `*` with credentials, disabled TLS checks, debug flags left on, IAM or token scopes wider than the change needs, new app permissions (camera, location, contacts) without a use
6. **Dependencies**: a new package or a version change in a lockfile. Check that the name is the real package (typosquats), that it is maintained, and run the ecosystem's audit when one exists (`npm audit --omit=dev`, `pip-audit`)
7. **Crypto and randomness**: home-made crypto, `Math.random` for tokens, MD5 or SHA-1 for passwords, fixed IVs or salts

## 4. Verify every finding before you keep it

Follow the path from where the input enters to where it does harm. Name the input an attacker would send, or the place the secret would end up.
- Confirmed: keep it
- Plausible but not confirmed: keep it only if the harm would be serious, and mark it "unverified"
- Generic advice with no path in this change: drop it

## 5. Report

Start with the verdict line exactly as below, label in English even when you reply in another language (the PR gate looks for `Security:`). Then the findings, most severe first, one or two lines each:

```
Security: fix first | no issues found | nothing exposed (<why>)
1. path/to/file.ts:42 — <what is exposed>. An attacker sends <input> / <secret> ends up in <place>.
2. ...
```

If nothing survived verification, say "no issues found" and the one riskiest spot you checked.
Reply in the language the user writes in.
