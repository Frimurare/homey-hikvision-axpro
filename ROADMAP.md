# Roadmap

Agreed feature set (aligned 2026-07-20).

**Status:** **A–H are DONE — shipped in v1.1.0 BETA "Aegis"** (validates at publish level;
released on GitHub as `v1.1.0-beta.1`). The only remaining item is **I (Hikvision cameras)**,
deferred to post-summer per plan.

One follow-up on A: the snapshot *plumbing* ships, but the exact PIR-CAM payload keying still
needs a one-time check against a real armed alarm (open the alertStream, arm, trigger a
PIR-CAM, confirm the JPEG/JSON format) — to be done in a single clean, reused session.

## Feature status (A–I)

### ✅ A. PIR-CAM snapshot on real alarm ⭐ — DONE (payload check pending)
`pircam` detectors get a live image via the shared `alertStream` listener; the *"A detector
alarmed"* trigger carries a snapshot token, and PIR-CAM devices get a camera image tile.
Confirmed mechanism: panel pushes the capture over `/ISAPI/Event/notification/alertStream`.
**Note:** on-demand test capture is NOT possible locally on this firmware (documented
dead-end) — images are alarm-driven only. See *"v1.1 detail"* below for the pending check.

### ✅ B. Areas (partitions) as their own devices ⭐ — DONE
Each enabled area is now its own Homey alarm device (arm/disarm per area), read from
`/ISAPI/SecurityCP/status/subSystems` and controlled via the per-area arm/disarm endpoints.

### ✅ C. Richer flow cards ⭐ — DONE
- **Triggers:** "A detector alarmed" (tokens: name, type, area, snapshot), "System armed"
  (with mode), "System disarmed".
- **Conditions:** "System is armed", "Area is armed".
- **Actions:** arm area, disarm area, bypass/restore a zone, sound/silence the siren.

### ✅ D. Panel health as sensors — DONE
New **Mains power lost** capability (`alarm_mains`, from `ACConnect`) plus panel **tamper**
on the panel device — flow on a power cut.

### ✅ E. Low battery + detector offline — DONE
`alarm_battery` when a detector drops below 20 %; detectors go unavailable ("offline") when
they lose contact with the panel.

### ✅ F. Repair flow (change password / IP without removing devices) — DONE
Homey's device **Repair** wizard re-enters the panel IP/password on a device and propagates
the new credentials to every device on that panel — no delete-and-re-add. (Pairs with H.)

### ✅ G. Languages — DONE (15 languages)
Expanded to **15 languages** — en, sv, de, fr, nl, it, no, da, uk, el, es, pl, ru, ko, zh —
covering all of Homey's UI languages. Homey auto-selects.

### ✅ H. Add more detectors without re-adding the panel — DONE
Pairing reuses the stored login, **skips the login step**, and lists **only not-yet-added**
detectors, so newly enrolled sensors just appear — no IP/password re-entry, no duplicates.
(Pairs with F: F fixes existing devices, H adds new ones — never tear down and rebuild.)

### ⏳ I. Hikvision cameras (post-summer, strategic) — NOT STARTED
Ulf has many Hikvision cameras. Reuse the **OpenEye app's proven pattern**: camera as a Homey
device with a snapshot tile (`/ISAPI/Streaming/channels/101/picture`) + smart-detection events
(motion, line-cross, intrusion, face) as flow triggers via the same `alertStream` mechanism the
alarm already uses; optional PTZ, NVR channel enumeration, doorbells. **Open decision:** ship as
a separate "Hikvision Cameras" app or as a camera driver in this app. The existing Store
Hikvision app is old/abandoned — there is a gap to fill. Keep the alarm app focused and polished
first (that is what the current Athom review judges); cameras follow after summer.

---

## v1.1 detail — PIR-CAM images & alarm logging

Notes captured 2026-07-20.

### 🎥 1. PIR-CAM snapshot on real alarm (the main feature)

Give PIR-camera detectors (`pircam` type — e.g. Hall Nere, Gästrum, Edwins Rum) a
**live image in Homey when they trigger for real**, mirroring the OpenEye app's
snapshot token.

**Confirmed mechanism:** the panel pushes the captured image over
`/ISAPI/Event/notification/alertStream` (a long-lived multipart HTTP stream) when a
PIR-CAM alarms. This is the only local path to the image.

