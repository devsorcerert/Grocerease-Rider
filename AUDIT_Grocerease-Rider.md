# AUDIT — Grocerease-Rider

**Audited:** 2026-06-28  
**Repo:** `devsorcerert/grocerease-rider`  
**Branch audited:** `claude/repo-security-audit-3ox401`  
**Auditor:** Senior Architect (automated, read-only — no code changes)

---

## 1 · Repository Structure

```
Grocerease-Rider/
├── .github/workflows/build-apk.yml    CI/CD — Android APK build & release
├── assets/                            App icons and splash images
├── App.js                             Entire application logic (703 lines)
├── app.json                           Expo / EAS configuration
├── index.js                           Expo root registration
├── package.json                       NPM manifest
└── package-lock.json                  Dependency lock file
```

**No `CONTRACTS.md` exists.** Every API field name, enum value, and response shape referenced in this report is inferred from `App.js` usage. The absence of a contract document is itself a critical finding (§6.1).

---

## 2 · File-by-File Inventory

### 2.1 `index.js` — Entry point
- **Status:** COMPLETE  
- **Purpose:** Calls `registerRootComponent(App)` from Expo.  
- **Issues:** None.

### 2.2 `app.json` — Expo config
- **Status:** COMPLETE  
- **Bundle IDs:** `com.grocereasetv.rider` (iOS + Android)  
- **Permissions declared:** `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` — both appropriate.  
- **Plugin config:** `expo-location` with `isAndroidBackgroundLocationEnabled: true` — correct for background tracking.  
- **Issues:** None at the config layer.

### 2.3 `package.json` — Dependencies
- **Status:** COMPLETE  
- **Key runtime deps:**
  - `expo ~54.0.35`, `react 19.1.0`, `react-native 0.81.5`
  - `expo-location ~19.0.8`, `expo-notifications ~0.32.17`
  - `expo-secure-store ~15.0.8`, `expo-task-manager ~14.0.9`
- All imported packages in `App.js` are present here. No unused dependency detected.  
- **Issues:** None.

### 2.4 `.github/workflows/build-apk.yml` — CI/CD pipeline
- **Status:** FUNCTIONAL but with **CRITICAL security defects** (§5.1, §5.2).  
- **Purpose:** On push to `main` or manual trigger: prebuild, assemble release APK, upload artifact, create GitHub Release.  
- **Flow:** checkout → JDK 17 → Node 22 → `npm install` → `expo prebuild` → keystore setup → Gradle build → bundle verification → artifact upload → GitHub Release.

### 2.5 `App.js` — Application logic (703 lines)
- **Status:** FUNCTIONAL but with multiple security, reliability, and completeness issues (§5).  
- **Purpose:** Single-file React Native Expo app implementing login, registration, rider dashboard, background GPS, order management, earnings view, and push notifications.  
- **Dead code / stubs:** None — every declared function is called.  
- **Duplicates:** None.

---

## 3 · Data Flow Map

```
┌──────────────────────────────────────────────────────────────────┐
│  App.js (React Native / Expo)                                    │
│                                                                  │
│  handleLogin() ──POST /api/rider/login──────────────────────────►│
│  handleRegister() ──POST /api/rider/register────────────────────►│
│                                                                  │  Backend
│  TaskManager BG task (every 5 s) ──POST /api/rider/location────►│  (Render PaaS)
│  locationRetryQueue flush (every 60 s) ──same endpoint─────────►│
│                                                                  │     │
│  fetchCurrentOrder() ──GET /api/rider/current-order────────────►│     ▼
│  fetchOrderQueue() ──GET /api/rider/order-queue────────────────►│  MongoDB
│  updateStatus(s) ──POST /api/rider/order-status────────────────►│     │
│  toggleAvailability() ──POST /api/rider/availability───────────►│     │
│  fetchEarnings() ──GET /api/rider/earnings─────────────────────►│     │
│  push-token reg ──POST /api/rider/push-token───────────────────►│     │
│                                                                  │     │
│  Expo Push Notifications ◄───────────────────────────────────────│     │
│    → fires fetchCurrentOrder + fetchOrderQueue                   │     │
└──────────────────────────────────────────────────────────────────┘
```

