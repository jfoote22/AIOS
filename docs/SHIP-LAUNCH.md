# AIOS distribution and business execution plan

2026-09-18. Use after and alongside [the engineering plan](SHIP-PLAN.md) and [work packets B01–B40](SHIP-BACKLOG.md). Prices below are either explicitly sourced publisher costs or clearly labeled business hypotheses. No accounts were created, money spent, releases published, or customers contacted during this assessment.

## Position the product around a specific result

Proposed promise: **Capture it once. Find it, understand it, and act on it from any device.**

The first target customer is an individual researcher, builder, analyst, or intensive learner who accumulates screenshots, videos, articles, and AI conversations across a phone and computer. The strongest demonstration is a phone screenshot or video becoming a searchable, evidence-linked neuron on a laptop, followed by a targeted research or agent task.

Lead with this workflow. The 3D brain makes the product memorable; reliable saving and retrieval make it valuable. Present agent orchestration as a powerful extension of the captured knowledge rather than requiring every new user to configure several coding agents.

There is already demand for local software with paid convenience services, but competition is real. Obsidian offers a no-signup local product with optional paid encrypted sync; Joplin offers managed and self-hosted synchronization options. Readwise Reader addresses capture and reading workflows. These are useful comparison sets, not proof of demand for AIOS or evidence that competitors lack any particular feature. [Obsidian pricing](https://obsidian.md/pricing), [Joplin plans](https://joplinapp.org/plans/), [Readwise Reader](https://readwise.io/read).

Validate AIOS's differentiation through time saved: capture-to-retrieval, video-to-cited-notes, and evidence-to-agent-task. Avoid a generic “all AI tools in one app” campaign until the focused workflow earns repeat use.

## Accounts: what is unavoidable and what remains optional

### For an AIOS user

| Use case | Account needed? | Design requirement |
|---|---|---|
| Local capture, OCR, notes, lexical search, export/import | No AIOS or AI-provider account | Ship a useful baseline OCR language pack and permit local vault creation |
| Local transcription/embeddings/chat | Generally no hosted account for supported installed local runtimes/models | Explain download size, model license, hardware, and offline availability |
| Sync through own PC/NAS on a private network | No external service account | Device pairing still creates cryptographic identities; document TLS/trust setup |
| Sync through own rented server | Hosting account with chosen supplier | One documented deployment; no dependency on AIOS's hosted service |
| AIOS-managed sync/web account | Yes, one AIOS service identity | Prefer simple passkey-capable login; account recovery is separate from vault decryption |
| OpenAI, Anthropic, xAI, or Google API processing | Relevant provider account/key or an explicitly purchased managed AI service | Show destination, billing mode, and data transmitted |
| Existing supported agent login | Existing provider/runtime account as applicable | Let the supported runtime own authentication; verify commercial integration rights |
| Hermes/OpenClaw | No new AIOS account for a locally managed instance | Their model/hosting configuration may require accounts |
| Native mobile store download | Normal Apple/Google platform access where applicable | This is separate from requiring an AIOS account to use the installed app |
| Notifications/VPN helpers | Optional | Core capture/sync must recover without push or a proprietary VPN account |

An account-free local app and convenient managed cloud sync are compatible product offerings. Account-free managed infrastructure is not a sound default commercial assumption: hosting, authorization, quota, recovery, and billing need durable service identity.

### For the publisher

| Account or dependency | When to establish it | Cost/obligation and reason |
|---|---|---|
| Source hosting and protected CI | Immediately | Existing repository host can suffice; protect releases and signing credentials |
| Apple Developer Program | Early, before iOS TestFlight and signed/notarized macOS releases | Currently US$99 per membership year, regional variation/waivers possible; verify enrollment requirements before paying |
| Google Play Console | Before Android closed testing | Currently US$25 one-time enrollment; identity/device/testing requirements vary by account |
| Windows signing identity/service | Before public desktop beta | Microsoft Artifact Signing currently starts at US$9.99/month; eligibility and identity validation apply; another trusted signing option can be used |
| Domain/DNS and public website | During beta preparation | Provider-dependent cost; needed for credible downloads, privacy, help, and optional service endpoints |
| Hosted compute/database/object storage | Only for managed sync | Obtain workload-based quotes; impose quotas and budget alerts before opening signups |
| Payment processor or merchant of record | Before taking payments | Verify identity, fees, tax responsibilities, refunds, and supported regions; choose intentionally |
| Support and status hosting | Before external beta | Can start with simple hosted tools and a dedicated mailbox; separate content access from support access |
| Push credentials/APNs/FCM | If push is enabled | Additional developer setup; notifications carry no brain contents and are not required for consistency |
| Expo EAS | Optional build convenience | Native builds can be produced with local/CI platform toolchains; do not require users to hold an Expo account |
| Independent security reviewer | Before encrypted-sync GA claims | Budget a real review and retest; cryptographic design cannot be validated by marketing copy |

Publisher cost sources checked for this plan: [Apple enrollment](https://developer.apple.com/programs/enroll/), [Google Play setup](https://support.google.com/googleplay/android-developer/answer/6112435), [Microsoft signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation). Recheck prices and eligibility when enrolling. Signing improves provenance; new Windows downloads can still encounter reputation warnings.

Do not purchase all these services before the architecture spikes. Establish publisher identity and store accounts early because verification can take time; acquire production hosting capacity only when a tested service and pilot cohort need it. A Mac build/test environment and physical iOS/Android devices are engineering needs even if cloud CI produces binaries.

## Offer and revenue model

Recommended starting model: free useful local software, optional paid managed sync, and bring-your-own-provider credentials. Make self-hosting a supported path. Charge for reliable convenience and service, while keeping encryption, basic data access, and export available to everyone.

| Offer | Included | Initial pricing hypothesis |
|---|---|---|
| AIOS Local | Local encrypted vault, capture/OCR, installed local processing, brain, personal agent connections, export/import | Free |
| AIOS Sync | Managed encrypted replication, device management, encrypted history/backups, web access, a defined storage allowance | Test US$8–12/month; compare an annual offer; do not finalize before cost and willingness-to-pay evidence |
| Additional storage | Higher encrypted media allowance with clear transfer/retention limits | Price from measured usage and supplier costs |
| Managed processing, later | Optional metered transcription/research/runner jobs with disclosed processing trust | Credits or usage billing with hard budgets; never unlimited AI by default |
| Teams, later | Shared vault permissions, administration, business support | Defer until collaboration key management and demand justify the work |

Encryption and portability are product promises, not upsells. A subscription should never be required to unlock an existing local vault or retrieve a JSON export. Paid hosting may have a documented grace/retention period after cancellation, with advance notification and an export path.

Avoid lifetime cloud-storage promises, unlimited video processing, or bundling third-party subscriptions without rights. User-supplied API keys reduce AIOS's inference costs but do not eliminate support or integration obligations.

Calculate economics before setting storage allowances:

```text
monthly contribution per paid user
  = collected subscription revenue excluding taxes/refunds
  - payment/store fees
  - encrypted storage + backup + requests + egress
  - allocated sync compute/monitoring
  - variable support cost
  - any AI processing AIOS pays for
```

Illustration only, not a vendor quote: at $12/month, $0.70 payment cost, $1.30 infrastructure, and $1.00 variable support leave $9.00 contribution, or 75%, before engineering, marketing, legal, and other fixed costs. If video-heavy users increase infrastructure to $5, that contribution falls to $5.30. Measure median and p95 storage/traffic, not only averages. For an annual discount, calculate against its lower monthly recognized revenue.

Break-even subscribers = monthly fixed operating cost / measured contribution per subscriber. Use actual quotes and pilot data; this plan does not establish a revenue forecast. Include app-store commissions/taxes if the chosen purchase flow incurs them.

## Exact distribution preparation

1. Choose the public product name/domain after a brand-rights check. Record the publisher/legal entity and license for the app and relay. Resolve brain asset, model, codec, and CLI distribution rights.
2. Publish the support matrix: OS versions, architectures, local model hardware, browser versions, and capture backends. Do not claim Intel Mac, Windows ARM, every Linux compositor, or every browser until tested.
3. Produce signed Windows installers, signed/notarized macOS packages, and verified Linux packages from pinned CI. Verify native SQLite/PTY/media binaries on their actual target platforms.
4. Produce signed Android and iOS release builds with the native share features. Complete actual beta installation and update tests, not just simulator screenshots.
5. Ship signed update metadata, release channels, backups before schema conversion, and a tested recovery/downgrade story. Updating the app and migrating a vault are separate failure boundaries.
6. Package self-hosting as a documented Compose deployment with persistent volumes, TLS, scoped administrator bootstrap, backups, resource requirements, logs, and an optional runner. Provide a clean-server setup and restore tutorial.
7. Publish a download page with artifact version, supported OS/CPU, signature/checksum guidance, release notes, and known issues. Ordinary users should not install Node, npm, Python, Expo, or Docker to run a native client.
8. Prepare store descriptions, screenshots, permission explanations, privacy labels, account deletion, and review access. Verify regional billing and AI/remote-execution rules before submission. The mobile app is a native knowledge client and remote controller; do not ship arbitrary downloaded desktop agent code inside it.

Store policy and media-source permissions affect distribution. Review the current rules for billing links, downloaded code, recording consent, and third-party media access; do not promise universal downloads from video sites. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Rollout sequence

### During engineering: demand discovery and readiness

Founder/product owner prepares a demo using synthetic content, a one-page explanation, an interview script, and an opt-in beta form. Interview approximately 10–15 target users about their last lost screenshot/note/video insight, current retrieval workflow, and willingness to pay for cross-device reliability. Ask them to demonstrate their workflow rather than react only to a feature list.

Produce a prioritized friction list and three test scenarios: mobile screenshot retrieval, video evidence extraction, and brain-to-agent action. Prepare account paperwork and release documentation alongside development. Do not claim shipping encryption/sync before implementation and verification.

### Private alpha: prove the entire loop

Use 5–10 invited technical users with recoverable test data. Test install → vault → offline capture → processing → second device → export → restore → revoke. Use local-only alpha first if necessary, clearly labeled. Give participants exact backup/recovery instructions and collect structured issue reports.

Exit when every acknowledged capture survives the tested failures, participants can recover a vault without the original machine, and access-control defects are closed. Do not use a visually impressive graph as the exit criterion.

### Closed beta: prove ordinary users can succeed

Recruit 30–50 consenting users, including at least 20 using two devices. Include Windows/macOS, representative Linux environments, Android, and iOS. Observe first-run use before teaching shortcuts. Run at least a 14-day release-candidate soak and document sample sizes.

Proposed decision targets: at least 80% of observed new users save a first capture within five minutes; at least 80% of two-device participants pair and retrieve without live help; no unrecovered loss of acknowledged captures; at least 40% of activated users still use the core capture/retrieval loop in week four. These are hypotheses for a small beta, not industry benchmarks or statistically conclusive thresholds.

Track install success, first durable capture, first successful retrieval, second-device activation, weekly captures retrieved, processing failures, sync lag, restoration success, support time, and opt-in crash rate. Keep all content out of default analytics. Local-only users can decline all telemetry.

### Pricing pilot

After users repeatedly complete the core workflow, test two clearly described paid-sync offers. Ask for actual purchase intent or a transparent paid pilot, not only survey approval. Measure conversion, cancellation reasons, support costs, and p95 storage/egress. Confirm the service can operate at its proposed allowance and price.

If users primarily want better capture rather than more agents, prioritize that evidence. Do not expand the provider catalog faster than the team can maintain authentication and compatibility tests.

### Release candidate: prepare a reviewable launch

Freeze a candidate, complete B32's test matrix and external security review, fix/retest findings, and rehearse service restore and incident response. Verify store approvals, production signing identity, download artifacts, migration backups, deletion/export, rate limits, billing, and support ownership.

Assemble `release-manifest.json` as a release-engineering deliverable: commit, app/protocol/schema versions, artifact URLs and hashes, signing verification, supported platforms, test evidence, known issues, rollback instructions, and approvals. This file is proposed; it is not generated by the current release workflow.

The founder/release owner approves this concrete package. Passing a build does not authorize public publication, vendor agreements, marketing messages, or spending.

### Launch day and following week

1. Publish the approved installers/store releases, self-host package, guides, security summary, and status/support pages.
2. Enable managed-service signups in a bounded cohort with storage/job quotas and infrastructure budget alerts.
3. Send reviewed announcements only through channels the owner authorizes; demonstrate the three proven workflows with synthetic data.
4. Expand supported staged updates from small cohorts to the full population only while capture durability, errors, and migration metrics stay within gates.
5. Stop rollout immediately for credible data loss, authorization bypass, vault-lock failures, or destructive migration. Triage ordinary provider outages separately so offline capture remains available.
6. Review support daily in week one, ship narrowly scoped fixes with the affected regression checks, and keep a public known-issues list.

Marketing channels to test include focused research/knowledge-management communities, local-first software communities, instructional video demos, and provider-integration tutorials. Choose channels based on the recruited customers; do not mass-message communities or buy broad ads before retention is visible.

### First 90 days

Days 1–30: stabilize installation, native sharing, retrieval, sync, and provider auth. Days 31–60: improve the largest activation bottleneck and validate paid-sync retention/economics. Days 61–90: test one growth channel and one demanded expansion, such as browser capture or a better video workflow. Use explicit success/stop criteria before spending.

## Operational responsibilities before charging money

Assign named owners for releases/signing keys, vault/security incidents, hosted uptime/backups, provider compatibility, mobile store compliance, support, and billing. One founder can hold several roles initially, but the obligations cannot be implicit.

Proposed initial service objectives: 99.9% monthly relay availability; existing local vault access during outages; daily encrypted backups plus a more frequent durable log policy; documented server recovery target of four hours and metadata recovery-point target of fifteen minutes. These RPO/RTO figures are design targets to validate, not current capabilities. A new uncached device may be unable to recover everything until service returns; an acknowledged sync write requires a separately specified replication/durability policy.

Maintain a vulnerability reporting address, incident severity/communication playbook, vendor outage responses, restore drill schedule, dependency/adaptor review cadence, secret rotation procedure, and a decision owner for suspending signups or updates. Provide diagnostics that users can inspect before sending to support.

Perform a final consistency review of product claims: encrypted storage versus external processing, cloud availability versus runner availability, deletion versus retained backups, provider subscription versus API access, experimental versus supported adapter features, and supported versus merely buildable platforms.

## Decision checkpoints

| Checkpoint | Owner decision | Default recommendation |
|---|---|---|
| After architecture spikes | Native encryption binding, mobile share implementation, sync scope | Keep existing frameworks; one-user multi-device vault first |
| Before external beta | Supported platforms and initial provider versions | Publish only tested combinations; mark experimental adapters clearly |
| Before paid pilot | License, storage allowance, pricing, billing provider | Useful free local core; paid managed sync; BYOK AI |
| Before GA | Exact candidate, evidence, operational readiness, marketing claims | Release only after the written gates pass |
| After 30–90 days | Growth spend and expansion | Invest where retained users demonstrate value |

Yes: a bring-to-market workstream should follow hardening, with discovery and account preparation beginning earlier. The next implementation action is B01–B04, accompanied by the encryption feasibility work—not public cloud exposure or a paid launch of the current build.