**Plan:**
- Add a single shared `alertStream` listener (one per panel, alongside the existing
  status poller) that stays connected and parses events.
- On a `pircam` alarm event, extract the captured image and expose it as a **Snapshot
  token** on a new flow trigger card *"A detector alarmed"* (with detector + snapshot
  tokens). This lets a flow send a push notification with the image, exactly like OpenEye.
- Give `pircam` devices an actual camera image (`setCameraImage`) so the last capture
  shows on the device tile too.

**⚠️ Open item — must verify against real hardware before building:** we still need to
confirm *what the alertStream actually delivers* for a `pircam` alarm — is the JPEG
inline in the multipart event, or is it a reference/URL to fetch? This can only be seen
with a genuine alarm: open the stream, **arm** the system, trigger a PIR-CAM (e.g. Hall
Nere), and capture the exact payload format. **Do this in one clean, reused session.**

### 🚫 2. Manual "test image" on demand — NOT feasible locally (documented dead-end)

Investigated 2026-07-20 on DS-PWA96-M-WE, firmware V1.2.9:
- `PUT /ISAPI/SecurityCP/control/pictureCatch/*` → **`notSupport`**
- `GET /ISAPI/SecurityCP/status/zones/pictureCatch` → returns plain zone status only,
  **no stored picture / no picture URL fields**

So there is **no local ISAPI path to request an on-demand test capture** on this
firmware — Hik-Connect's "test image" appears to go via the cloud, which the app can't
reach. Conclusion: PIR-CAM images are **alarm-driven only** (see feature 1). Revisit if a
future firmware exposes a local capture command.

### 📝 3. Alarm logging (already works — document + polish)

Homey already logs this today with the current app:
- **Insights** automatically records every alarm capability (`alarm_motion`,
  `alarm_contact`, …) over time — you can see exactly when a detector went off.
- A flow *"When <detector> alarms → write to Timeline / send notification"* gives a
  human-readable, timestamped log.

v1.1 polish: add the *"A detector alarmed"* trigger card (also needed for feature 1) so
users get one clean card with detector-name + type + snapshot tokens for logging and
notifications, instead of relying on per-device capability triggers.

### Sensor-behaviour note (already shipped in README)

PIR detectors sleep while disarmed (battery life) and only report motion when armed;
magnetic contacts report 24/7. This is documented under *"Understanding your sensors"* so
users don't file the expected behaviour as a bug. PIR-CAM images therefore only exist for
**armed** alarms — consistent with feature 1.

---

## v1.1.8 — shipped 2026-09-12 (status of the field reports below)

| # | Item | Status in 1.1.8 |
|---|------|-----------------|
| 0 | **Arm returns 404 (disarm works)** on newer firmware — V1.3.1 build 251113, reported via two Homey crash reports (2026-08-23, 2026-09-07) and the community thread *"Hikvision AX Pro Alarm 404 error"* (2026-09-02) | **Fixed.** The panel's own endpoint list documents arm as `/ISAPI/SecurityCP/control/arm/<ID>?ways=<string>&format=json` and disarm *without* `format`. Newer builds only serve the JSON form for arm (plain URL → 404 `methodNotAllowed`), older builds serve both. `HikAxPro._control()` now sends the JSON form first, falls back to the plain form on 404/405, and remembers what worked. Whole-system arm falls back to per-area commands if the panel rejects `0xffffffff`. Status is re-polled 1.5 s after any control command. Covered by `test/control.test.js` (mock panel). Field confirmation on a real 251113 panel still wanted. |
| 1 | Login 400 on newer builds under cloud management (Local User) | **Partly.** Login negotiation now tolerates a missing `sessionIDVersion`/`isIrreversible`, never writes `null` into the request, and sends the same element set/order as the panel's web page (`isSessionIDValidLongTerm`). The full 400 body and the capability field names are written to the app log on failure, so the reporter's diagnostic report will show the cause. Open experiment if it persists: the `X-Userlevel` header (0 = installer, 1 = admin/operator) that the HA integration sends on the capabilities request — a *Local User* (role 625-type) may need its own level. Needs the reporter's `sessionLogin/capabilities?username=<local user>` XML. |
| 2 | Shock triggers on combined magnet+shock contacts | **Done (best effort).** Detector types containing `shock`/`vibrat` get `alarm_generic` (mirrors the zone `alarm` flag) next to `alarm_contact`; existing devices are upgraded on app start. If the panel reports the combined detector under a name without those words, the diagnostic line `detectorTypes=` in the log tells us what to add. |
| 3 | Pairing-dialog errors too long | **Done.** Short, localized (en/sv) messages: locked (with seconds), 401 → "use a local Administrator user", 400 → reason + "send a diagnostic report", unreachable, generic. Full detail in the app log. |
| 4 | Diagnostic dump | **Done.** One-time, log-only, on the existing session: model/firmware (`/ISAPI/System/deviceInfo`), login-capabilities field names, zone/area/host field names, detector types. No values, names or credentials. |