**Auth:** JWT Bearer token stored in `expo-secure-store` under `rider_token`. Passed as `Authorization: Bearer <token>` on every authenticated request. 401 responses clear the token and redirect to login.

**Payments:** No payment integration exists in this app. The rider app only displays `order.subtotal`; Razorpay or any other payment flow must live in the customer/admin app.

**Assignment:** Backend-push model — backend sends an Expo push notification containing `{ order_id, type: 'order' }`; the app reacts by polling `current-order` and `order-queue`.

**Tracking:** Background GPS task posts `{ lat, lng }` every 5 seconds. Field names match the shape `current_location { lat, lng }` inferred from CONTRACTS.md intent, but `updated_at` is not sent — the backend must timestamp on receipt.

---

## 4 · CONTRACTS.md Seam Analysis

> **CONTRACTS.md does not exist.** The following is derived solely from field access in `App.js`.

### 4.1 Location shape (App.js:40, 64)
App sends: `{ lat: number, lng: number }` — no `updated_at` field.  
Expected contract shape: `current_location { lat, lng, updated_at }`.  
**Mismatch:** `updated_at` is absent from the payload; backend must inject it, or the contract is violated at the source.

### 4.2 Order status enum (App.js:541-544, 399)
Values used by the app:
```
'reached_store' | 'picked_up' | 'out_for_delivery' | 'delivered'
```
These are never validated against an enum — raw strings passed to the API. If the backend enum has different casing or values, status updates will silently fail or be ignored.

### 4.3 JWT claims (App.js:155-161)
The token is stored and replayed but **never decoded**. Claims expected (inferred):
- `sub` — rider ID
- `exp` — expiration
- `iat` — issued-at

No client-side expiration check exists. If the backend issues short-lived tokens, the app will silently fail API calls until a 401 forces re-login.

### 4.4 Assignment fields used in UI

| Field | App.js reference | Type assumed | Validated? |
|---|---|---|---|
| `current_order.id` | :528, :389 | `string` (UUID) | No |
| `current_order.delivery_address` | :530, :534 | `string` | No |
| `current_order.delivery_status` | :532, :399 | enum string | No |
| `current_order.subtotal` | :531 | `number` | No |
| `order_queue[].id` | :557 | `string` | No |
| `order_queue[].delivery_address` | :559, :560 | `string` | No |
| `rider.name` | :496 | `string` | No |
| `rider.status` | :161 | `'offline'` checked | Only `!== 'offline'` |

### 4.5 Earnings fields (App.js:582-615)

| Field | App.js reference | Risk |
|---|---|---|
| `earnings.today` | :582 | `.toFixed(0)` crashes if not a number |
| `earnings.this_week` | :586 | same |
| `earnings.this_month` | :590 | same |
| `earnings.all_time` | :594 | same |
| `earnings.total_deliveries` | :597 | no null check |
| `earnings.recent_deliveries[].order_id` | :605 | optional-chained, ok |
| `earnings.recent_deliveries[].address` | :606 | no fallback — renders `undefined` |
| `earnings.recent_deliveries[].delivered_at` | :607 | conditionally checked, ok |
| `earnings.recent_deliveries[].amount` | :615 | `.toFixed(0)` crashes if not a number |

---

## 5 · Findings with File:Line References

### 5.1 🔴 CRITICAL — Hardcoded keystore credentials in workflow

**File:** `.github/workflows/build-apk.yml:44-47, 53-54`

```yaml
# :44-47
echo "MYAPP_UPLOAD_STORE_PASSWORD=android" >> android/gradle.properties
echo "MYAPP_UPLOAD_KEY_PASSWORD=android"   >> android/gradle.properties
# :53-54
-storepass android -keypass android
```

