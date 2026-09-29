# Module 10 — Idempotency, Payment Architecture, Secure Webhooks, File Uploads (`Bun.s3`) & Async Email

> **Course Phase**: Phases 21 & 22 (Sections 46–50, 101, 103, 117)
> **Verified Primitives**: `crypto.timingSafeEqual`, `WebCrypto`, `Bun.s3` (`S3Client`), PostgreSQL Transactions, BullMQ

---

## 1. Concept: Idempotency (`Idempotency-Key`) (Section 46)

In distributed systems, **at-least-once delivery is the norm**:
- A mobile client taps "Pay Now", the payment succeeds on the server, the cellular connection drops before the `201` response arrives, and the client automatically retries `POST /api/v1/orders`.
- Without idempotency, the customer is charged twice and two orders are created.

### How Production `Idempotency-Key` Works
1. Client generates a UUIDv4/v7 `Idempotency-Key` per logical operation and sends it in the `Idempotency-Key` HTTP header.
2. Server hashes the request payload (`requestHash = SHA-256(JSON.stringify(body))`) and inserts an `idempotency_keys` record scoped to `(organization_id, key)`:
   - If the key **does not exist**: Insert row with `status = 'IN_PROGRESS'`, execute the transaction, store `response_status` and `response_body`, mark `status = 'COMPLETED'`, and return the response.
   - If the key **exists with `status = 'COMPLETED'`**:
     - Verify `stored.requestHash === incoming.requestHash` (if different, return `422`/`409` because the client reused the same key for different parameters!).
     - Return the stored `response_body` and `response_status` immediately without re-executing business logic.
   - If the key **exists with `status = 'IN_PROGRESS'`**: Another concurrent request with the same key is currently in flight -> return `409 Conflict` (`IDEMPOTENCY_CONFLICT`) with `Retry-After: 1`.

---

## 2. Realistic Payment & Webhook Architecture (Sections 47, 101, 117)

Never trust the browser redirect (`GET /checkout/success?orderId=123`) as proof of payment! Users can type that URL manually or close their browser tab before redirecting. **Payment state is updated authoritatively via signed asynchronous provider webhooks.**

### End-to-End Payment & Webhook Flow (Sections 101 & 117)

```text
Browser ──(1. POST /api/v1/orders + Idempotency-Key)──► Bun API
                                                           │
                                        (2. Creates pending Order + PaymentIntent)
                                                           ▼
Browser ◄────────(3. Returns clientSecret)────────── Payment Provider (Stripe/Chargily)
   │                                                       │
   └──(4. Completes 3DS / Card Payment)───────────────────►│
                                                           │
                                        (5. POST /api/v1/webhooks/payment)
                                        (Headers: X-Webhook-Signature, X-Webhook-Timestamp)
                                                           ▼
                                                     Bun API Webhook Endpoint
                                                           │
                                        ├─► 6. Read RAW Request Body (`await req.text()`)
                                        ├─► 7. Verify Timestamp Age (< 300s replay window)
                                        ├─► 8. Verify HMAC-SHA256 (`timingSafeEqual`)
                                        ├─► 9. ACID Transaction:
                                        │      • INSERT `processed_webhook_events (event_id)` ON CONFLICT DO NOTHING
                                        │      • UPDATE `orders SET status = 'paid'`
                                        └─► 10. Enqueue BullMQ Job (`order.paid`) -> Return `200 OK` fast!
```

### Complete Secure Webhook Receiver (Signature, Timestamp, Replay & Idempotency)

