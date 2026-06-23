import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, Button, Alert, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

// Show notifications in foreground as banners/alerts
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const LOCATION_TASK = 'rider-location-upload';

// Must be defined at module level — TaskManager requires this to be outside any component.
// Uses raw fetch (not api()) because this runs in a background context with no access
// to the component's clearSession binding. Token is read fresh from SecureStore each tick.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) { console.warn('Background location error:', error.message); return; }
  if (!data) return;
  const { locations } = data;
  const loc = locations[0];
  if (!loc) return;
  try {
    const savedToken = await SecureStore.getItemAsync('rider_token');
    if (!savedToken) return;
    await fetch(`${BASE_URL}/api/rider/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${savedToken}` },
      body: JSON.stringify({ lat: loc.coords.latitude, lng: loc.coords.longitude })
    });
  } catch (e) {
    console.warn('Background location upload failed:', e.message);
  }
});

const RENDER_FALLBACK = 'https://grocerease-backend-0uip.onrender.com';
const _configured = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL;
if (_configured === 'https://api.grocereasetv.com') {
  console.warn('EXPO_PUBLIC_API_BASE_URL points to the dead domain api.grocereasetv.com — falling back to Render pilot URL');
}
const BASE_URL = (_configured && _configured !== 'https://api.grocereasetv.com')
  ? _configured
  : RENDER_FALLBACK;

// Temporary diagnostic: stores the last fetch error so callers can surface it.
let _lastFetchError = null;

// Central fetch wrapper — handles network failures and 401s in one place.
// skipAuthRedirect: true for login, where 401 means wrong credentials not expired session.
// timeoutMs: explicit request timeout (default 30s — Render cold start + bcrypt can take 10-20s).
async function apiFetch(url, options, onUnauthorized, { skipAuthRedirect = false, timeoutMs = 30000 } = {}) {
  console.log('[apiFetch] →', url);  // DIAG
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    // DIAG: dump everything — e.message is empty for OkHttp timeout errors
    const dump = `name:${e.name} msg:${e.message} str:${e.toString()} json:${JSON.stringify(e)}`;
    _lastFetchError = e.name === 'AbortError'
      ? `AbortError: request timed out after ${timeoutMs / 1000}s`
      : dump;
    console.warn('[apiFetch] fetch threw:', dump, '\nURL:', url);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) {
    if (!skipAuthRedirect) {
      await SecureStore.deleteItemAsync('rider_token');
      await SecureStore.deleteItemAsync('rider_session');
      onUnauthorized();
    }
    return null;
  }
  _lastFetchError = null;
  return response;
}