A **debug** keystore with the universally known password `android` is generated and used to sign the **release** APK distributed to users. Anyone can re-sign any binary with this key. Google Play / sideload users cannot distinguish your APK from a malicious replacement.

**Fix:** Store a real production keystore in GitHub Secrets (`KEYSTORE_BASE64`, `KEY_STORE_PASS`, `KEY_ALIAS`, `KEY_PASS`) and decode at build time. Never commit or generate keystore material with known passwords.

---

### 5.2 🔴 CRITICAL — Hardcoded backend URL in source (dead-domain fallback)

**File:** `App.js:19-25`

```js
const RENDER_FALLBACK = 'https://grocerease-backend-0uip.onrender.com';  // :19
const _configured = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL;
if (_configured === 'https://api.grocereasetv.com') {          // :21 — dead domain
  console.warn('EXPO_PUBLIC_API_BASE_URL points to dead domain...');
}
const BASE_URL = (_configured && _configured !== 'https://api.grocereasetv.com')
  ? _configured : RENDER_FALLBACK;                             // :24-25
```

- The Render URL and former production domain are both baked into the binary.  
- `console.warn` at :22 will appear in production logcat/Xcode logs.  
- Render free-tier URLs can be harvested for backend reconnaissance.  
- The dead domain `api.grocereasetv.com` suggests a prior production URL still hard-wired.

**Fix:** Set `EXPO_PUBLIC_API_BASE_URL` via EAS secrets; remove the fallback constant from source; fail the build if the env var is unset.

---

### 5.3 🔴 CRITICAL — Location retry queue race condition

**File:** `App.js:29-46`

```js
let locationRetryQueue = [];                 // :29 — module-level, mutable

async function flushLocationQueue(token) {
  const pending = [...locationRetryQueue];   // :33
  locationRetryQueue = [];                   // :34 — cleared before awaits
  for (const item of pending) {
    try {
      const res = await fetch(...);          // :37 — async yield
      if (!res.ok) locationRetryQueue.push(item);  // :42
    } catch {
      locationRetryQueue.push(item);         // :44
    }
  }
}
```

`locationRetryQueue` is a plain module-level array. Both the background task (**App.js:66-71**) and the 60-second flush interval (**App.js:227**) read and write it concurrently. The flush function clears the array at :34, then the background task may push a new item at :66 before the flush loop re-adds failed items at :42/44 — resulting in those items being clobbered. In a long outage the queue also grows unbounded (no cap).

**Fix:** Use a locking flag (`flushing = true/false`) around the flush loop; add `MAX_QUEUE = 200` guard.

---

### 5.4 🔴 CRITICAL — No JWT expiration or format validation

**File:** `App.js:320-327`

```js
if (!data.token) { Alert.alert(...); return; }
setToken(data.token);
setRider(data);
setIsOnline(true);
await SecureStore.setItemAsync('rider_token', data.token);
await SecureStore.setItemAsync('rider_session', JSON.stringify(data));
```

The token is stored and used after only a truthiness check. No check that:
- the string is a valid JWT (three dot-separated base64 segments),
- `exp` is in the future,
- `sub` matches the returned rider ID.

Session restore at **App.js:157-161** is identical — a stored token is trusted unconditionally. If a token is stolen or a backend bug returns a bad value, the app silently accepts it.

**Fix:** Decode the JWT payload client-side (no signature verification needed); assert `exp > Date.now()/1000` before storing; re-validate on every session restore.

---

### 5.5 🟠 HIGH — No client-side rate limiting on auth endpoints

**File:** `App.js:290-331` (login), `App.js:334-361` (register)

Neither form imposes any delay, counter, or lockout after failed attempts. A bot can call `handleLogin` thousands of times per second. All protection must be on the backend, but this is not verifiable from the rider app alone.

**Fix (client-side):** Track failed attempt count in state; apply exponential backoff and disable the button for increasing durations (30 s, 2 min, 10 min).

---

### 5.6 🟠 HIGH — `handleRegister` uses raw `fetch` without timeout