```typescript
// src/modules/payments/webhook.verifier.ts
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../../errors/app-error";

export class WebhookSignatureVerifier {
  private readonly maxTimestampSkewSeconds = 300; // 5 minutes replay protection window

  constructor(private readonly webhookSecret: string) {
    if (!webhookSecret || webhookSecret.length < 24) {
      throw new Error("WEBHOOK_SECRET must be configured with at least 24 characters");
    }
  }

  /**
   * CRITICAL: `rawBody` MUST be the exact unparsed UTF-8 string (`await req.text()`),
   * NEVER `JSON.stringify(await req.json())`, because key whitespace/ordering changes break HMAC!
   */
  verifyOrThrow(params: {
    rawBody: string;
    signatureHeader: string | null | undefined;
    timestampHeader: string | null | undefined;
  }): void {
    const { rawBody, signatureHeader, timestampHeader } = params;

    if (!signatureHeader || !timestampHeader) {
      throw AppError.unauthorized("Missing webhook signature or timestamp headers");
    }

    // 1. Replay Protection: Validate Timestamp Freshness
    const timestampSec = Number(timestampHeader);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(timestampSec) || Math.abs(nowSec - timestampSec) > this.maxTimestampSkewSeconds) {
      throw AppError.unauthorized("Webhook timestamp outside allowable 5-minute replay window");
    }

    // 2. Compute Expected HMAC-SHA256 over `${timestamp}.${rawBody}`
    const signedPayload = `${timestampSec}.${rawBody}`;
    const expectedHex = new Bun.CryptoHasher("sha256", this.webhookSecret)
      .update(signedPayload)
      .digest("hex");

    // 3. Constant-Time Comparison (`timingSafeEqual`) to prevent byte-by-byte timing attacks
    const expectedBuf = Buffer.from(expectedHex, "utf8");
    const receivedBuf = Buffer.from(signatureHeader.replace(/^v1=/, ""), "utf8");

    if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
      throw AppError.unauthorized("Invalid webhook signature");
    }
  }
}
```

### Idempotent Webhook Transaction Handler
What happens when the payment provider delivers the exact same `payment_intent.succeeded` webhook **5 times**?
```typescript
// Inside our PostgreSQL transaction:
const inserted = await tx
  .insert(webhookEvents)
  .values({
    providerEventId: event.id, // Unique constraint on `provider_event_id`!
    eventType: event.type,
    processedAt: new Date(),
  })
  .onConflictDoNothing({ target: webhookEvents.providerEventId })
  .returning({ id: webhookEvents.id });

if (inserted.length === 0) {
  // Already processed on an earlier delivery! Return 200 OK immediately so provider stops retrying.
  return { alreadyProcessed: true };
}
```

---

## 3. File Uploads, Magic-Byte Security & `Bun.s3` Object Storage (Sections 48–49, 103)

Never store uploaded user files (avatars, product images, PDF invoices) on local container disk in production! Container filesystems are ephemeral (wiped on every deploy) and cannot be shared across multiple API instances. Always use **S3-compatible Object Storage** (AWS S3, Cloudflare R2, MinIO, Tigris) via Bun's native **`Bun.s3` (`S3Client`)**.

### Two Architectural Patterns for Object Storage (Section 49)

| Pattern | Flow | Best For | Tradeoffs |
| :--- | :--- | :--- | :--- |
| **Pattern A: Presigned URL Direct Upload** | `Browser -> API (validates auth & returns s3.presign PUT URL) -> S3 Bucket` | Large files (videos, high-res images, documents > 5MB). | Offloads 100% of upload bandwidth from your Bun servers; requires bucket CORS config and post-upload verification. |
| **Pattern B: Server-Proxied Upload** | `Browser -> Bun API (inspects magic bytes & streams) -> S3 Bucket` | Small sensitive files (< 5MB avatars, CSV imports) requiring immediate synchronous inspection. | Consumes Bun server bandwidth, but allows strict server-side **magic-byte verification** before a single byte lands in S3. |

### File Upload Security: Never Trust `file.type` or File Extensions! (Section 103)

An attacker can rename `exploit.html` or `shell.exe` to `avatar.png` and set `Content-Type: image/png` in their `multipart/form-data` request. If you serve that file back without validation, you create a Stored XSS or malware hosting vulnerability.