export default function App() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [rider, setRider] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [healthStatus, setHealthStatus] = useState('checking…');  // DIAG

  // Keep latest token accessible inside poll/notification callbacks without stale closures
  const tokenRef = useRef(null);
  useEffect(() => { tokenRef.current = token; }, [token]);

  const clearSession = () => { setRider(null); setToken(null); };

  // Bind onUnauthorized once; every API call uses this instead of raw fetch
  const api = (url, options, flags) => apiFetch(url, options, clearSession, flags);

  const authHeaders = (tok) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`
  });

  // Restore session from secure storage on launch
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('rider_token');
        const savedRider = await SecureStore.getItemAsync('rider_session');
        if (savedToken && savedRider) {
          setToken(savedToken);
          setRider(JSON.parse(savedRider));
        }
      } catch (e) {
        console.warn('Session restore failed:', e.message);
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // DIAG: probe health endpoint on mount to confirm basic reachability
  useEffect(() => {
    (async () => {
      const url = `${BASE_URL}/health`;
      try {
        const r = await fetch(url, { method: 'GET' });
        const text = await r.text();
        setHealthStatus(`HTTP ${r.status}: ${text.slice(0, 80)}`);
      } catch (e) {
        setHealthStatus(`${e.name}: ${e.message}`);
      }
    })();
  }, []);

  // Fetch the current order from the backend and merge into rider state.
  // Safe to call at any time; no-ops if not logged in.
  const fetchCurrentOrder = useCallback(async () => {
    const tok = tokenRef.current;
    if (!tok) return;
    const response = await api(`${BASE_URL}/api/rider/current-order`, {
      method: 'GET',
      headers: authHeaders(tok),
    });
    if (!response || !response.ok) return;
    const data = await response.json();
    // Backend returns the order object directly (or null/empty when no order)
    setRider(prev => {
      if (!prev) return prev;
      const newOrder = data?.id ? data : null;
      return { ...prev, current_order: newOrder };
    });
  }, []);

  // Poll GET /api/rider/current-order every 15 s while the rider is idle (no active order).
  // The interval is cleared the moment an order becomes active.
  useEffect(() => {
    if (!rider || !token) return;
    if (rider.current_order) return; // active order — no polling needed

    const intervalId = setInterval(fetchCurrentOrder, 15000);
    return () => clearInterval(intervalId);
  }, [rider?.current_order, rider, token, fetchCurrentOrder]);

  // Refresh immediately when a push notification arrives indicating a new order.
  useEffect(() => {
    if (!rider || !token) return;

    // Register push token with backend so the server can target this device
    (async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;
        const pushTokenObj = await Notifications.getExpoPushTokenAsync();
        await api(`${BASE_URL}/api/rider/push-token`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ token: pushTokenObj.data }),
        });
      } catch (e) {
        console.warn('Push token registration failed:', e.message);
      }
    })();

    const sub = Notifications.addNotificationReceivedListener(notification => {
      const type = notification.request.content.data?.type;
      if (type === 'new_order') {
        fetchCurrentOrder();
      }
    });
    return () => sub.remove();
  }, [rider, token, fetchCurrentOrder]);

  const handleLogin = async () => {
    if (!phone.trim() || !password.trim()) {
      Alert.alert('Required', 'Enter phone and password');
      return;
    }
    setLoading(true);
    const loginUrl = `${BASE_URL}/api/rider/login`;
    try {
      const response = await api(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      }, { skipAuthRedirect: true });

      if (!response) {
        const isTimeout = _lastFetchError?.startsWith('AbortError');
        Alert.alert(
          isTimeout ? 'Server took too long' : 'Network error',
          isTimeout
            ? `Server took too long to respond (>30s).\nIt may be waking up — wait 30s and try again.\n\nURL: ${loginUrl}`
            : `URL: ${loginUrl}\n\n${_lastFetchError || 'unknown error'}`  // DIAG
        );
        return;
      }

      // DIAG: read raw body first, then try JSON parse
      const rawText = await response.text();
      let data = null;
      let parseError = null;
      try { data = JSON.parse(rawText); } catch (pe) { parseError = pe.message; }

      // DIAG: always show status + raw body in alert so we can read it off the screen
      if (!response.ok || parseError) {
        Alert.alert(
          `Login response HTTP ${response.status}`,
          `URL: ${loginUrl}\n\nRaw body:\n${rawText.slice(0, 400)}${parseError ? `\n\nJSON parse error: ${parseError}` : ''}`
        );
        return;
      }

      if (!data.token) {
        Alert.alert(
          `Login HTTP ${response.status} — no token`,
          `URL: ${loginUrl}\n\nBody:\n${rawText.slice(0, 400)}`  // DIAG
        );
        return;
      }

      setToken(data.token);
      setRider(data);
      await SecureStore.setItemAsync('rider_token', data.token);
      await SecureStore.setItemAsync('rider_session', JSON.stringify(data));
    } catch (e) {
      // DIAG: show full error object, not just .message
      Alert.alert('Login threw', `URL: ${loginUrl}\n\n${e.name}: ${e.message}\n\n${JSON.stringify(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!rider || !token) return;

    const startTracking = async () => {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') { Alert.alert('Location permission denied'); return; }

      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted') {
        Alert.alert('Background location denied', 'Location will only update while the app is open.');
      }

      const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      if (!already) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 5000,
          distanceInterval: 0,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'GrocerEase Rider',
            notificationBody: 'Tracking your location for active delivery',
          },
        });
      }
    };

    startTracking();
    return () => {
      Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)
        .then(started => { if (started) Location.stopLocationUpdatesAsync(LOCATION_TASK); })
        .catch(() => {});
    };
  }, [rider, token]);

  const updateStatus = async (status) => {
    if (!rider?.current_order || !token) return;
    setLoading(true);
    try {
      const response = await api(`${BASE_URL}/api/rider/order-status`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          order_id: rider.current_order.id,
          status
        })
      });
      if (!response) { Alert.alert('Network error', "Couldn't reach server, try again"); return; }
      if (response.ok) {
        if (status === 'delivered') {
          setRider({ ...rider, current_order: null });
          Alert.alert('Order Delivered!', 'Great job!');
        } else {
          setRider({ ...rider, current_order: { ...rider.current_order, delivery_status: status } });
        }
      } else {
        const data = await response.json();
        Alert.alert('Failed to update status', data.detail || 'Unknown error');
      }
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    await SecureStore.deleteItemAsync('rider_token');
    await SecureStore.deleteItemAsync('rider_session');
    clearSession();
  };

  if (restoring) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#2D8B47" />
      </View>
    );
  }

  if (!rider) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>🛵 GrocerEase Rider</Text>
        <TextInput
          style={styles.input}
          placeholder="Phone (+91XXXXXXXXXX)"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {loading
          ? <ActivityIndicator size="large" color="#2D8B47" />
          : <Button title="Login" onPress={handleLogin} color="#2D8B47" />
        }
        {/* DIAG: visible on-screen diagnostics — remove before release */}
        <Text style={styles.diagText}>API: {BASE_URL}</Text>
        <Text style={styles.diagText}>health: {healthStatus}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome, {rider.name}!</Text>
      <Text style={styles.status}>🟢 Online</Text>

      <View style={styles.orderContainer}>
        {rider.current_order ? (
          <>
            <Text style={styles.orderTitle}>Order #{rider.current_order.id?.slice(0,8).toUpperCase()}</Text>
            <Text>📍 {rider.current_order.delivery_address}</Text>
            <Text>💰 ₹{rider.current_order.subtotal}</Text>
            <Text style={styles.statusLabel}>Status: {rider.current_order.delivery_status}</Text>

            {loading
              ? <ActivityIndicator color="#2D8B47" style={{ marginTop: 16 }} />
              : (
                <View style={styles.buttonGroup}>
                  <Button title="Reached Store" onPress={() => updateStatus('reached_store')} color="#f39c12" />
                  <Button title="Picked Up" onPress={() => updateStatus('picked_up')} color="#3498db" />
                  <Button title="Out for Delivery" onPress={() => updateStatus('out_for_delivery')} color="#9b59b6" />
                  <Button title="Delivered ✅" onPress={() => updateStatus('delivered')} color="#2ecc71" />
                </View>
              )
            }
          </>
        ) : (
          <Text style={styles.noOrder}>⏳ Waiting for orders...</Text>
        )}
      </View>

      <Button title="Logout" color="#e74c3c" onPress={handleLogout} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#ecf0f1', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center', color: '#2D8B47' },
  input: { height: 44, borderColor: '#bdc3c7', borderWidth: 1, marginBottom: 14, paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 8 },
  status: { fontSize: 16, color: '#27ae60', textAlign: 'center', marginBottom: 20 },
  orderContainer: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 20, elevation: 3 },
  orderTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111' },
  statusLabel: { marginTop: 10, fontWeight: 'bold', color: '#e67e22', fontSize: 14 },
  buttonGroup: { marginTop: 16, gap: 10 },
  noOrder: { textAlign: 'center', fontSize: 16, color: '#7f8c8d', fontStyle: 'italic', padding: 20 },
  diagText: { marginTop: 8, fontSize: 11, color: '#e74c3c', textAlign: 'center', fontFamily: 'monospace' }
});