Inspiration/verification sources: `petrleocompel/hikaxpro` + `hikaxpro_hacs` (always `format=json`, `X-Userlevel`, confirmed working on AX Hybrid Pro DS-PHA64-LP with 4 areas) and `emmetdel/hikvision-api` (panel endpoint dump, web-page login body).

## v1.1.8 — field reports (2026-08-16)

Three items raised by users running the app on panels and firmware builds that are not
available here for testing. Nothing below contains user or site details.

### 🔓 1. Login fails on newer panel/web builds under cloud management — HIGH PRIORITY

**Reported:** a user on panel firmware V1.3.1 with a newer web build, managed through the
vendor's cloud/installer portal, cannot complete pairing.

**Symptoms:**
- Cloud-tied *administrator* and *installer* accounts return **401**. This is expected
  rather than a fault: accounts bound to the vendor cloud are not available for local
  authentication against the panel itself, whichever spelling of the name is used.
  Creating a dedicated **local user** on the panel is the correct approach.
- That local user gets past the 401 and then returns **HTTP 400**. Crucially, the same 400
  appears with a deliberately *incorrect* password — so the request is failing before the
  credentials are ever evaluated.

**Cause:** the panel and the app negotiate a set of login parameters before authentication
takes place. The login routine does not yet validate the full field set that newer builds
return, so when the response differs from what is expected the request is assembled from an
incomplete set and the panel rejects it — which is why the same 400 appears regardless of
the password supplied. Field-level analysis is tracked with the fix.

**Planned:**
- Validate the capability response in full and adapt to what a given panel actually
  provides, rather than assuming a fixed field set.
- Choose the authentication variant from what the panel reports, with a sensible default
  when a field is absent.
- Fail with a clear, specific message when the negotiation genuinely cannot proceed.

**Verification:** confirm against the reporting user's capabilities response (the endpoint
needs no authentication) plus a Homey diagnostic report taken right after a failed login.
This panel/web/cloud combination is not available locally, so a field test is required
before release.

### 🚪 2. Shock/vibration triggers not surfaced on contact-type detectors

**Reported:** a user with a combined magnet + shock door contact. The magnet side works
(open/close is reflected in Homey); shock triggers never appear.

**Cause:** `zoneProfile()` maps shock-capable detectors to the *contact* profile, whose
capability set is `alarm_contact` plus temperature/battery/tamper. `device.js` derives
`alarm_contact` from `magnetOpenStatus` and mirrors the zone's `alarm` flag onto the other
alarm capabilities — none of which exist on this profile. Since `_set()` no-ops on
capabilities a device does not have, the shock event is read from the panel and then
silently discarded.

**Planned:** give shock-capable detectors a capability that reflects the zone alarm flag
alongside the magnet state, so both halves of a combined detector are visible. Confirm the
`detectorType` string these detectors report and which field changes on shock, from a field
capture taken before and immediately after a trigger, before settling the mapping.

### 💬 3. Pairing-dialog error messages are too long to read

Homey's pairing dialog does not scroll, so a long message — a full request URL, for example
— is truncated and the useful part is lost. Planned: a short, actionable message in the
dialog, with the full technical detail written to the app log where it can be read and
included in a diagnostic report.

### 🧪 4. Diagnostic dump (supporting the above)

Add a one-time, log-only dump of the raw zone payload and of the field names present in the
login capabilities response, so field issues can be diagnosed from a Homey diagnostic report
instead of asking users to query the panel by hand in a browser. **Must reuse the app's
existing session** — the panel keeps a very small session table, and a competing login makes
it unreachable for several minutes.
