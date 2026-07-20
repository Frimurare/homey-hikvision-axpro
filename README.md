<p align="center">
  <img src="drivers/panel/assets/images/large.png" width="220" alt="Hikvision AX PRO for Homey">
</p>

<h1 align="center">Hikvision AX PRO — Homey App</h1>

<p align="center">
  Local control and monitoring for <b>Hikvision AX PRO</b> wireless alarm systems, directly from Homey Pro.<br>
  No cloud, no bridge — the app talks to your panel over your LAN.
</p>

<p align="center"><i>Built with ❤️ by Ulf Holmström</i></p>

---

## What it does

This app connects Homey Pro to a Hikvision **AX PRO** wireless alarm panel (DS-PWA96 / DS-PWA64 family) over the local network using the panel's ISAPI interface. It automatically discovers your panel, detectors and peripherals and creates them as real Homey devices — so your alarm sensors show up alongside the rest of your smart home, ready for the dashboard, Insights and Flows.

Everything runs **locally on the Homey** — there is no cloud dependency and no separate bridge to maintain.

## Features

- 🔎 **Auto-discovery** — connect once with the panel IP + login; the app lists the panel and every enrolled detector/peripheral to add.
- 🎛️ **Alarm panel** — arm (away), arm stay (partial) and disarm straight from Homey, plus current arm state.
- 🗂️ **Areas as devices** — every enabled area/partition becomes its own Homey device, so you can arm and disarm each area independently.
- ⚡ **Flow cards** — trigger *detector alarmed* (with the detector name, type, area and — for PIR-CAM — a **snapshot image token**), *system armed* / *system disarmed*; conditions *system is armed* and *area is armed*; actions arm/disarm an area, bypass/unbypass a zone and sound the siren.
- 📷 **PIR-CAM snapshots** — camera detectors capture a picture on alarm, shown on the device and available as a Flow image token.
- 🌡️ **Per-detector sensors** — temperature, battery level and tamper for every detector that reports them, plus **low-battery** and **offline** alarms. Battery devices appear in Homey's battery overview.
- 🔌 **Panel health** — mains-power-lost (`alarm_mains`) and tamper on the panel device.
- 🚪🚶🔥 **Correct sensor type per detector** — motion, door/contact, smoke, glass-break, water leak, CO, gas, heat and panic are each mapped to the right Homey alarm capability, with a distinct icon.
- 🧩 **Peripherals** — wireless keypads, external sirens, repeaters, card readers and relay/output modules.
- ➕ **Add detectors later** — newly enrolled sensors appear the next time you run *Add device*; no need to remove or re-add the panel.
- 🛠️ **Repair** — changed the panel's IP address or password? Use Homey's *Repair* on the panel device to update credentials without re-adding anything.
- ♻️ **Shared connection** — all Homey devices for a panel share a single, reused login session (kind to the panel — it never gets flooded with logins).
- 🌍 **Multilingual** — 15 languages: English, Svenska, Deutsch, Français, Nederlands, Italiano, Norsk, Dansk, Українська, Ελληνικά, Español, Polski, Русский, 한국어, 中文 (adapts to your Homey's language).
- 🔒 **Local only** — direct LAN/ISAPI communication, credentials stay on your Homey.

## Supported hardware

**Control panels**

| Model | Notes |
|-------|-------|
| DS-PWA96-M-WE / M2-WE / M2H-WE (Ultra) | Full support |
| DS-PWA64-L-WE | Supported |

**Detectors & peripherals** — matched by the *type* the panel reports, so the whole AX PRO catalogue is covered, including future models:

| Category | Homey capability | Examples |
|----------|------------------|----------|
| PIR / motion / curtain / PIR-cam | `alarm_motion` | DS-PDP15P, DS-PDPC12P, DS-PDC15, DS-PDQP15AM … |
| Magnetic contact / shock | `alarm_contact` | DS-PDMC-EG2, DS-PDMCS, DS-PDMCX … |
| Smoke detector | `alarm_smoke` | DS-PDSMK-S/E |
| Glass break | `alarm_generic` | DS-PDBG8, DS-PDPG12P |
| Water leak | `alarm_water` | DS-PDWL-E |
| CO detector | `alarm_co` | DS-PDCO-E |
| Heat / temperature | `measure_temperature` (+ `alarm_heat`) | DS-PDHT-E, DS-PDTPH-E |
| Emergency / panic button | `alarm_generic` | DS-PDEB1/2, DS-PDEBP1/2 |
| Keypad | temperature / battery / tamper | DS-PK1-LT-WE, DS-PK1-E-WE |
| External sounder / siren | battery / tamper | DS-PS1-E/I/II, DS-PK1-LT (strobe) |
| Repeater | battery / tamper | DS-PR1-WE |
| Relay / output module | `onoff` | DS-PM1-O1L, DS-PM1-O1H |

Every detector also exposes **temperature**, **battery** and **tamper** where the panel provides them.

## Understanding your sensors (important!)

Different detector types behave very differently in Homey — and this is **by design in the AX PRO panel, not a bug in the app**. If a motion detector looks "dead" while your alarm is off, this section explains why.

### 🚶 Motion detectors (PIR) only report **when the area is armed**

A wireless PIR **sleeps while its area is disarmed** and wakes up only when you arm the system. So when the alarm is off, the detector shows no motion in Homey even if you walk right in front of it. This is **intentional**: a battery-powered wireless PIR that transmitted on every movement, 24/7, would drain its battery in weeks instead of lasting ~5 years. Hikvision (like every wireless alarm brand) puts PIRs to sleep when they aren't needed.

**What this means for Flows:** a PIR is only a usable motion trigger *while the alarm is armed*. You cannot use an AX PRO PIR as a silent "someone is moving" trigger for home automation while the system is disarmed — it simply isn't awake to tell Homey anything.

> **"But can't I make it always-on?"** Technically yes — by changing the zone to a **24-hour zone type** in the panel. **Don't**, unless you really mean it: a 24-hour zone *sounds the siren every time it triggers, even when disarmed*. That's meant for panic/fire/tamper, not for quiet automation. There is **no** mode where an AX PRO PIR reports motion silently while disarmed. If you want "motion in the garage → do something in Homey" with the alarm **off**, use an always-on source instead — e.g. a camera with people/vehicle analytics, or a mains-powered motion sensor on another Homey app.

### 🚪 Door/window contacts report **all the time**

A magnetic contact is a passive reed switch that draws almost no power, so it **never sleeps**. Open/closed state is live in Homey 24/7, armed or disarmed. These make excellent everyday automation triggers (e.g. *garage door opens → turn on the light*) regardless of the alarm's arm state.

### 🔥🆘 Fire, panic and tamper are **24-hour by nature**

Smoke detectors, panic buttons and tamper switches are always active — they protect you whether the system is armed or not, and will report/alarm at any time.

**Rule of thumb:**

| Sensor | Reports when disarmed? | Good for silent automation? |
|--------|:----------------------:|:---------------------------:|
| Motion / PIR | ❌ sleeps until armed | Only while armed |
| Door/window contact | ✅ always | ✅ yes, 24/7 |
| Smoke / fire | ✅ always (24 h) | — (safety) |
| Panic / tamper | ✅ always (24 h) | — (safety) |

## Requirements

- **Homey Pro** (Early 2023 or later, firmware ≥ 5.0).
- A Hikvision **AX PRO** panel reachable on the same LAN as your Homey.
- A **web-login account on the panel** (the same username/password you use for the panel's web page). Note: when the panel is managed via Hik-Partner PRO, use a local account that can reach the panel's ISAPI.

## Installation

While the app is in testing it is installed with the Homey CLI:

```bash
npm install -g homey
git clone https://github.com/Frimurare/homey-hikvision-axpro
cd homey-hikvision-axpro
homey login
homey app install
```

An App Store release will follow once testing is complete.

## Adding your alarm

1. In Homey: **Add device → Hikvision AX PRO**.
2. Enter the panel's **IP address** and your **username / password**.
3. Pick the panel + detectors + peripherals you want to add, and choose a room for each.

Newly enrolled detectors (e.g. a new garage sensor) appear the next time you run **Add device** — no need to remove anything.

## How it works

The app authenticates to the panel using Hikvision's session login (`sessionIDVersion` 2.1, salted-SHA256 challenge) and polls `/ISAPI/SecurityCP/status/*` for zone, area and peripheral state, mapping each to the matching Homey capability. Arm/disarm and output control use the panel's control endpoints. One poller per panel is shared by all its devices.

## License

**GPL-3.0-or-later** © Ulf Holmström. This app is free software: you may use, study, share and modify it, but any distributed derivative must remain open under the same license. See [LICENSE](LICENSE).

---

<p align="center"><i>Hikvision and AX PRO are trademarks of their respective owners. This is an independent, unofficial integration.</i></p>
