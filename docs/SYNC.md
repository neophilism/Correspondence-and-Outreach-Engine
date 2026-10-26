# Read-only mailbox synchronization — COE-002

The SDK synchronizes provider records and ingests new plain-text replies into the existing correspondence aggregate. All HTTP is injected. There is no default network client, OAuth setup, scheduler, webhook server, outbound transport or web application. Tests use fictional JSON and streaming fake transports exclusively.

## SDK entry points

```ts
import { createMailboxSyncState, synchronizeMailbox } from '@accountability/correspondence';
import type { Context } from '@accountability/correspondence/contracts';
import type { SyncBinding, ReadOnlyMailboxTransport, MailboxSyncStore } from '@accountability/correspondence';

export async function poll(context: Context, binding: SyncBinding,
  transport: ReadOnlyMailboxTransport, store: MailboxSyncStore) {
  // The host initializes its scoped store with createMailboxSyncState(binding).
  return synchronizeMailbox({ context, binding, transport, store, limits: { maxPages: 2 } });
}
```

`context` must be a host-authenticated service with `correspondence:ingress`. `binding` contains exactly tenant/project, mailbox ID, provider, stable account reference, auth epoch, normalized mailbox address, explicit provider account ID and Graph folder ID (null for Gmail). Unknown binding properties are rejected. Gmail uses the explicit mailbox address as provider account ID; Graph uses its explicit user ID or UPN, not `me`. The transport must already be configured for that exact binding. Account references must never be reassigned to another provider account.

A transport implements `read({method: 'GET', url, headers, redirect: 'error', maxResponseBytes, timeoutMs, signal})`, returning `{status, body: AsyncIterable<Uint8Array>}`. It resolves credentials privately, enforces its identity, disables redirects and honors abort. The SDK supplies only Accept/Prefer headers. Credentials, provider error bodies, redirect locations and exception details are never stored or logged by this SDK. Opaque pagination URLs are stored checkpoint data and should not be put into host logs. Public exports use compiled ESM from `dist`.

## Persistence contract

`store.load(binding)` returns `{sync, correspondence}`. The sync state belongs to one exact scope/mailbox/account/epoch/collection; the correspondence aggregate is shared by all collections of that mailbox.

For each page the SDK:

1. Loads and checks scope, account, mailbox, epoch, service permission and checkpoint identity.
2. Reads a bounded provider page and the referenced messages using GET only.
3. Loads again after I/O. It rejects changed authorization or a concurrently advanced sync checkpoint, and applies replies against the current correspondence revision.
4. Prepares a new aggregate and sync cache, including unverified evidence or explicit quarantine/tombstone dispositions for every page entry.
5. Calls `store.commit({binding, expectedSyncRevision, expectedCorrespondenceRevision, next})`. The host must compare both revisions and persist **the entire next snapshot in one durable transaction**. Return true only after durability is confirmed. On false or exception no successful checkpoint is returned.

There is no separate checkpoint-write API. Persisting the cursor separately from ingested evidence violates the store contract. In-memory stores in tests demonstrate the protocol, not production durability. A storage outage can leave earlier pages committed; reloading resumes from those pages. A lost commit acknowledgement is recovered by reloading durable state. Never blindly apply an old `next` snapshot to a new epoch.

Provider message identity is `(provider, stable accountRef, message ID)` inside the authenticated aggregate scope. Graph requests immutable IDs. Replayed pages, label/read changes, reconnects to the same account and folder moves do not create duplicate reply evidence. Different accounts cannot collide. Changed content under an existing message ID is quarantined; the original ingested evidence and normal cached text remain unchanged. Sync cache tombstones never delete immutable correspondence evidence.

## Verified provider contracts

Official documentation was checked on 2026-10-26. These are implemented read contracts, verified with fake transport responses, not live-account acceptance.

