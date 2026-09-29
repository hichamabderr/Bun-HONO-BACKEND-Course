# Module 1 — Bun Runtime, Architecture, Node Compatibility, Package Manager, Test & Build

> **Course Phase**: Phase 1 (Sections 1–8, 121, 125–126)
> **Verified Environment (September 2026)**: Bun `v1.4.2` | TypeScript `v6.0 / v7.0`

---

## 1. Concept

Many developers treat `bun run index.ts` as a faster alias for `node` + `tsx`. That surface-level view leads to subtle production bugs.

To master Bun from first principles, distinguish three layers:
1. **JavaScript Engine**: Implements ECMAScript syntax, bytecode compilation, JIT optimization, and Garbage Collection. Node.js uses Google's **V8**; Bun uses WebKit's **JavaScriptCore (JSC)**. An engine by itself has no `fetch`, no filesystem, and no TCP sockets.
2. **JavaScript Runtime**: Embeds the engine and binds it to the operating system kernel (epoll/io_uring/kqueue event loop, filesystem syscalls, sockets, timers, threads, cryptography) while exposing Web Standard APIs (`Request`, `Response`, `ReadableStream`) and runtime APIs (`Bun.*` and `node:*`).
3. **Unified Toolchain**: Bun combines four distinct tools into a single binary (`bun`) written in **Zig, Rust (expanded across Bun 1.4 internals), and C++**:
   - **Bun Runtime** (`bun run`)
   - **Bun Package Manager** (`bun install`, `bun add`, `bun pm`, `bun.lock`)
   - **Bun Test Runner** (`bun test` / `bun:test`)
   - **Bun Bundler** (`bun build` / `Bun.build()`)

---

## 2. Mental Model

```text
Application (.ts / .js)
    ↓
Bun Runtime (In-Memory TS Transpiler + Event Loop + Native Bindings)
    ↓
JavaScriptCore (JSC) Engine (LLInt -> Baseline JIT -> DFG JIT -> FTL JIT)
    ↓
Operating System Kernel (Linux io_uring / epoll, macOS kqueue, TCP_DEFER_ACCEPT, BoringSSL)
    ↓
Hardware (Network NIC / NVMe File System / Multi-Core CPU)
```

### Where Code Executes & What APIs Exist
Every function call in your backend belongs to one of three API surfaces:
1. **Web Standard APIs (Portable across Bun, Deno, Cloudflare Workers, Node 22+, Browsers)**:
   - `fetch`, `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `URLPattern`, `FormData`, `Blob`, `File`
   - `ReadableStream`, `WritableStream`, `TransformStream`, `CompressionStream`, `DecompressionStream`
   - `AbortController`, `AbortSignal.timeout()`, `crypto.subtle` (`WebCrypto`), `TextEncoder`, `TextDecoder`
2. **Bun-Specific APIs (`Bun.*` and `bun:*` — Native speed, coupled to Bun)**:
   - `Bun.serve()`, `Bun.sql` (Postgres/MySQL/SQLite), `Bun.redis` (`RedisClient`), `Bun.s3` (`S3Client`), `Bun.password` (`argon2id`/`bcrypt`), `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.Glob`, `Bun.semver`, `Bun.randomUUIDv7()`, `bun:sqlite`, `bun:test`.
3. **Node.js Compatibility APIs (`node:*` — For npm ecosystem portability)**:
   - `node:fs`, `node:path`, `node:crypto` (including `crypto.argon2` in `v1.4.1`), `node:async_hooks` (`AsyncLocalStorage`), `node:stream`, `node:buffer`, `node:net`, `node:tls`, `node:http`, `node:worker_threads`, `node:child_process`.

---

## 3. Architecture

### Encapsulating `Bun.*` Primitives Behind Infrastructure Ports
Never scatter raw `Bun.sql`, `Bun.redis`, or `Bun.s3` calls inside HTTP route handlers. Encapsulate them inside `src/infrastructure/` so your domain services depend only on standard TypeScript interfaces:

```text
src/
├── modules/
│   └── auth/
│       └── auth.service.ts        <── Depends on `PasswordHasherPort` (Pure TS)
└── infrastructure/
    └── crypto/
        └── bun-password.hasher.ts <── Calls `Bun.password.hash()` & `Bun.password.verify()`
