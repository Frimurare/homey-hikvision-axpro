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
