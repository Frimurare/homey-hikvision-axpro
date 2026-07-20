# Roadmap

## v1.1 — PIR-CAM images & alarm logging

Planned for the next release. Notes captured 2026-07-20.

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