```

### Node Compatibility Classification (`v1.4.2` Verified)
*"If this works on Node, will it automatically work on Bun?"*
**Not automatically 100% of the time.** Always verify against three tiers:
- **COMPATIBLE**: `node:fs`, `node:path`, `node:crypto`, `node:async_hooks` (`AsyncLocalStorage` is 2x faster in v1.4.1), `node:events`, `node:stream`, `node:buffer`, `node:zlib`, plus pure-JS/TS and N-API packages (`drizzle-orm`, `postgres`, `ioredis`, `bullmq@5.77+`, `zod`, `pino`, `jose`).
- **PARTIALLY COMPATIBLE**: `node:vm` (supports `SyntheticModule`, but V8 bytecode caching doesn't apply to JSC), `node:inspector`, `node:http2` edge cases, `node:cluster` (works on Linux via `SO_REUSEPORT`).
- **NOT COMPATIBLE**: Native C++ addons that `#include <v8.h>` or `nan.h` directly instead of using engine-agnostic Node-API (`N-API`), or tools expecting V8-internal C++ symbols.

---

## 4. Code

### Production Runtime Wrapper: Password Hashing, UUIDv7, Lazy File I/O & Subprocess

```typescript
// src/infrastructure/bun-runtime-primitives.ts
export interface PasswordHasher {
  hash(plainText: string): Promise<string>;
  verify(plainText: string, storedHash: string): Promise<boolean>;
}

export class BunArgon2PasswordHasher implements PasswordHasher {
  async hash(plainText: string): Promise<string> {
    return await Bun.password.hash(plainText, {
      algorithm: "argon2id",
      memoryCost: 65536, // 64 MiB
      timeCost: 2,
    });
  }

  async verify(plainText: string, storedHash: string): Promise<boolean> {
    return await Bun.password.verify(plainText, storedHash);
  }
}

export function createTimeOrderedId(): string {
  // Native RFC 9562 UUIDv7 (48-bit timestamp prefix for sequential B-Tree inserts)
  return Bun.randomUUIDv7();
}

export async function readValidatedJsonFile<T>(
  path: string,
  validator: (raw: unknown) => T,
): Promise<T> {
  const file = Bun.file(path); // Lazy reference; zero disk I/O until consumed
  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`);
  }
  const parsed: unknown = await file.json();
  return validator(parsed);
}
```

---

## 5. Examples

### Example A: Bun Package Manager (`bun install`, `bun.lock`, Workspaces & Catalogs)
```json
// Root package.json using Bun 1.3+ / 1.4.2 Workspace Catalogs
{
  "name": "commerce-monorepo",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "catalog": {
    "hono": "4.13.10",
    "elysia": "1.4.30",
    "zod": "^4.0.0",
    "drizzle-orm": "0.45.2"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test --coverage"
  }
}
```
- **Conceptual Comparison (`npm` vs `pnpm` vs `bun`)**:
  - `npm`: Flat hoisted `node_modules`, slower dependency resolution, runs lifecycle scripts by default.
  - `pnpm`: Content-addressable store + symlinked isolated `node_modules` preventing phantom dependencies.
  - `bun`: Global cache + hardlinks/clonefile, text-based `bun.lock` (since Bun 1.2), supports both `--linker=hoisted` (default) and `--linker=isolated` (pnpm-style strictness since Bun 1.2.19), and blocks untrusted lifecycle scripts unless whitelisted in `"trustedDependencies"`.

### Example B: Testing with `bun:test` (Selected Primary Test Runner)
```typescript
// src/infrastructure/__tests__/bun-runtime-primitives.test.ts
import { describe, test, expect, setSystemTime, afterEach } from "bun:test";
import { BunArgon2PasswordHasher, createTimeOrderedId } from "../bun-runtime-primitives";

