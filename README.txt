Hikvision AX PRO — local alarm integration for Homey Pro

Bring your Hikvision AX PRO wireless alarm system into Homey. This app talks
directly to the alarm panel over your local network (no cloud account, no
separate bridge) and turns your panel, detectors and peripherals into real
Homey devices you can see, automate and control.

WHAT IT DOES
- Connect once with the panel's IP address and login; the app finds your panel
  and every enrolled detector and peripheral, ready to add.
- Arm (Away), Arm Stay (partial) and Disarm the alarm straight from Homey, with
  the live armed state available in Flows.
- Every detector becomes a device with the right sensor type and its own icon:
  motion, door/contact, smoke, glass break, water leak, CO, gas, heat and panic.
- Detectors also report temperature, battery level and tamper where available —
  so your alarm's temperatures show up in Homey's Climate view automatically.
- Peripherals are supported too: keypads, external sirens, repeaters, card
  readers and relay/output modules (on/off).
- New detectors you enroll later (for example a new garage sensor) simply appear
  the next time you add a device.

HOW IT WORKS
Everything runs locally on your Homey and communicates directly with the panel.
Your credentials stay on the Homey; there is no cloud dependency.

SUPPORTED HARDWARE
Hikvision AX PRO control panels (DS-PWA96-M-WE / M2-WE / M2H-WE, DS-PWA64-L-WE)
and their wireless detectors and peripherals. Detectors are matched by the type
the panel reports, so the whole AX PRO range is covered.

GETTING STARTED
Add device -> Hikvision AX PRO -> enter the panel's IP address and the username
and password you use for the panel's web page -> select the devices to add.

Note: when the panel is managed via Hik-Partner PRO, use a local account that can
reach the panel's ISAPI interface.

SOURCE, ISSUES & CONTRIBUTIONS
Open source (GPL-3.0). Code, documentation and issue tracker:
https://github.com/Frimurare/homey-hikvision-axpro

Built with love by Ulf Holmström.

Hikvision and AX PRO are trademarks of their respective owners. This is an
independent, unofficial integration and is not affiliated with or endorsed by
Hikvision.