| Provider operation | Request and parsed response | Official source |
| --- | --- | --- |
| Gmail baseline | GET `/gmail/v1/users/{address}/profile`: `emailAddress`, decimal `historyId` | [getProfile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile) |
| Gmail enumeration | GET `/gmail/v1/users/{address}/messages?maxResults=N&includeSpamTrash=true[&pageToken=...]`: `messages[].id`, `nextPageToken` | [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) |
| Gmail content | GET `/gmail/v1/users/{address}/messages/{id}?format=full`: matching `id`, `threadId`, `labelIds`, MIME `payload` | [messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [MessagePart](https://developers.google.com/resources/api-libraries/documentation/gmail/v1/java/latest/com/google/api/services/gmail/model/MessagePart.html), [base64url body](https://developers.google.com/resources/api-libraries/documentation/gmail/v1/java/latest/com/google/api/services/gmail/model/MessagePartBody.html) |
| Gmail incremental changes | GET `/gmail/v1/users/{address}/history?startHistoryId=...&maxResults=N[&pageToken=...]`: `history`, `historyId`, `nextPageToken` | [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [sync guide](https://developers.google.com/workspace/gmail/api/guides/sync) |
| Graph collection | GET `/v1.0/users/{id}/mailFolders/{folder}/messages/delta?$select=id,changeKey,isRead&$top=N`: `value[].id`, exactly one `@odata.nextLink` or `@odata.deltaLink` | [message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0), [changeKey resource field](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0) |
| Graph content/membership | GET `/v1.0/users/{id}/mailFolders/{folder}/messages/{messageId}?$select=...`: body, recipients, IDs, flags and internet headers; 404 becomes a tombstone | [get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) |
| Graph stable IDs | `Prefer: IdType="ImmutableId"` on every read, plus plaintext preference and bounded page-size preference | [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), [plaintext body preference](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) |
| Graph reset | 410 or an exact whitelisted `syncStateNotFound` code on 400/404 causes a fresh initial folder delta | [delta reset and expiration](https://learn.microsoft.com/en-us/graph/delta-query-overview) |

Gmail captures a profile history baseline **before** enumeration. Each full page persists its baseline and page token. After the last full page, incremental history starts at that baseline so messages arriving during enumeration are revisited. While history is paginated, its original start ID stays fixed. Only the final persisted history page advances to the returned history ID. A stale history 404 restarts full enumeration. During resync, old cache entries are marked absent only when enumeration completes.

Graph applies complete opaque continuation URLs verbatim after checking HTTPS origin, exact account/folder delta path, query allowlist and token type. A link cannot switch users, folders or hosts, add credentials, redirect or invoke a write endpoint. Reset ignores provider Location headers and rebuilds its known initial URL. Delta pages can replay or reorder changes; even tombstones are checked using a folder-scoped message GET, so a stale removal cannot discard a message currently in that folder. Initial/reset generations mark missing cache entries only after the final page. Message body changes are tracked through `changeKey`, with full selected content fetched separately.

The caller needs preexisting read permissions appropriate to message bodies: Gmail read-only mailbox access and Graph Mail.Read are examples from the official operation permission tables. This SDK neither acquires permissions nor provisions accounts. Graph synchronization is explicitly per configured folder; callers manage the desired folder set. Each folder needs its own checkpoint with shared atomic aggregate revision control.

## Bounds and quarantined content

| Limit | Default | Hard maximum |
| --- | ---: | ---: |
| Pages per invocation | 2 | 10 |
| Entries requested per page | 25 | 100 |
| Distinct changed messages per page | 100 | 500 |
| HTTP response bytes | 262,144 | 2,097,152 |
| Message GET response/content bytes | 131,072 | 1,048,576 |
| Normalized page bytes | 1,048,576 | 8,388,608 |
| Plain text bytes | 20,000 | 20,000 |
| Cached message records | 10,000 | 50,000 |
| Per-read wall time | 15 seconds | 60 seconds |

Responses are streamed, capped before JSON parsing, limited to 4,096 chunks, and decoded as UTF-8. Malformed JSON, HTTP failures, oversized responses/pages, loops and exhausted cache capacity do not advance the current page's checkpoint. Limits are enforced on actual responses; provider page-size preferences are not trusted. Calls are sequential, and the invocation stops at the page budget with `more: true` if unfinished. The host controls scheduling and retry/backoff for failed reads; the SDK never retries HTTP automatically. No outgoing send command is accepted by this transport interface.

Gmail MIME traversal permits at most 100 parts and depth 10. UTF-8/ASCII plain text is ingested; HTML and unsupported MIME/charsets are isolated. Attachments, attachment IDs and inline payloads marked as attachments are never fetched or decoded as reply text. Graph requests plain text but quarantines HTML if returned and records an attachment marker when `hasAttachments` is true. Graph's flag can omit inline attachments; the SDK never downloads attachments of any kind. Quarantine keeps bounded inert base64 for non-attachment content up to 65,536 bytes, otherwise digest/size metadata. It is never rendered, executed, scanned as authority or followed for remote URLs.

A malformed/oversized decoded message becomes an explicit persisted quarantine disposition under its provider ID, allowing the page to advance without pretending it was ingested. An HTTP byte-limit failure is different: parsing did not complete, so the page does not advance. Quarantine IDs permit later host-controlled isolated review; there is no automatic retrieval or release operation.

Incoming evidence is always `received-unverified`, `verification: unverified`, `policyAuthority: false`. It cannot issue grants or execute instructions. A reply can pause contact or trigger conservative optout suppression. Matching reply headers join a known outgoing thread; otherwise the SDK uses a deterministic account/conversation/sender thread. New thread creation is allowed only inside the existing authenticated ingress command. No privileged human context is forged by the SDK.

Address/MIME parsing is deliberately conservative. Complex address groups, ambiguous headers, unsupported encodings or excessive references are quarantined. To-addresses must include the configured mailbox to become correspondence evidence; other records remain in the provider cache. Bcc/alias/list-delivery routing requires a separate host policy. Provider cache labels/read state remain separate from local human folder/read controls. Sent/draft provider records are cached without fabricating delivery or outbound approval.

## Acceptance evidence

COE-001 is mapped to merged foundation PR #1, with successful CI at its actual final source head `626e12d2c7750a4debc411a83205ea6f6143a677`. COE-002 is the only additional unit and is mapped to PR #2. The PR description records the actual final source SHA and its observed CI run; earlier checkpoints are not substituted for final-head evidence. `pullRequests` remains empty until a complete canonical observation is available. No live account, OAuth, email send, remote attachment fetch or deployment acceptance has been performed.
