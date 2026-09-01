# Chrome Web Store Listing — Deep Grab

> Last Updated: 2026-09-01

## Store Listing

**Extension Name**
Deep Grab

**Short Description** (≤132 chars — matches manifest.json)
Find the best video on the current page and send its download link to the Deep Video Downloader app running on your computer. (125 chars)

**Detailed Description**

Deep Grab finds the highest-quality video playing on the page you are viewing, then sends its download address to the Deep Video Downloader desktop app installed on your computer, so the file can be saved locally.

How it works
Deep Grab scans the current page for the video or stream being played, picks the best available quality (full-length stream over a short preview clip), and hands the download link to the Deep Video Downloader desktop app on your machine. The desktop app downloads and saves the file for you. Nothing is uploaded or shared over the internet; media addresses are sent only to the companion app running locally on your computer.

Getting started
1. Install Deep Video Downloader on your Windows computer.
2. Open a page that plays a video.
3. Deep Grab detects the video automatically and shows it in the small panel. If automatic sending is turned on, the download starts right away; otherwise click "Send" to hand the link to the desktop app.
4. The desktop app downloads the file to a folder you choose.

Privacy
Deep Grab only ever sends a detected media address (and the page it came from) to the Deep Video Downloader app running on the same computer, over a local connection (127.0.0.1). It does not collect, store, or transmit any personal data, and it does not contact any remote servers.

**Category**
Productivity

**Single Purpose**
Detects and sends download links for videos on the current page to the Deep Video Downloader desktop app running locally on the same computer.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `extension/icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
- **Screenshot 1**: A video page with the Deep Grab floating toolbar shown, one best source highlighted, describing it as the full-length stream.
- **Screenshot 2**: The Deep Video Downloader desktop app showing the enqueued download progressing.
- **Screenshot 3**: The Deep Grab panel after clicking "Send" showing the source handed off to the desktop app.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | Saves your per-extension choices (which video kinds to show, best-quality-only, auto-send on/off) and the list of already-captured/downloaded videos so the same video is not sent twice. Settings stay in the browser's local storage on your device. |
| tabs | permissions | Reads the address and title of the current tab so Deep Grab can attach the page it came from to each detected video and auto-close the source tab after the video is handed off (a user-configurable convenience). |
| tabGroups | permissions | Groups the tabs that Deep Grab automatically opens (for sites that play the video in a separate player tab) into one collapsible group so they don't clutter your tab bar. |
| webRequest | permissions | Detects media requests (the actual .mp4/.m3u8 stream addresses many players request behind the scenes) so videos that never show a visible `<video>` element can still be captured. Only the URL and the response size header are read; request bodies are never inspected. |
| http://127.0.0.1/*, https://127.0.0.1/*, http://localhost/*, https://localhost/* | host_permissions | The companion desktop app runs its local capture server on 127.0.0.1:8765. Deep Grab connects to this loopback address only — never to a remote server — to send detected media addresses. |
| `*://*/*` | host_permissions | Deep Grab must be able to detect videos on any page the user opens, because users browse video content across many sites and one of the supported page types is a general "any video page". The extension only inspects media-detection URLs and never uploads page content. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes (limited, on-device only)

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | — | — | No |
| Health info | No | — | — | No |
| Financial info | No | — | — | No |
| Authentication info | No | — | — | No |
| Personal communications | No | — | — | No |
| Location | No | — | — | No |
| Web history | No | — | — | No |
| User activity | No | — | — | No |
| Website content | Yes (the detected media URL + page title of the current tab) | No — sent only over localhost (127.0.0.1) to the companion desktop app on the same machine | Needed to tell the desktop app which video to download | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
<!-- MUST be set before submitting. Recommended: host `docs/PRIVACY.md` on GitHub Pages,
     or a public GitHub Gist, then put the live URL here. -->

`https://<YOUR-HOSTED-URL>/privacy`

## Distribution

**Visibility**: Public
**Regions**: All regions (recommended unless you need to restrict)

## Developer Info

**Publisher Name** [REQUIRED]
<!-- Fill in -->

**Contact Email** [REQUIRED]
<!-- Fill in — displayed publicly on the listing -->

**Support URL / Email** [RECOMMENDED]
`https://github.com/i12playwow/DeepVideoDownloader/issues`

**Homepage URL** [RECOMMENDED]
`https://github.com/i12playwow/DeepVideoDownloader`

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.2 | 2026-09-01 | Initial store release: media detection, best-quality selection, auto/mannual send to local desktop app, Cloudflare challenge auto-solve for supported sites | Draft |

## Review Notes

### Known Issues / Limitations
- The broad `*://*/*` host scope exists because the extension must detect videos on any page the user visits, and the companion app's loopback address is explicitly allowed. This broad scope is the most likely point of review pushback; be ready to shorten it if the reviewer requires a fixed site list.
- The auto-solve of Cloudflare "verify you are human" challenges on supported streaming sites may be questioned by review. If rejected on this basis, the fastest path is to narrow the extension to a fixed list of supported domains and document them.
- A privacy policy URL must be live before submission; the extension uses `webRequest`, which makes a privacy policy mandatory.

### Rejection History
| Date | Reason | Fix Applied | Resubmitted |
|------|--------|-------------|-------------|