**File:** `App.js:340`

```js
const resp = await fetch(`${BASE_URL}/api/rider/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ... }),
});
```

Every other request goes through `apiFetch` which wraps an `AbortController` and 30-second timeout (**App.js:78-81**). Registration bypasses this — the app can hang indefinitely on a slow/down server.

**Fix:** Replace the raw `fetch` call with `api(...)`.

---

### 5.7 🟠 HIGH — Order status update race condition / optimistic state inconsistency

**File:** `App.js:393-397`

```js
if (status === 'delivered') {
  setRider({ ...rider, current_order: null });   // :394 — optimistic
  Alert.alert('Order Delivered! 🎉', 'Great job!');
  setTimeout(() => { fetchCurrentOrder(); fetchOrderQueue(); }, 1000);  // :397
}
```

- State is spread from the stale closure `rider`, not the functional updater form. A rapid double-tap enqueues two API calls and two `setRider` calls, potentially restoring a cleared order.  
- The 1000 ms `setTimeout` is arbitrary; if the backend is slow, `fetchCurrentOrder` runs before the order is marked delivered and re-populates `current_order`.  
- The `loading` guard (`setLoading(true)` at :385) does not disable the buttons — `ActivityIndicator` is shown instead, but the buttons remain tappable in the time before re-render.

**Fix:** Disable buttons via `loading` state; use `setRider(prev => ...)` functional form; remove `setTimeout` and rely on the backend's push notification to signal queue changes.

---

### 5.8 🟠 HIGH — Availability toggle: no loading guard, optimistic without revert

**File:** `App.js:364-379`

```js
const toggleAvailability = async () => {
  if (!token) return;
  const newAvailable = !isOnline;
  try {
    const resp = await api(...);
    if (resp?.ok) setIsOnline(newAvailable);  // optimistic, only on success
  } catch (e) { Alert.alert('Network error', e.message); }
};
```

No loading state prevents the toggle from being tapped again while the request is in flight. Two taps can produce two simultaneous requests that arrive out of order, leaving the server state opposite to the UI.

**Fix:** `const [availLoading, setAvailLoading] = useState(false)` — set true before request, false in finally; return early if already loading.

---

### 5.9 🟡 MEDIUM — `diagText` diagnostic block visible in production

**File:** `App.js:484-487`

```js
{/* DIAG */}
<Text style={s.diagText}>API: {BASE_URL}</Text>
<Text style={s.diagText}>health: {healthStatus}</Text>
```

The full `BASE_URL` (including the Render subdomain) and live health-check output are rendered on the login screen in production builds. Any user can read the backend URL without any tools.

**Fix:** Wrap in `if (__DEV__)` or remove entirely; health check is useful only during development.

---

### 5.10 🟡 MEDIUM — All API URLs logged to console in production

**File:** `App.js:79`

```js
console.log('[apiFetch] →', url);
```

Logged on every API request. In release Android builds this appears in `adb logcat`. Any physical access to the device or a USB-connected attacker can extract all endpoint paths.

**Fix:** Guard with `if (__DEV__) console.log(...)` or use a conditional logger.

---

### 5.11 🟡 MEDIUM — Raw HTTP response text shown to user on login errors

**File:** `App.js:315-318`

```js
Alert.alert(`Login HTTP ${response.status}`,
  `URL: ${loginUrl}\n\n${rawText.slice(0, 400)}${parseError ? `\nParse: ${parseError}` : ''}`);
