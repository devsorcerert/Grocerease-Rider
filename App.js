import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, Button, Alert,
  ActivityIndicator, ScrollView, TouchableOpacity, Linking,
} from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

// ─── Notification handler ────────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

// ─── Base URL ────────────────────────────────────────────────────────────────
const RENDER_FALLBACK = 'https://grocerease-backend-0uip.onrender.com';
const _configured = process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL;
if (_configured === 'https://api.grocereasetv.com') {
  console.warn('EXPO_PUBLIC_API_BASE_URL points to dead domain — falling back to Render URL');
}
const BASE_URL = (_configured && _configured !== 'https://api.grocereasetv.com')
  ? _configured : RENDER_FALLBACK;

// ─── Task 26: Offline location retry queue ───────────────────────────────────
// Module-level so it persists across re-renders and background task ticks.
let locationRetryQueue = [];   // [{ lat, lng }]

async function flushLocationQueue(token) {
  if (!token || locationRetryQueue.length === 0) return;
  const pending = [...locationRetryQueue];
  locationRetryQueue = [];
  for (const item of pending) {
    try {
      const res = await fetch(`${BASE_URL}/api/rider/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lat: item.lat, lng: item.lng }),
      });
      if (!res.ok) locationRetryQueue.push(item); // re-queue on server error
    } catch {
      locationRetryQueue.push(item); // still no network — re-queue
    }
  }
}

// ─── Background location task ─────────────────────────────────────────────────
const LOCATION_TASK = 'rider-location-upload';

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) { console.warn('BG location error:', error.message); return; }
  if (!data) return;
  const loc = data.locations?.[0];
  if (!loc) return;
  try {
    const savedToken = await SecureStore.getItemAsync('rider_token');
    if (!savedToken) return;
    const { latitude: lat, longitude: lng } = loc.coords;
    const res = await fetch(`${BASE_URL}/api/rider/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${savedToken}` },
      body: JSON.stringify({ lat, lng }),
    });
    if (!res.ok) locationRetryQueue.push({ lat, lng });
    else await flushLocationQueue(savedToken); // opportunistically flush queue
  } catch {
    // Network down — will flush on next successful ping
    const loc2 = data.locations?.[0];
    if (loc2) locationRetryQueue.push({ lat: loc2.coords.latitude, lng: loc2.coords.longitude });
  }
});

// ─── Central fetch wrapper ────────────────────────────────────────────────────
let _lastFetchError = null;

const __DEV__ = process.env.NODE_ENV !== 'production';

async function apiFetch(url, options, onUnauthorized, { skipAuthRedirect = false, timeoutMs = 30000 } = {}) {
  if (__DEV__) console.log('[apiFetch] →', url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    const dump = `name:${e.name} msg:${e.message} str:${e.toString()}`;
    _lastFetchError = e.name === 'AbortError'
      ? `AbortError: timed out after ${timeoutMs / 1000}s` : dump;
    console.warn('[apiFetch] threw:', dump, '\nURL:', url);
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

// ─── Task 28: Open Google Maps deep-link ─────────────────────────────────────
function openNavigation(address) {
  const encoded = encodeURIComponent(address || '');
  const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
  Linking.openURL(url).catch(() =>
    Alert.alert('Maps unavailable', 'Could not open Google Maps.')
  );
}

// ─── App component ────────────────────────────────────────────────────────────
export default function App() {
  // Auth state
  const [mode, setMode] = useState('login');       // 'login' | 'register'
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [rider, setRider] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);

  // Register form state (Task 30)
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regVehicle, setRegVehicle] = useState('Bike');

  // Dashboard state
  const [isOnline, setIsOnline] = useState(true);        // Task 27
  const [orderQueue, setOrderQueue] = useState([]);       // Task 31
  const [healthStatus, setHealthStatus] = useState('checking…'); // DIAG
  const [activeTab, setActiveTab] = useState('orders');  // P1-B1: 'orders' | 'earnings'
  const [earnings, setEarnings] = useState(null);
  const [earningsLoading, setEarningsLoading] = useState(false);

  // Keep token accessible in callbacks without stale closures
  const tokenRef = useRef(null);
  useEffect(() => { tokenRef.current = token; }, [token]);

  const clearSession = () => { setRider(null); setToken(null); };
  const api = (url, options, flags) => apiFetch(url, options, clearSession, flags);
  const authHeaders = (tok) => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`,
  });

  // ── Session restore ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('rider_token');
        const savedRider = await SecureStore.getItemAsync('rider_session');
        if (savedToken && savedRider) {
          const parsed = JSON.parse(savedRider);
          setToken(savedToken);
          setRider(parsed);
          setIsOnline(parsed.status !== 'offline');
        }
      } catch (e) {
        console.warn('Session restore failed:', e.message);
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // ── DIAG: health probe ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE_URL}/health`);
        const t = await r.text();
        setHealthStatus(`HTTP ${r.status}: ${t.slice(0, 80)}`);
      } catch (e) {
        setHealthStatus(`${e.name}: ${e.message}`);
      }
    })();
  }, []);

  // ── fetchCurrentOrder (Task 58 fix: unwrap data.order) ──────────────────
  const fetchCurrentOrder = useCallback(async () => {
    const tok = tokenRef.current;
    if (!tok) return;
    const response = await api(`${BASE_URL}/api/rider/current-order`, {
      method: 'GET', headers: authHeaders(tok),
    });
    if (!response || !response.ok) return;
    const data = await response.json();
    // GET /api/rider/current-order returns { "order": <order|null> }
    setRider(prev => {
      if (!prev) return prev;
      const newOrder = data?.order?.id ? data.order : null;
      return { ...prev, current_order: newOrder };
    });
  }, []);

  // ── Task 31: fetchOrderQueue ──────────────────────────────────────────────
  const fetchOrderQueue = useCallback(async () => {
    const tok = tokenRef.current;
    if (!tok) return;
    const response = await api(`${BASE_URL}/api/rider/order-queue`, {
      method: 'GET', headers: authHeaders(tok),
    });
    if (!response || !response.ok) return;
    const data = await response.json();
    setOrderQueue(data?.order_queue || []);
  }, []);

  // ── 15 s idle poll + queue refresh ──────────────────────────────────────
  useEffect(() => {
    if (!rider || !token) return;
    if (rider.current_order) return;
    const id = setInterval(() => {
      fetchCurrentOrder();
      fetchOrderQueue();
    }, 15000);
    return () => clearInterval(id);
  }, [rider?.current_order, rider, token, fetchCurrentOrder, fetchOrderQueue]);

  // ── Task 26: flush location retry queue every 60 s ──────────────────────
  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => flushLocationQueue(token), 60000);
    return () => clearInterval(id);
  }, [token]);

  // ── Push token registration + notification listeners ─────────────────────
  useEffect(() => {
    if (!rider || !token) return;
    (async () => {
      try {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') return;
        const pushTokenObj = await Notifications.getExpoPushTokenAsync();
        await api(`${BASE_URL}/api/rider/push-token`, {
          method: 'POST', headers: authHeaders(token),
          body: JSON.stringify({ token: pushTokenObj.data }),
        });
      } catch (e) { console.warn('Push token registration failed:', e.message); }
    })();

    // Foreground notification
    const fgSub = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data || {};
      if (data.order_id || data.type === 'order') { fetchCurrentOrder(); fetchOrderQueue(); }
    });
    // Background / killed app — user taps banner
    const bgSub = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data || {};
      if (data.order_id || data.type === 'order') { fetchCurrentOrder(); fetchOrderQueue(); }
    });
    return () => { fgSub.remove(); bgSub.remove(); };
  }, [rider, token, fetchCurrentOrder, fetchOrderQueue]);

  // ── Background GPS tracking ──────────────────────────────────────────────
  useEffect(() => {
    if (!rider || !token) return;
    const startTracking = async () => {
      const { status: fg } = await Location.requestForegroundPermissionsAsync();
      if (fg !== 'granted') { Alert.alert('Location permission denied'); return; }
      const { status: bg } = await Location.requestBackgroundPermissionsAsync();
      if (bg !== 'granted')
        Alert.alert('Background location denied', 'Location updates only while app is open.');
      const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
      if (!already) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 5000, distanceInterval: 0,
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

  // ── Login ────────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!phone.trim() || !password.trim()) {
      Alert.alert('Required', 'Enter phone and password'); return;
    }
    setLoading(true);
    const loginUrl = `${BASE_URL}/api/rider/login`;
    try {
      const response = await api(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      }, { skipAuthRedirect: true });

      if (!response) {
        const isTimeout = _lastFetchError?.startsWith('AbortError');
        Alert.alert(
          isTimeout ? 'Server took too long' : 'Network error',
          isTimeout ? `Server is waking up — wait 30s and retry.\nURL: ${loginUrl}`
                    : `URL: ${loginUrl}\n\n${_lastFetchError || 'unknown'}`
        ); return;
      }
      const rawText = await response.text();
      let data = null;
      let parseError = null;
      try { data = JSON.parse(rawText); } catch (pe) { parseError = pe.message; }
      if (!response.ok || parseError) {
        Alert.alert(`Login HTTP ${response.status}`,
          `URL: ${loginUrl}\n\n${rawText.slice(0, 400)}${parseError ? `\nParse: ${parseError}` : ''}`);
        return;
      }
      if (!data.token) {
        Alert.alert(`No token (HTTP ${response.status})`, rawText.slice(0, 400)); return;
      }
      setToken(data.token);
      setRider(data);
      setIsOnline(true);
      await SecureStore.setItemAsync('rider_token', data.token);
      await SecureStore.setItemAsync('rider_session', JSON.stringify(data));
    } catch (e) {
      Alert.alert('Login threw', `${e.name}: ${e.message}`);
    } finally { setLoading(false); }
  };

  // ── Task 30: Register ─────────────────────────────────────────────────────
  const handleRegister = async () => {
    if (!regName.trim() || !regPhone.trim() || !regPassword.trim()) {
      Alert.alert('Required', 'Fill in name, phone and password'); return;
    }
    setLoading(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/rider/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: regName.trim(), phone: regPhone.trim(),
          password: regPassword, vehicle: regVehicle.trim() || 'Bike',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        Alert.alert('Registration failed', data.detail || 'Unknown error'); return;
      }
      Alert.alert(
        'Registration submitted ✅',
        "An admin will review and approve your account. You'll be able to log in once approved.",
        [{ text: 'Go to Login', onPress: () => setMode('login') }]
      );
      setRegName(''); setRegPhone(''); setRegPassword(''); setRegVehicle('Bike');
    } catch (e) {
      Alert.alert('Network error', e.message);
    } finally { setLoading(false); }
  };

  // ── Task 27: Availability toggle ─────────────────────────────────────────
  const toggleAvailability = async () => {
    if (!token) return;
    const newAvailable = !isOnline;
    try {
      const resp = await api(`${BASE_URL}/api/rider/availability`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ available: newAvailable }),
      });
      if (!resp) { Alert.alert('Network error', 'Could not update status'); return; }
      if (resp.ok) {
        setIsOnline(newAvailable);
      } else {
        const d = await resp.json();
        Alert.alert('Cannot change status', d.detail || 'Unknown error');
      }
    } catch (e) { Alert.alert('Network error', e.message); }
  };

  // ── Update order status ───────────────────────────────────────────────────
  const updateStatus = async (status) => {
    if (!rider?.current_order || !token) return;
    setLoading(true);
    try {
      const response = await api(`${BASE_URL}/api/rider/order-status`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ order_id: rider.current_order.id, status }),
      });
      if (!response) { Alert.alert('Network error', "Couldn't reach server"); return; }
      if (response.ok) {
        if (status === 'delivered') {
          setRider({ ...rider, current_order: null });
          Alert.alert('Order Delivered! 🎉', 'Great job!');
          // Fetch queue — backend may have promoted a queued order
          setTimeout(() => { fetchCurrentOrder(); fetchOrderQueue(); }, 1000);
        } else {
          setRider({ ...rider, current_order: { ...rider.current_order, delivery_status: status } });
        }
      } else {
        const d = await response.json();
        Alert.alert('Status update failed', d.detail || 'Unknown error');
      }
    } catch (e) { Alert.alert('Network error', e.message); }
    finally { setLoading(false); }
  };

  // ── P1-B1: Fetch earnings ─────────────────────────────────────────────────────
  const fetchEarnings = useCallback(async () => {
    const tok = tokenRef.current;
    if (!tok) return;
    setEarningsLoading(true);
    try {
      const resp = await api(`${BASE_URL}/api/rider/earnings`, {
        method: 'GET', headers: authHeaders(tok),
      });
      if (resp && resp.ok) setEarnings(await resp.json());
    } catch (e) { console.warn('Earnings fetch failed:', e.message); }
    finally { setEarningsLoading(false); }
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    await SecureStore.deleteItemAsync('rider_token');
    await SecureStore.deleteItemAsync('rider_session');
    clearSession();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  if (restoring) {
    return <View style={s.container}><ActivityIndicator size="large" color="#2D8B47" /></View>;
  }

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!rider) {
    if (mode === 'register') {
      return (
        <ScrollView contentContainerStyle={s.container}>
          <Text style={s.title}>🛵 Create Rider Account</Text>

          <TextInput style={s.input} placeholder="Full name"
            value={regName} onChangeText={setRegName} />
          <TextInput style={s.input} placeholder="Phone (+91XXXXXXXXXX)"
            value={regPhone} onChangeText={setRegPhone}
            keyboardType="phone-pad" autoCapitalize="none" />
          <TextInput style={s.input} placeholder="Password"
            value={regPassword} onChangeText={setRegPassword} secureTextEntry />
          <TextInput style={s.input} placeholder="Vehicle (Bike / Scooter / Car)"
            value={regVehicle} onChangeText={setRegVehicle} />

          {loading
            ? <ActivityIndicator size="large" color="#2D8B47" />
            : <Button title="Submit Registration" onPress={handleRegister} color="#2D8B47" />
          }
          <TouchableOpacity onPress={() => setMode('login')} style={{ marginTop: 16 }}>
            <Text style={s.linkText}>Already registered? Log in →</Text>
          </TouchableOpacity>
        </ScrollView>
      );
    }

    // Login mode
    return (
      <View style={s.container}>
        <Text style={s.title}>🛵 GrocerEase Rider</Text>
        <TextInput style={s.input} placeholder="Phone (+91XXXXXXXXXX)"
          value={phone} onChangeText={setPhone}
          keyboardType="phone-pad" autoCapitalize="none" />
        <TextInput style={s.input} placeholder="Password"
          value={password} onChangeText={setPassword} secureTextEntry />
        {loading
          ? <ActivityIndicator size="large" color="#2D8B47" />
          : <Button title="Login" onPress={handleLogin} color="#2D8B47" />
        }
        <TouchableOpacity onPress={() => setMode('register')} style={{ marginTop: 16 }}>
          <Text style={s.linkText}>New rider? Register here →</Text>
        </TouchableOpacity>
        {/* DIAG — dev only */}
        {__DEV__ && <Text style={s.diagText}>API: {BASE_URL}</Text>}
        {__DEV__ && <Text style={s.diagText}>health: {healthStatus}</Text>}
      </View>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: '#ecf0f1' }}>
      {/* Header */}
      <View style={s.appHeader}>
        <Text style={s.title}>👋 {rider.name}</Text>
        <TouchableOpacity
          style={[s.statusBadge, isOnline ? s.badgeOnline : s.badgeOffline]}
          onPress={toggleAvailability}
        >
          <Text style={s.statusBadgeText}>{isOnline ? '🟢 Online' : '🔴 Offline'}</Text>
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <View style={s.tabBar}>
        <TouchableOpacity
          style={[s.tab, activeTab === 'orders' && s.tabActive]}
          onPress={() => setActiveTab('orders')}
        >
          <Text style={[s.tabText, activeTab === 'orders' && s.tabTextActive]}>📦 Orders</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, activeTab === 'earnings' && s.tabActive]}
          onPress={() => { setActiveTab('earnings'); if (!earnings) fetchEarnings(); }}
        >
          <Text style={[s.tabText, activeTab === 'earnings' && s.tabTextActive]}>💰 Earnings</Text>
        </TouchableOpacity>
      </View>

      {/* ── ORDERS TAB ── */}
      {activeTab === 'orders' && (
        <ScrollView contentContainerStyle={s.tabContent}>
          <View style={s.orderContainer}>
            {rider.current_order ? (
              <>
                <Text style={s.orderTitle}>
                  Order #{rider.current_order.id?.slice(0, 8).toUpperCase()}
                </Text>
                <Text>📍 {rider.current_order.delivery_address}</Text>
                <Text>💰 ₹{rider.current_order.subtotal}</Text>
                <Text style={s.statusLabel}>Status: {rider.current_order.delivery_status}</Text>
                <TouchableOpacity style={s.navButton}
                  onPress={() => openNavigation(rider.current_order.delivery_address)}>
                  <Text style={s.navButtonText}>🗺️ Open in Google Maps</Text>
                </TouchableOpacity>
                {loading
                  ? <ActivityIndicator color="#2D8B47" style={{ marginTop: 16 }} />
                  : (
                    <View style={s.buttonGroup}>
                      <Button title="Reached Store"   onPress={() => updateStatus('reached_store')}   color="#f39c12" />
                      <Button title="Picked Up"        onPress={() => updateStatus('picked_up')}        color="#3498db" />
                      <Button title="Out for Delivery" onPress={() => updateStatus('out_for_delivery')} color="#9b59b6" />
                      <Button title="Delivered ✅"     onPress={() => updateStatus('delivered')}         color="#2ecc71" />
                    </View>
                  )
                }
              </>
            ) : (
              <Text style={s.noOrder}>⏳ Waiting for orders...</Text>
            )}
          </View>
          {orderQueue.length > 0 && (
            <View style={s.queueContainer}>
              <Text style={s.queueTitle}>📋 Upcoming Orders ({orderQueue.length})</Text>
              {orderQueue.map((o, i) => (
                <View key={o.id} style={s.queueItem}>
                  <Text style={s.queueOrderNum}>#{i + 1} — Order {o.id?.slice(0, 8).toUpperCase()}</Text>
                  <Text style={s.queueAddr}>📍 {o.delivery_address}</Text>
                  <TouchableOpacity onPress={() => openNavigation(o.delivery_address)}>
                    <Text style={s.queueNav}>🗺️ Preview route</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
          <View style={{ marginTop: 8, marginBottom: 24 }}>
            <Button title="Logout" color="#e74c3c" onPress={handleLogout} />
          </View>
        </ScrollView>
      )}

      {/* ── EARNINGS TAB ── */}
      {activeTab === 'earnings' && (
        <ScrollView contentContainerStyle={s.tabContent}>
          {earningsLoading && <ActivityIndicator size="large" color="#2D8B47" style={{ marginTop: 40 }} />}
          {!earningsLoading && earnings && (
            <>
              <View style={s.earningsGrid}>
                <View style={[s.earningsCard, { backgroundColor: '#d5f5e3' }]}>
                  <Text style={s.earningsLabel}>Today</Text>
                  <Text style={s.earningsAmount}>₹{earnings.today.toFixed(0)}</Text>
                </View>
                <View style={[s.earningsCard, { backgroundColor: '#d6eaf8' }]}>
                  <Text style={s.earningsLabel}>This Week</Text>
                  <Text style={s.earningsAmount}>₹{earnings.this_week.toFixed(0)}</Text>
                </View>
                <View style={[s.earningsCard, { backgroundColor: '#fdebd0' }]}>
                  <Text style={s.earningsLabel}>This Month</Text>
                  <Text style={s.earningsAmount}>₹{earnings.this_month.toFixed(0)}</Text>
                </View>
                <View style={[s.earningsCard, { backgroundColor: '#e8daef' }]}>
                  <Text style={s.earningsLabel}>All Time</Text>
                  <Text style={s.earningsAmount}>₹{earnings.all_time.toFixed(0)}</Text>
                </View>
              </View>
              <Text style={s.deliveryCount}>🚚 {earnings.total_deliveries} deliveries completed</Text>
              <Text style={s.recentTitle}>Recent Deliveries</Text>
              {earnings.recent_deliveries.length === 0 && (
                <Text style={s.noOrder}>No deliveries yet.</Text>
              )}
              {earnings.recent_deliveries.map((d) => (
                <View key={d.order_id} style={s.deliveryRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.deliveryOrderId}>Order {d.order_id?.slice(0, 8).toUpperCase()}</Text>
                    <Text style={s.deliveryAddr} numberOfLines={1}>{d.address}</Text>
                    {d.delivered_at && (
                      <Text style={s.deliveryTime}>
                        {new Date(d.delivered_at).toLocaleDateString('en-IN', {
                          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                        })}
                      </Text>
                    )}
                  </View>
                  <Text style={s.deliveryFee}>₹{d.amount.toFixed(0)}</Text>
                </View>
              ))}
              <TouchableOpacity onPress={fetchEarnings} style={s.refreshBtn}>
                <Text style={s.refreshBtnText}>🔄 Refresh</Text>
              </TouchableOpacity>
            </>
          )}
          {!earningsLoading && !earnings && (
            <View style={{ alignItems: 'center', marginTop: 40 }}>
              <Text style={s.noOrder}>Could not load earnings.</Text>
              <TouchableOpacity onPress={fetchEarnings} style={[s.navButton, { marginTop: 16 }]}>
                <Text style={s.navButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={{ marginTop: 16, marginBottom: 24 }}>
            <Button title="Logout" color="#e74c3c" onPress={handleLogout} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container:    { flexGrow: 1, padding: 20, backgroundColor: '#ecf0f1', justifyContent: 'center' },
  title:        { fontSize: 22, fontWeight: 'bold', color: '#2D8B47' },
  input:        { height: 44, borderColor: '#bdc3c7', borderWidth: 1, marginBottom: 14,
                  paddingHorizontal: 12, backgroundColor: '#fff', borderRadius: 8 },
  linkText:     { color: '#2D8B47', textAlign: 'center', fontSize: 14 },
  headerRow:    { flexDirection: 'row', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: 16 },
  statusBadge:  { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  badgeOnline:  { backgroundColor: '#d5f5e3' },
  badgeOffline: { backgroundColor: '#fadbd8' },
  statusBadgeText: { fontSize: 13, fontWeight: '600' },
  orderContainer: { padding: 16, backgroundColor: '#fff', borderRadius: 12,
                    marginBottom: 16, elevation: 3 },
  orderTitle:   { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111' },
  statusLabel:  { marginTop: 10, fontWeight: 'bold', color: '#e67e22', fontSize: 14 },
  navButton:    { marginTop: 12, backgroundColor: '#2980b9', borderRadius: 8,
                  paddingVertical: 10, alignItems: 'center' },
  navButtonText:{ color: '#fff', fontWeight: '600', fontSize: 14 },
  buttonGroup:  { marginTop: 16, gap: 10 },
  noOrder:      { textAlign: 'center', fontSize: 16, color: '#7f8c8d',
                  fontStyle: 'italic', padding: 20 },
  queueContainer: { backgroundColor: '#fef9e7', borderRadius: 12, padding: 14,
                    marginBottom: 16, elevation: 2 },
  queueTitle:   { fontSize: 15, fontWeight: 'bold', color: '#7d6608', marginBottom: 10 },
  queueItem:    { borderTopWidth: 1, borderTopColor: '#f0e0a0', paddingTop: 10, marginTop: 8 },
  queueOrderNum:{ fontWeight: '600', color: '#333', fontSize: 14 },
  queueAddr:    { color: '#555', marginTop: 2, fontSize: 13 },
  queueNav:     { color: '#2980b9', marginTop: 4, fontSize: 13 },
  diagText:     { marginTop: 8, fontSize: 11, color: '#e74c3c',
                  textAlign: 'center', fontFamily: 'monospace' },
  // P1-B1 earnings + tab styles
  appHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                  paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12,
                  backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  tabBar:       { flexDirection: 'row', backgroundColor: '#fff',
                  borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  tab:          { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive:    { borderBottomWidth: 3, borderBottomColor: '#2D8B47' },
  tabText:      { fontSize: 14, fontWeight: '600', color: '#9CA3AF' },
  tabTextActive:{ color: '#2D8B47' },
  tabContent:   { padding: 16, paddingBottom: 40 },
  earningsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  earningsCard: { width: '47%', borderRadius: 12, padding: 14, alignItems: 'center' },
  earningsLabel:{ fontSize: 12, color: '#6B7280', fontWeight: '600', marginBottom: 4 },
  earningsAmount:{ fontSize: 22, fontWeight: 'bold', color: '#111' },
  deliveryCount:{ textAlign: 'center', color: '#6B7280', fontSize: 13, marginBottom: 16 },
  recentTitle:  { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  deliveryRow:  { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff',
                  borderRadius: 10, padding: 12, marginBottom: 8,
                  shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.06, shadowRadius: 2, elevation: 1 },
  deliveryOrderId: { fontWeight: '700', color: '#111', fontSize: 14 },
  deliveryAddr: { color: '#6B7280', fontSize: 12, marginTop: 2 },
  deliveryTime: { color: '#9CA3AF', fontSize: 11, marginTop: 2 },
  deliveryFee:  { fontSize: 18, fontWeight: 'bold', color: '#2D8B47', marginLeft: 8 },
  refreshBtn:   { alignSelf: 'center', marginTop: 16, paddingHorizontal: 24,
                  paddingVertical: 10, backgroundColor: '#f3f4f6', borderRadius: 8 },
  refreshBtnText:{ color: '#374151', fontWeight: '600', fontSize: 14 },
});
