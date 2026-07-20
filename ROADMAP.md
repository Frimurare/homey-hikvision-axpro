# Roadmap

Agreed feature set (aligned 2026-07-20). Everything below is planned; the panel-hardware
items (A) will be verified in single, reused ISAPI sessions to avoid saturating the panel's
login pool.

## Planned features (A–I)

### A. PIR-CAM snapshot on real alarm ⭐
Give `pircam` detectors (Hall Nere, Gästrum, Edwins Rum) a live image in Homey when they
trigger. Confirmed mechanism: panel pushes the capture over `/ISAPI/Event/notification/alertStream`.
See detailed notes under *"v1.1 detail"* below. **Note: on-demand test capture is NOT
possible locally on this firmware (documented dead-end) — images are alarm-driven only.**

### B. Areas (partitions) as their own devices ⭐
The panel has up to 14 areas (Sånglärksvägen, Garage, gästrum, Skalskydd…). Expose **each
enabled area as its own alarm device** so you can arm/disarm one area independently instead
of only the whole system. Read from `/ISAPI/SecurityCP/status/subSystems`; control via the
per-area arm/disarm endpoints. Biggest single upgrade for multi-area panels.

### C. Richer flow cards ⭐
- **Trigger** "A detector alarmed" — tokens: detector name, type, area, snapshot (also the
  vehicle for feature A).
- **Trigger** "System armed / disarmed" — with **by what** (keypad / keyfob / app) so flows
  like *disarmed by keyfob → welcome-home scene* are possible.
- **Conditions** — "system is armed", "area X is armed", "zone is bypassed".
- **Actions** — arm/disarm a specific area, bypass/unbypass a zone, trigger/silence siren.

### D. Panel health as sensors
Surface host-status fields already available: **mains power (ACConnect) → power-loss alarm**,
panel tamper, fault count, Wi-Fi / cellular / network state. "Mains lost → notify" is high-value
and trivial (data already polled).

### E. Low battery + detector offline
`alarm_battery` when a detector drops below threshold, and an "offline" alarm when a detector
loses contact with the panel. Standard maintenance notifications users expect.

### F. Repair flow (change password / IP without removing devices)
Homey's built-in device **Repair** wizard: if the panel password or IP changes, every AX PRO
device stops working at once. Repair lets the user re-enter the new credentials on a device
and update the stored login **without deleting and re-adding everything**. The rescue button
for a password/IP change. (Pairs with H.)

### G. More languages
Expand from 5 → 10 languages to match the OpenEye app (add no, da, uk, el, it). Same
localisation approach; low effort, wider reach.

### H. Add more detectors without re-adding the panel
When "Add device → Hikvision AX PRO" runs and a panel is already paired, **skip the login
step** (reuse stored credentials) and go straight to the device list, showing **only
not-yet-added** detectors. So newly enrolled sensors (e.g. a new garage detector) appear
instantly with no IP/password re-entry and no duplicates. (Pairs with F: F fixes existing
devices, H adds new ones — the user should never have to tear down and rebuild.)

### I. Hikvision cameras (post-summer, strategic)
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