describe("Bun Runtime Primitives", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("hashes and verifies passwords with Argon2id", async () => {
    const hasher = new BunArgon2PasswordHasher();
    const hash = await hasher.hash("CorrectHorseBatteryStaple!2026");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await hasher.verify("CorrectHorseBatteryStaple!2026", hash)).toBe(true);
    expect(await hasher.verify("WrongPassword", hash)).toBe(false);
  });

  test("generates monotonically increasing UUIDv7 identifiers", () => {
    setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
    const id1 = createTimeOrderedId();
    setSystemTime(new Date("2026-09-29T10:00:01.000Z"));
    const id2 = createTimeOrderedId();

    expect(id1 < id2).toBe(true);
  });
});
```

### Example C: When to Use `bun build` vs Running `.ts` Directly
- **Run `.ts` Source Directly (`bun run src/entrypoints/api.ts`)**: Best for Dockerized server deployments—fast startup, exact `.ts` line numbers in stack traces, zero build-step drift.
- **Bundle / Compile (`bun build --compile --bytecode src/entrypoints/api.ts --outfile bin/api`)**: Best when shipping a single self-contained binary to distroless containers or edge appliances.

---

## 6. Bad Example

```typescript
// ❌ BAD EXAMPLE:
// 1. Uses synchronous `fs.readFileSync` inside a request path (blocks the event loop!)
// 2. Assumes `bun run` validates TypeScript types at runtime (it only strips types!)
// 3. Uses `crypto.createHash('sha256')` for user passwords (vulnerable to GPU brute-forcing!)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function insecureLogin(email: string, password: string) {
  const brokenType: string = 99999 as unknown as string; // `bun run` executes this without complaining!
  const usersJson = readFileSync("./users.json", "utf8"); // Blocks all concurrent requests!
  const users = JSON.parse(usersJson);
  const unsaltedSha256 = createHash("sha256").update(password).digest("hex");
  return users[email]?.passwordHash === unsaltedSha256;
}
```

---

## 7. Production Pattern

```typescript
// ✅ PRODUCTION PATTERN:
// 1. Non-blocking lazy `Bun.file()` or database lookup
// 2. Memory-hard Argon2id via `Bun.password.verify` with constant-time dummy fallback
// 3. Paired with `tsc --noEmit` in CI so type errors fail the build before deployment
const DUMMY_ARGON2_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQxMjM0NTY3OA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