Always inspect the **first 12 bytes (Magic Bytes / File Signature)** of the binary buffer:

```typescript
// src/modules/files/file-security.ts
import { S3Client } from "bun";
import { AppError } from "../../errors/app-error";

export type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export function detectMimeFromMagicBytes(bytes: Uint8Array): AllowedMimeType | null {
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  // PDF: "%PDF-" (25 50 44 46 2D)
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  return null;
}

export class ObjectStorageService {
  private readonly s3: S3Client;

  constructor() {
    this.s3 = new S3Client({
      accessKeyId: Bun.env.S3_ACCESS_KEY_ID,
      secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY,
      bucket: Bun.env.S3_BUCKET,
      endpoint: Bun.env.S3_ENDPOINT, // Works with AWS S3, Cloudflare R2, MinIO
    });
  }

  async uploadVerifiedProductImage(params: {
    organizationId: string;
    productId: string;
    file: File;
    maxSizeBytes?: number;
  }): Promise<{ objectKey: string; mimeType: AllowedMimeType; sizeBytes: number }> {
    const maxBytes = params.maxSizeBytes ?? 5 * 1024 * 1024; // 5 MiB default
    if (params.file.size === 0 || params.file.size > maxBytes) {
      throw AppError.validation(`File size must be between 1 byte and ${maxBytes} bytes`);
    }

    const bytes = new Uint8Array(await params.file.arrayBuffer());
    const verifiedMime = detectMimeFromMagicBytes(bytes);

    if (!verifiedMime || verifiedMime === "application/pdf") {
      throw AppError.validation("Invalid image file signature. Only genuine PNG, JPEG, and WebP images are allowed.");
    }

    const ext = verifiedMime === "image/png" ? "png" : verifiedMime === "image/webp" ? "webp" : "jpg";
    // Never use the user-supplied filename (`../../etc/passwd` path traversal risk)! Generate a UUIDv7 key:
    const objectKey = `tenants/${params.organizationId}/products/${params.productId}/${Bun.randomUUIDv7()}.${ext}`;

    await this.s3.write(objectKey, bytes, {
      type: verifiedMime,
    });

    return { objectKey, mimeType: verifiedMime, sizeBytes: bytes.byteLength };
  }

  createPresignedDownloadUrl(objectKey: string, expiresInSeconds = 900): string {
    return this.s3.presign(objectKey, {
      method: "GET",
      expiresIn: expiresInSeconds,
    });
  }
}
```

---

## 4. Transactional Email Workflows (Section 50)

Never call an external SMTP server or email HTTP API synchronously inside `POST /api/v1/auth/register` or `POST /api/v1/orders`.
1. External email APIs take `200ms–1500ms` and experience transient rate limits.
2. Instead, write the verification/reset token hash or order record in PostgreSQL, enqueue a job (`emailQueue.add("send-email", { template: "order-confirmation", to, variables }, { jobId })`), and let the **BullMQ Worker** deliver the email asynchronously with retries.

---

## 5. Exercises & Architecture Challenge

- **Beginner**: Write a `bun:test` unit test for `detectMimeFromMagicBytes` that passes an HTML string `<script>alert(1)</script>` disguised inside a `new File(["<script>..."], "avatar.png", { type: "image/png" })` and asserts that it is rejected.
- **Intermediate**: Write a `bun:test` test for `WebhookSignatureVerifier` testing valid signatures, tampered payloads, and expired timestamps (`now - 600s`).
- **Architecture Challenge**: *Why must private tenant documents (e.g. invoices in S3) never be stored with public bucket ACLs, and how do you authorize a user before generating a 15-minute `s3.presign()` URL?* (Answer: First query PostgreSQL `WHERE id = $docId AND organization_id = $actorOrgId` to verify tenant ownership and RBAC permission, and only then call `s3.presign(doc.objectKey, { expiresIn: 900 })`).
