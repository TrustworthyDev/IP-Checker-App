# IPCheck

Desktop app (Electron) for checking whether proxies — proxy-seller or any other vendor — carry a
"good" IP according to [iphub.info](https://iphub.info).

For each proxy it connects **through** the proxy to discover the exit IP, measures latency, and then
scores that IP on iphub. Checking the exit IP rather than the endpoint you dial matters for
backconnect/rotating pools, where the address that reaches the target site is not the one in your list.

## Verdicts

iphub returns a `block` code, which the app colour-codes:

| Block | Meaning (per iphub's API docs) | Verdict |
|-------|-------------------------------|---------|
| `0` | Residential or business IP address (i.e. safe) | **Good** |
| `2` | Suspicious IP address, lower confidence (may flag innocent users) | **Risky** |
| `1` | Non-residential IP address (hosting provider, proxy, etc.) | **Blocked** |

iphub recommend deciding on `block == 1` only, since code `2` trades precision for recall — which is
why the app treats `2` as a warning rather than a hard fail.

Requests send `Accept-Version: 2.2`, so where the plan supports it results also carry `blockReason`
(shown in the Block badge tooltip) and `proxyType` flags — `proxy`, `tor`, `hosting`, `relay`,
`cloudGaming`, and `residentialProxy` (Professional plan) — shown as tags next to the badge.

## An iphub API key is required

iphub.info is a client-rendered site and its old public `/ip/<address>` page now returns **410 Gone**,
so there is no block status in the served HTML to read. The block score can only come from the
documented API, which needs an `X-Key` header.

To get a key:

1. Register at <https://iphub.info/register> and confirm your email.
2. Go to <https://iphub.info/pricing> and subscribe to the **Basic** tier's **free plan**
   (1000 requests/day). iphub state on that page: *"We also have a free plan (1000 req/day) for the
   Basic tier."* A plan subscription is required — the API docs open with *"The first step is to
   subscribe to a plan."*
3. Copy the key from your account page at <https://iphub.info/account>.
4. Paste it into **Settings → iphub.info API key** in the app and press **Save settings**.

Verify it from a terminal if you want to check the key independently:

```bash
curl https://v2.api.iphub.info/ip/8.8.8.8 -H "X-Key: YOUR_KEY"
```

`8.8.8.8` should come back with `"block": 1`. A `403` means the key is wrong or has no active plan;
a `429` means the daily quota is spent.

Without a key the app still tests every proxy for reachability, exit IP, and latency; it just cannot
score them, and says so rather than reporting a misleading result.

## Plan tiers change the answer

Residential-proxy detection is a **Professional plan** feature. iphub state it on their home page:

> The basic tier of IPHub is free to use providing a maximum of 1000 queries per day. For higher
> usage **or residential proxy detection**, commercial plans are available.

This matters if you are checking *residential* proxies (Decodo/Smartproxy, Bright Data, and similar).
On a free Basic key those exits typically come back `block: 0` — "safe" — because the tier that
identifies them as residential proxies is the paid one. The same IP looked up on iphub's website
shows `block: 1` with a `Residential proxy` `PRO` badge, since the site displays Professional-grade
results to everyone.

So a wall of green on a residential pool is a statement about the Basic tier, not proof of quality.
Datacenter IPs, Tor exits and commercial VPNs *are* caught on Basic.

To check an individual exit at Professional level, expand its row and press **View on iphub.info**.
That opens `https://iphub.info/?ip=<exit-ip>` in a browser panel docked inside the app
(`WebContentsView`), with back / reload / open-in-browser / close controls.

The panel is a **viewer, not a scraper**. The main process never reads the loaded page's DOM and
nothing is extracted back into the results table — you read it, one IP at a time. Navigation is
pinned to `iphub.info`; any other host is handed to your system browser. Remote content runs
sandboxed with no preload and no node integration.

Note that iphub gates the home-page lookup behind a **human verification** challenge, so you may
have to complete it before the result appears (the panel keeps cookies, so it isn't every time).
That is also why the app makes no attempt to automate this route: the site expects a person, and
bulk-driving it would mean defeating that check as well as working around the plan that sells this
data. For automatic residential detection across a whole list, use a Professional key — the app
already sends `Accept-Version: 2.2`, so `blockReason` and `proxyType.residentialProxy` populate with
no code change.

## Setup

```bash
npm install
npm start
```

Build a Windows installer + portable exe into `release/`:

```bash
npm run dist
```

## Supported list formats

Paste or import a list; one proxy per line. Blank lines and `#` / `//` comments are ignored, and
duplicates are dropped automatically.

```
1.2.3.4:8080
1.2.3.4:8080:user:pass
user:pass@1.2.3.4:8080
socks5://user:pass@1.2.3.4:1080
1.2.3.4;8080;user;pass
1.2.3.4  8080  user  pass
res.proxy-seller.com:10000:user:pass
```

Lines without a `scheme://` prefix use the **Default protocol** dropdown (HTTP, SOCKS5, or SOCKS4).
Passwords containing `@` or `:` are handled — the parser only treats `@` as a credential separator
when what follows it is a real `host:port`.

## Features

- Streaming results — rows appear as each proxy finishes, with a live progress bar
- **Click any row** to expand a detail panel that breaks the proxy into its parts — protocol, host,
  port, username, password, the full connection URL, and the original line — each with its own copy
  button, alongside the complete iphub result. Open rows stay open while filtering and searching.
- Configurable concurrency (1–50) and per-request timeout
- Exit-IP lookups are memoised per run, so a backconnect pool sharing one exit costs one API call
- `rotating` tag when the exit IP differs from the endpoint you dialled
- Filter by verdict, search by IP / country / ISP
- Copy all good proxies to the clipboard, or export the full run to CSV
- "Check my IP" for an unproxied baseline
- Settings and last list persist in Electron's `userData` directory
- Ctrl+Enter starts a run

## Project layout

```
src/main/
  main.js          Electron entry, window, IPC handlers
  preload.js       contextBridge surface (context isolation on, node integration off)
  checker.js       exit-IP resolution, iphub API client, worker pool
  proxy-parser.js  list parsing for all supported formats
  store.js         JSON settings in userData
src/renderer/
  index.html       UI markup (CSP: no external resources)
  styles.css       dark theme
  renderer.js      rendering, filtering, export
```

## Notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`; all network access
  happens in the main process, so there are no CORS restrictions and the API key never reaches the page.
- All through-proxy requests use HTTPS endpoints, so traffic is tunnelled with `CONNECT`. That keeps
  one code path working for HTTP and SOCKS proxies and stops a transparent proxy from rewriting the
  response.
- `proxy: false` is set on every request so a system/environment proxy can't silently answer for a
  dead proxy and produce a false "alive" result.
- Your API key is stored in plain JSON under the app's `userData` folder (**Help → Open settings
  folder**). Treat it like any other local credential.
