# Vessel search and typed commands

These captures use synthetic AIS positions and a local Realtime transport fixture.
They do not show live ship positions or an OpenAI response. Map imagery is OpenStreetMap.

The AIS fixture supplied 12,007 ships. PEREGRINO C and SKANDI PEREGRINO were outside
its ordinary 12,000-row window. The seeded SKANDI pin still appeared in snapshots.
Searching `PEREGRINO` returned both candidates. Choosing PEREGRINO C enabled the
vessel layer and framed that ship. Searching IMO `9447627` selected SKANDI PEREGRINO
and showed its stale position. Pin and Unpin changed the server watchlist.

Restarting the server with the fixture feed stopped preserved SKANDI's saved
position and timestamp. No new position was invented. Automated HTTP tests also
cover seven-day expiry, unknown pins and static messages not refreshing position age.

The typed `Hide the HUD` turn used the existing Realtime data-channel commands.
The fixture returned a `set_hud` tool call and a reply. The actual tool hid the HUD,
and the dock displayed the reply. Instrumented `getUserMedia` calls remained zero;
the peer connection requested receive-only audio. No live OpenAI call was made.

## Captures

- [Ambiguous whole-cache lookup, desktop](lookup-desktop.png)
- [Selected stale vessel, desktop](selected-stale-desktop.png)
- [Typed tool result and reply, desktop](text-desktop.png)
- [Watchlist, 390px mobile viewport](watchlist-mobile.png)
- [Typed reply, 390px mobile viewport](text-mobile.png)
