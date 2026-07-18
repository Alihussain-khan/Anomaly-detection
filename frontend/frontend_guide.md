# Frontend Build Guide

## Context

This is the frontend for a personal aquarium water quality monitoring project. The backend already exists and is verified working, a FastAPI service exposing a WebSocket route that replays real sensor readings and streams detection results. This guide covers frontend only, connecting to that existing backend, not building or changing it.

Stack is Angular, with Angular Material available for structural chrome. Do not reach for ngx-charts for the main visualization, that decision has changed. The live chart needs bespoke animation, a glowing drifting line and precise ripple effects at anomaly points, which a charting library is not built for. Build the chart as a custom SVG component instead. Angular Material still earns its place for ordinary interface elements, buttons, panels, toggles, in the control deck, just not for the chart itself.

## Backend contract

Connect to the backend WebSocket route. It accepts optional start_row and end_row query params, defaulting to a 1000 row demo window if not provided. Once connected, it streams one message per reading, roughly every 500 milliseconds, followed by a single completion message.

Reading message shape:

```json
{
  "type": "reading",
  "id": 12345,
  "device_id": "esp8266_C5CBC1",
  "water_temp": 25.5,
  "air_temp": 20.1,
  "ph": 5.97,
  "timestamp": "2019-05-23T19:10:38.396000Z",
  "anomalies": {
    "threshold": false,
    "trend": false,
    "spike": false,
    "isolation_forest": false
  }
}
```

Completion message shape:

```json
{
  "type": "done",
  "total_readings": 1000,
  "total_anomalies_flagged": 36
}
```

Treat any of the four anomaly flags being true as an anomaly for display purposes, a reading can trip more than one detector at once.

## Design tokens

**Color, deep tank at night**
- Background, Abyss, #0A1F26
- Panel surface, Tank Glass, #12303A
- Water temp line, Bioluminescent Teal, #2ED9C3
- Air temp line, Cold Silver, #8FA9AC
- Ph line, Deep Current Blue, #4A7FA7
- Anomaly accent, Warning Amber, #FF9F4A, the only warm color anywhere in the interface, used exclusively for anomaly indication, never for anything else, so its meaning stays unambiguous
- Text, Foam White, #E8F1F0

**Type**
- Display face for headings, Space Grotesk or General Sans, letter spaced slightly wide, used sparingly, only for section labels and the page title
- Numeric readings, JetBrains Mono or IBM Plex Mono, so digits stay aligned as values update live
- Supporting text, Inter or Manrope, kept small and quiet

**Motion**
- Chart lines ease gently between points rather than snapping, evoking light moving through water, not a stock ticker
- On an anomaly, a single amber ripple expands outward from that exact point on the chart and fades, quiet and precise, no bounce, no celebratory motion anywhere in the interface
- Respect reduced motion preferences, fall back to a simple instant color change on anomaly rather than the ripple animation when reduced motion is set

## Layout

```
AQUA WATCH                    connected indicator      control deck (collapsed)

  [ live chart, full width, three glowing lines ]

  25.4   water temp     20.1   air temp     5.97   ph        3 anomalies

  [ anomaly log, quiet entries, timestamped ]
```

## Chart component, the important part

Build this as a standalone Angular component rendering raw SVG, not wrapped around a charting library.

1. Show a scrolling window of the most recent 60 readings, not the full demo run. At a 500 millisecond tick that is the last 30 seconds of data. Older points scroll off the left edge as new ones arrive on the right. Plotting all 1000 points at once would be unreadable and would defeat the live feel entirely.
2. Each of the three metrics, water_temp, air_temp, ph, gets its own independent y axis scale, since their real ranges do not overlap, water temp sits near 25, air temp near 20, ph near 6. Do not force them onto a single shared scale.
3. Each line has a small glowing point riding its most recent value, using an SVG filter for the glow rather than a plain circle.
4. Critical rule for handling the negative 127 sensor fault value. If a reading falls outside a defined normal band for that metric, for water_temp roughly 15 to 30, clip the plotted point to the edge of that metric's axis rather than plotting the true value. A real negative 127 point would otherwise compress all 59 other points on screen into a flat line. The clipped point still triggers the ripple animation and gets logged as an anomaly, and the true raw value still appears in the numeric readout below the chart and in the anomaly log entry, only the line's plotted position is clipped, not the data shown elsewhere.
5. The ripple originates from the clipped or true position on the relevant line, at the moment that reading arrives, and fades over roughly one second.

## Other components

**Numeric readout row.** The three most recent values, in the monospace face, updating as each reading arrives. Show the true raw value here always, even during a clipped chart moment, so a negative 127 reading is genuinely visible as a number, not hidden by the chart's clipping.

**Anomaly log.** A running list of every reading that tripped at least one detector, newest at top, each entry showing timestamp, which metric, the raw value, and which detector or detectors flagged it. Entries fade in quietly, no icons, no exclamation marks, the amber accent color alone carries the alarm.

**Connection status indicator.** A small quiet dot near the page title, teal while connected and streaming, foam white or muted gray before connecting, amber only if the connection actually drops or errors.

**Control deck.** Collapsed by default in the corner, expands to reveal start row, end row, and a start button for the replay. Use Angular Material for these controls, themed to match the dark palette rather than left at Material's default look. Keep this out of the way of the chart until someone actually opens it.

**Idle state before connecting.** Something quieter than an empty gray box, a simple prompt inviting the person to open the control deck and start a replay, in keeping with the interface's own voice, plain and direct rather than apologetic.

## Out of scope for this phase

1. No backend changes of any kind
2. No new detection logic, the frontend only displays what the backend already sends
3. No ngx-charts, the custom SVG component replaces it for this visualization
4. No changes to the WebSocket message shape

## How to confirm this phase is working

1. Open the control deck, start a replay with the default window, confirm the chart begins updating roughly every 500 milliseconds
2. Confirm all three lines plot on their own independent scales and stay legible together
3. Let a real fault reading arrive and confirm the chart clips it rather than compressing everything else, while the numeric readout still shows the true raw value
4. Confirm a ripple appears at the moment of a flagged anomaly and fades within about a second
5. Confirm the anomaly log accumulates entries and does not lose earlier ones as new ones arrive
6. Toggle reduced motion in your operating system and confirm the ripple is replaced with a simple color change rather than the animation
7. Resize the browser down to a phone width and confirm the layout still holds together