```

Up to 400 characters of raw server response (stack traces, internal paths, SQL errors if backend misconfigured) is shown in an `Alert`. This is poor UX and an information-disclosure risk.

**Fix:** Show a generic user-facing message; log the raw text only with `if (__DEV__)`.

---

### 5.12 🟡 MEDIUM — No phone/password format validation

**File:** `App.js:291-292` (login), `App.js:335-336` (register)

```js
if (!phone.trim() || !password.trim()) {
  Alert.alert('Required', 'Enter phone and password'); return;
}
```

Only empty-string guards exist. No regex for `+91XXXXXXXXXX`, no minimum password length. Garbage data is sent to the backend; backend must validate, but the app provides no guidance.

**Fix:** Add `/^[6-9]\d{9}$/.test(phone.replace(/^\+91/, ''))` and `password.length >= 8`.

---

### 5.13 🟡 MEDIUM — Earnings fetch errors are silent (no user-facing alert)

**File:** `App.js:419`

```js
} catch (e) { console.warn('Earnings fetch failed:', e.message); }
```

If the earnings API fails, `earnings` stays `null`, the tab shows "Could not load earnings." with a Retry button — acceptable — but network errors are only in the console, not shown as alerts. The user has no feedback distinguishing "loading" from "failed".

---

### 5.14 🟡 MEDIUM — `earnings.recent_deliveries[].amount` crashes on missing/non-number

**File:** `App.js:615`

```js
<Text style={s.deliveryFee}>₹{d.amount.toFixed(0)}</Text>
```

If `d.amount` is `undefined` or `null`, `.toFixed` throws `TypeError` and the Earnings tab crashes. Same pattern at :582, :586, :590, :594 for the summary cards.

**Fix:** `(d.amount ?? 0).toFixed(0)` and `(earnings.today ?? 0).toFixed(0)`.

---

### 5.15 🟡 MEDIUM — Background GPS effect re-triggers on any `rider` object change

**File:** `App.js:260, 287`

```js
}, [rider, token]);
```

`rider` is a plain object; any state update that touches `rider` (e.g., `delivery_status` change at :399) causes `startTracking` to run again. `already` check at :268 prevents double-registration, but the cleanup at :282 first stops tracking before the new effect restarts it — causing a brief gap in location reporting.

**Fix:** Use `[rider?.id, token]` as the dependency array.

---

### 5.16 🟡 MEDIUM — `locationRetryQueue` grows unbounded during network outages

**File:** `App.js:42-44, 66-71`

No maximum size is enforced. During a multi-hour outage, the queue fills indefinitely with `{ lat, lng }` objects, consuming memory and causing catch-up storms when connectivity returns.

**Fix:** Add `if (locationRetryQueue.length < 200) locationRetryQueue.push(item)` at both push sites.

---

### 5.17 🟡 MEDIUM — Push token registration: no projectId supplied

**File:** `App.js:238`

```js
const pushTokenObj = await Notifications.getExpoPushTokenAsync();
```

Expo SDK 50+ requires `projectId` in `getExpoPushTokenAsync({ experienceId, projectId })`. Without it the call may return a token scoped to a development project, or fail silently on physical devices not linked to an Expo account.

**Fix:** `Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })`.

---

### 5.18 🟢 LOW — `stopLocationUpdatesAsync` not awaited in cleanup

**File:** `App.js:284`

```js
.then(started => { if (started) Location.stopLocationUpdatesAsync(LOCATION_TASK); })
```

`stopLocationUpdatesAsync` returns a Promise that is not awaited. Expo may log a warning about unhandled async during component unmount.

---

### 5.19 🟢 LOW — Registration error detail field not guarded

**File:** `App.js:350`

```js
Alert.alert('Registration failed', data.detail || 'Unknown error');
```

If backend returns `{ message: '...', error: '...' }` instead of `{ detail: '...' }`, the alert shows "Unknown error". Harmless but confusing.

**Fix:** `data?.detail || data?.message || data?.error || 'Unknown error'`.

---

### 5.20 🟢 LOW — Health-check effect at module init (leaks if component unmounts fast)

**File:** `App.js:172-182`

An async IIFE runs a `fetch` with no AbortController and no cleanup return. If the splashscreen dismisses before the fetch resolves, the stale `setHealthStatus` call updates unmounted state (suppressed in React 18 but still a code smell).

---

## 6 · What Is Missing

### 6.1 — `CONTRACTS.md` (Complete absence)
No shared API contract document. All field names, enums, and shapes are inferred from one client file. The backend and rider app can silently diverge.

### 6.2 — Production keystore / signing strategy
Release APKs are signed with a debug key. No production signing identity exists in the CI pipeline.

### 6.3 — Refresh token / token expiration handling
JWTs are stored and replayed until a 401 arrives. No proactive expiration check, no silent re-auth, no refresh endpoint consumed by the app.

### 6.4 — Runtime schema / response validation
No Zod, io-ts, or equivalent. All API responses are consumed with optional chaining and `|| []` defaults. A backend field rename is invisible to the client until a crash.

### 6.5 — Rider location: `updated_at` field not sent
Contract shape `current_location { lat, lng, updated_at }` — the app sends `{ lat, lng }` only. `updated_at` must be stamped by the backend; if the contract requires the client to send it, this is a seam mismatch.

### 6.6 — Order acceptance / rejection UI
The app receives orders via push and auto-displays the first assigned order. There is no "Accept" / "Decline" button — the rider cannot refuse an assignment.

### 6.7 — Customer contact / masked phone
No "Call Customer" button. `current_order` shape does not include `customer_phone` in any rendered UI. For Tirupati quick-commerce, riders need contact numbers.

### 6.8 — Earnings pull-to-refresh
The Earnings tab is fetched once and requires the "🔄 Refresh" button. No pull-to-refresh (`RefreshControl`) is implemented.

### 6.9 — Offline indicator / network status banner
No `@react-native-community/netinfo` or equivalent. Riders get no in-app indication that they have lost connectivity; they discover this only when an action fails.

### 6.10 — Error boundary
No React `ErrorBoundary` component wraps the dashboard. A crash in the Earnings tab (e.g., `d.amount.toFixed` on undefined) kills the entire app with a white screen.

### 6.11 — Client-side rate limiting / brute-force protection
No lockout counter, no `expo-application` device fingerprint challenge, no CAPTCHA on login or registration.

### 6.12 — Sentry / crash reporting
No crash analytics integration. Production failures are invisible.

### 6.13 — EAS / OTA update mechanism
No `expo-updates` configured. Bug fixes require a full APK rebuild and redistribution; no OTA patch path exists.

### 6.14 — Deep-link / universal link handling
Order notifications contain `order_id`; the app only reacts if already running. A killed-app tap on a notification calls `fetchCurrentOrder` but there is no explicit deep-link route configuration in `app.json`.

### 6.15 — Pickup address in order card
`current_order` renders delivery address and subtotal only. No pickup (store) address is shown — rider has to memorise or infer the store location.

---

## 7 · WHAT WORKS

- JWT Bearer auth flow end-to-end (login → secure store → replay on restart → 401 auto-logout)
- Background GPS location posting with offline retry queue (functionally correct, race condition notwithstanding)
- Foreground and background push-notification listeners wired to order refresh
- Order status progression buttons (`reached_store` → `picked_up` → `out_for_delivery` → `delivered`)
- Availability (online/offline) toggle
- Order queue display (upcoming orders panel)
- Earnings summary (today / week / month / all-time) + recent delivery history
- Session persistence across app restarts via `expo-secure-store`
- Google Maps deep-link from delivery address
- Registration form with vehicle selection and admin-approval flow
- GitHub Actions CI producing a signed (debug-key) APK artifact and GitHub Release
- 30-second request timeout via `AbortController` in `apiFetch`
- Graceful 401 handler that clears session and returns to login
- Android background location foreground service notification declared correctly

---

## 8 · WHAT EXISTS BUT IS BROKEN / INCOMPLETE

| # | File:Line | Issue |
|---|---|---|
| B1 | `build-apk.yml:44-54` | Debug keystore used for release APK; passwords `android` hardcoded |
| B2 | `App.js:19-25` | Backend URL hard-coded; dead domain reference; `console.warn` in production |
| B3 | `App.js:29-46` | Location retry queue race condition (concurrent BG task + flush) |
| B4 | `App.js:157-161` | Stored JWT accepted without `exp` check — silently expired sessions used |
| B5 | `App.js:238` | `getExpoPushTokenAsync()` missing `projectId` — likely fails on prod devices |
| B6 | `App.js:260,287` | Location effect depends on full `rider` object — restarts tracking on every status update |
| B7 | `App.js:291-292` | Login/register: only empty-string guard — no phone format or password-length check |
| B8 | `App.js:315-318` | Raw server response text shown in Alert on login error — information disclosure |
| B9 | `App.js:340` | `handleRegister` uses raw `fetch` with no timeout — can hang indefinitely |
| B10 | `App.js:364-379` | Availability toggle has no loading guard — rapid taps cause concurrent conflicting requests |
| B11 | `App.js:393-397` | Delivered status: optimistic clear + `setTimeout(1000)` + stale closure spread → state inconsistency on double-tap |
| B12 | `App.js:419` | Earnings fetch error silently swallowed — no user-facing feedback |
| B13 | `App.js:484-487` | `diagText` block renders `BASE_URL` + health status on login screen in production |
| B14 | `App.js:582,586,590,594,615` | `.toFixed(0)` on potentially-`undefined` earnings fields — crashes tab |
| B15 | `App.js:606` | `d.address` rendered with no fallback — shows `undefined` if field absent |
| B16 | `App.js:79,89` | All API URLs + errors logged to console with no `__DEV__` guard |
| B17 | `App.js:29` | `locationRetryQueue` has no size cap — unbounded growth during outages |
| B18 | `App.js:284` | `stopLocationUpdatesAsync` unresolved promise in useEffect cleanup |

---

## 9 · WHAT IS MISSING for a Tirupati Quick-Commerce Pilot

| # | Missing Capability | Priority |
|---|---|---|
| M1 | `CONTRACTS.md` — shared API schema, field names, status enum values | P0 |
| M2 | Production signing key managed via GitHub Secrets / EAS Credentials | P0 |
| M3 | JWT expiration check + proactive re-auth / refresh token endpoint | P0 |
| M4 | Client-side rate limiting / lockout on failed login attempts | P0 |
| M5 | `EXPO_PUBLIC_API_BASE_URL` required in CI; remove fallback URL from source | P0 |
| M6 | Location payload `updated_at` — clarify whether client or backend stamps it | P1 |
| M7 | Order accept / decline UI — rider cannot currently refuse an assignment | P1 |
| M8 | Pickup (store) address displayed on active order card | P1 |
| M9 | Customer contact display (masked phone or in-app calling) | P1 |
| M10 | Offline / network status banner (react-native-netinfo) | P1 |
| M11 | React `ErrorBoundary` wrapping the dashboard to prevent white-screen crashes | P1 |
| M12 | Runtime response validation (Zod) to catch backend schema drift early | P1 |
| M13 | `expo-updates` (OTA) for fast patch delivery without APK redistribution | P2 |
| M14 | Sentry (or equivalent) crash & error reporting | P2 |
| M15 | Pull-to-refresh on Earnings tab | P2 |
| M16 | Push notification deep-link route config for killed-app order tap | P2 |
| M17 | Password strength meter and phone-format hint on registration screen | P2 |
| M18 | Maximum locationRetryQueue size guard (200 entries) | P2 |

---

## 10 · Summary

This is a **working proof-of-concept** that covers the core rider delivery loop. The auth plumbing, background GPS, push notification wiring, order status machine, and earnings view are all functionally present. However:

- **Production readiness blockers (P0):** four critical issues must be resolved before shipping — keystore credentials, hard-coded backend URL, JWT expiration blind spot, and absence of an API contract document.
- **Reliability blockers (B3, B10, B11):** the location queue race, availability toggle, and delivered-status optimistic update can all cause silent data inconsistency under normal use.
- **UX gaps for Tirupati pilots:** riders need order accept/decline, pickup address, customer contact, and an offline indicator before the app is usable in low-connectivity field conditions.

No code was changed during this audit.