export async function verifyUserCredentialsSafe(
  findUserHashByEmail: (email: string) => Promise<{ userId: string; passwordHash: string } | null>,
  email: string,
  plainPassword: string,
): Promise<string | null> {
  const user = await findUserHashByEmail(email.toLowerCase().trim());
  if (!user) {
    // Constant-time defense: prevents attackers from timing whether an email exists!
    await Bun.password.verify(plainPassword, DUMMY_ARGON2_HASH);
    return null;
  }
  const isValid = await Bun.password.verify(plainPassword, user.passwordHash);
  return isValid ? user.userId : null;
}
```

---

## 8. Common Mistakes

1. **Mistaking Type Stripping for Type Checking**: `bun run` transpiles TypeScript by stripping type annotations; it never halts on type errors. Always run `tsc --noEmit` in CI and pre-commit hooks.
2. **Committing Binary `bun.lockb` Instead of Text `bun.lock`**: Bun 1.2+ defaults to text-based `bun.lock`. Delete legacy `bun.lockb` files so pull requests show readable dependency diffs.
3. **Installing Redundant Packages**: Adding `dotenv`, `uuid`, `bcrypt`, `ws`, `node-fetch`, or `fast-glob` when Bun provides all of them natively with zero dependencies.

---

## 9. Security Notes

- **Supply-Chain Protection (`trustedDependencies`)**: By default, Bun refuses to run `preinstall`/`postinstall` scripts for third-party packages. Keep `"trustedDependencies": []` empty unless you have audited the specific package's install script.
- **Argon2id Memory DoS Protection**: Because each `Bun.password.hash` / `verify` allocates `64 MiB` of RAM on the background threadpool, an attacker sending 200 concurrent `/login` requests could allocate `12.8 GiB` of RAM. Always place a strict rate limiter in front of `/auth/login` and `/auth/register`, or bound concurrent Argon2 operations with a semaphore.

---

## 10. Performance Notes

- **Use `Bun.file()` + `Bun.write()` for File Streaming**: `Bun.write(destFile, srcFile)` and `new Response(Bun.file(path))` use kernel zero-copy syscalls (`sendfile` / `copy_file_range` on Linux), avoiding copying buffers into JavaScriptCore heap memory.
- **Fast Non-Cryptographic Hashing**: For cache keys or ETag generation where cryptographic collision resistance isn't needed, `Bun.hash.rapidhash(str)` or `Bun.hash(str)` (`wyhash`) is orders of magnitude faster than SHA-256.

---

## 11. Debugging

### Incident: Segfault or Missing Symbol on Legacy Native Addon
- **Symptom**: `error: Cannot open shared object file` or `undefined symbol: _ZN2v87Isolate10GetCurrentEv` when starting a server on Alpine Linux or importing an old npm package.
- **Root Cause**: Either (a) the package is a V8 C++ addon (`v8.h`) incompatible with JSC, or (b) the container uses `musl` libc (`alpine`) while a prebuilt binary expects `glibc` (`debian-slim`).
- **Fix**: Inspect native addons with `find node_modules -name "*.node"`. Replace V8 addons with Bun native APIs, or switch the Docker base image from `oven/bun:1.4.2-alpine` to `oven/bun:1.4.2-slim` (Debian glibc) if a required N-API binary only ships glibc prebuilds.

---

## 12. Exercises (Beginner → Architecture)

- **BEGINNER**: Initialize a Bun project, configure `tsconfig.json` with `"strict": true` and `"noUncheckedIndexedAccess": true`, and write a script that hashes and verifies a password using `Bun.password`.
- **INTERMEDIATE**: Write a `bun:test` suite using `setSystemTime` and `mock()` to test `verifyUserCredentialsSafe` for valid user, invalid password, and non-existent user cases.
- **PRODUCTION**: Implement a bounded concurrency limiter (semaphore allowing max 8 simultaneous Argon2id operations) around `BunArgon2PasswordHasher` so a burst of 500 login requests rejects excess load cleanly with `429`/`503` instead of exhausting container RAM.
- **DEBUGGING**: Given a project where `bun run src/index.ts` succeeds locally but crashes in production because a developer passed a `number` where a `string` was expected, add the missing CI step (`bun run typecheck`) and fix the type mismatch.
- **ARCHITECTURE**: Audit a legacy `package.json` containing `express`, `dotenv`, `bcrypt`, `uuid`, `axios`, `glob`, `jest`, `ts-jest`, and `@aws-sdk/client-s3`. Produce a migration table mapping which dependencies are eliminated by Bun `v1.4.2` native APIs and which remain.

---

## 13. Architecture Challenge

> **"Your organization has 12 microservices running on Node 20 LTS. Three of them use a proprietary C++ PDF rendering addon built with `nan.h` (`v8.h`), while nine of them are pure TypeScript REST/WebSocket APIs talking to PostgreSQL, Redis, and S3. Which services should migrate to Bun `v1.4.2`, which should stay on Node (or isolate the PDF work), and how would you architect the boundary between them?"**

---

## 14. Senior-Level Code Review Checklist (Section 138)

When reviewing Module 1 code in a Pull Request, verify:
- **Correctness**: Are `Bun.file().exists()` checks awaited before reading?
- **Security**: Is `Bun.password` configured with `argon2id` (`memoryCost >= 65536`)? Is `trustedDependencies` audited?
- **Architecture**: Are `Bun.*` calls encapsulated inside `src/infrastructure/` rather than leaked into domain entities?
- **Typing**: Does `bun run typecheck` (`tsc --noEmit`) pass with zero errors under `strict: true`?
- **Performance**: Are synchronous `node:fs` (`readFileSync`, `writeFileSync`) calls banned from request handlers?

---

## 15. Official Documentation & What I Should Know Before Continuing

### Official Documentation (Verified September 2026)
- **Bun Runtime & APIs (`v1.4.2`)**: [https://bun.sh/docs](https://bun.sh/docs)
- **Node.js Compatibility Tracker**: [https://bun.sh/docs/runtime/nodejs-apis](https://bun.sh/docs/runtime/nodejs-apis)
- **Package Manager & `bun.lock`**: [https://bun.sh/docs/cli/install](https://bun.sh/docs/cli/install)
- **Test Runner (`bun:test`)**: [https://bun.sh/docs/cli/test](https://bun.sh/docs/cli/test)
- **Bundler & Standalone Executables**: [https://bun.sh/docs/bundler](https://bun.sh/docs/bundler)

### What I Should Know Before Continuing to Module 2
- [x] Why Bun uses JavaScriptCore + Zig/Rust instead of V8, and what that means for cold start and C++ addons.
- [x] The exact distinction between Web Standard APIs, `Bun.*` APIs, and `node:*` compatibility APIs.
- [x] Why `bun run` does not typecheck TypeScript, making `tsc --noEmit` mandatory in CI.
- [x] How to use `Bun.password`, `Bun.randomUUIDv7()`, `Bun.file()`, `bun install --frozen-lockfile`, and `bun:test`.
