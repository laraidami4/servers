/**
 * Standalone probe: does the LATEST F1 session have location + team_radio data?
 *
 * Channels tested:
 *   1. REST API      -> https://api.openf1.org/v1/
 *   2. MQTT (TLS)    -> mqtts://mqtt.openf1.org:8883
 *   3. WebSocket     -> wss://mqtt.openf1.org:8084/mqtt   (MQTT over WS)
 *
 * Run:  node test-live-data.js
 */

const axios = require("axios");
const mqtt = require("mqtt");

const BASE = "https://api.openf1.org/v1/";
const USER = process.env.OPENF1_USERNAME || "dlaraiyetan2@gmail.com";
const PASS = process.env.OPENF1_PASSWORD || "LUF8ApHlS48ygFM9";

const MQTT_TLS_URL = "mqtts://mqtt.openf1.org:8883";
const MQTT_WS_URL = "wss://mqtt.openf1.org:8084/mqtt";
const LISTEN_MS = 20000; // how long to listen on each MQTT channel

const line = (c = "-") => console.log(c.repeat(72));
const head = (t) => {
  console.log("");
  line("=");
  console.log(t);
  line("=");
};

/* ------------------------------------------------------------------ */
/* 1. Auth                                                             */
/* ------------------------------------------------------------------ */
async function getToken() {
  const body = `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`;
  const r = await axios.post("https://api.openf1.org/token", body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
  if (!r.data?.access_token) throw new Error("no access_token in response");
  return r.data.access_token;
}

/* ------------------------------------------------------------------ */
/* 2. Find the latest session                                          */
/* ------------------------------------------------------------------ */
async function findLatestSession(token) {
  const auth = { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 };

  // OpenF1 supports "latest" as a session_key value.
  try {
    const r = await axios.get(`${BASE}sessions?session_key=latest`, auth);
    const arr = Array.isArray(r.data) ? r.data : [];
    if (arr.length > 0) return { session: arr[arr.length - 1], via: "session_key=latest" };
  } catch (e) {
    console.log(`  (session_key=latest failed: ${e.message})`);
  }

  // Fallback: pull the year and pick the newest session that has already started.
  const year = new Date().getFullYear();
  const r = await axios.get(`${BASE}sessions?year=${year}`, auth);
  const arr = Array.isArray(r.data) ? r.data : [];
  if (arr.length === 0) throw new Error(`no sessions returned for year ${year}`);

  const now = Date.now();
  const started = arr
    .filter((s) => {
      const ms = s?.date_start ? new Date(s.date_start).getTime() : NaN;
      return Number.isFinite(ms) && ms <= now;
    })
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));

  const pick = started[0] || arr.sort((a, b) => new Date(b.date_start) - new Date(a.date_start))[0];
  return { session: pick, via: `sessions?year=${year}` };
}

/* ------------------------------------------------------------------ */
/* 3. REST probes                                                      */
/* ------------------------------------------------------------------ */
async function restProbe(token, sessionKey) {
  const auth = { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 };
  const out = {};

  const count = async (label, path) => {
    try {
      const r = await axios.get(`${BASE}${path}`, auth);
      const arr = Array.isArray(r.data) ? r.data : [];
      out[label] = { ok: true, count: arr.length, sample: arr[0] ?? null };
      return arr;
    } catch (e) {
      out[label] = {
        ok: false,
        status: e?.response?.status ?? null,
        error: e?.response?.data?.detail || e.message,
      };
      return [];
    }
  };

  // drivers first so we can scope the (potentially huge) location query
  const drivers = await count("drivers", `drivers?session_key=${sessionKey}`);
  const driverNumber = drivers[0]?.driver_number ?? null;

  if (driverNumber != null) {
    await count(
      "location (1 driver)",
      `location?session_key=${sessionKey}&driver_number=${driverNumber}`,
    );
  } else {
    out["location (1 driver)"] = { ok: false, error: "no driver_number to scope query" };
  }

  await count("team_radio", `team_radio?session_key=${sessionKey}`);

  return out;
}

/* ------------------------------------------------------------------ */
/* 4. MQTT / WebSocket probes                                          */
/* ------------------------------------------------------------------ */
function mqttProbe({ url, label, token, topics, durationMs }) {
  return new Promise((resolve) => {
    const out = {
      label,
      url,
      connected: false,
      subscribed: false,
      error: null,
      counts: {},
      samples: {},
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        client.end(true);
      } catch (e) {}
      resolve(out);
    };

    const client = mqtt.connect(url, {
      username: USER,
      password: token,
      reconnectPeriod: 0,
      connectTimeout: 15000,
      clean: true,
    });

    const timer = setTimeout(finish, durationMs);

    client.on("connect", () => {
      out.connected = true;
      client.subscribe(topics, { qos: 0 }, (err) => {
        if (err) out.error = `subscribe: ${err.message}`;
        else out.subscribed = true;
      });
    });

    client.on("message", (topic, payload) => {
      const name = topic.replace(/^v1\//, "");
      out.counts[name] = (out.counts[name] || 0) + 1;
      if (!out.samples[name]) {
        try {
          out.samples[name] = JSON.parse(payload.toString());
        } catch (e) {
          out.samples[name] = payload.toString().slice(0, 200);
        }
      }
    });

    client.on("error", (e) => {
      out.error = e.message;
      clearTimeout(timer);
      finish();
    });

    client.on("close", () => {
      // only bail early if we never connected
      if (!out.connected) {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 5. Report                                                           */
/* ------------------------------------------------------------------ */
function printRest(rest) {
  head("REST API  (https://api.openf1.org/v1/)");
  for (const [label, r] of Object.entries(rest)) {
    if (r.ok) {
      console.log(`  ${label.padEnd(20)} -> ${r.count} row(s)`);
      if (r.sample) console.log(`      sample: ${JSON.stringify(r.sample).slice(0, 220)}`);
    } else {
      console.log(`  ${label.padEnd(20)} -> FAILED (${r.status ?? "n/a"}) ${r.error}`);
    }
  }
}

function printMqtt(m) {
  head(`${m.label}  (${m.url})`);
  console.log(`  connected : ${m.connected}`);
  console.log(`  subscribed: ${m.subscribed}`);
  if (m.error) console.log(`  error     : ${m.error}`);
  const topics = Object.keys(m.counts);
  if (topics.length === 0) {
    console.log(`  messages  : NONE received in ${LISTEN_MS / 1000}s`);
  } else {
    for (const t of topics) {
      console.log(`  ${t.padEnd(20)} -> ${m.counts[t]} message(s)`);
      console.log(`      sample: ${JSON.stringify(m.samples[t]).slice(0, 220)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
(async () => {
  const report = { token: false, session: null, rest: null, mqtt: null, ws: null };

  head("AUTH");
  let token;
  try {
    token = await getToken();
    report.token = true;
    console.log(`  token acquired (${token.slice(0, 12)}...)`);
  } catch (e) {
    console.log(`  TOKEN FAILED: ${e.message}`);
    console.log("  -> cannot continue without a token");
    process.exitCode = 1;
    return;
  }

  head("LATEST SESSION");
  let session;
  try {
    const found = await findLatestSession(token);
    session = found.session;
    report.session = session;
    console.log(`  found via : ${found.via}`);
    console.log(`  session_key : ${session.session_key}`);
    console.log(`  name        : ${session.session_name} (${session.session_type})`);
    console.log(`  meeting_key : ${session.meeting_key}`);
    console.log(`  location    : ${session.location}, ${session.country_name}`);
    console.log(`  date_start  : ${session.date_start}`);
    console.log(`  date_end    : ${session.date_end}`);
    console.log(`  gmt_offset  : ${session.gmt_offset}`);
  } catch (e) {
    console.log(`  FAILED to resolve latest session: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const sk = session.session_key;

  try {
    report.rest = await restProbe(token, sk);
    printRest(report.rest);
  } catch (e) {
    console.log(`  REST probe crashed: ${e.message}`);
  }

  const topics = ["v1/location", "v1/team_radio", "v1/laps"];

  try {
    report.mqtt = await mqttProbe({
      url: MQTT_TLS_URL,
      label: "MQTT over TLS",
      token,
      topics,
      durationMs: LISTEN_MS,
    });
    printMqtt(report.mqtt);
  } catch (e) {
    console.log(`  MQTT probe crashed: ${e.message}`);
  }

  try {
    report.ws = await mqttProbe({
      url: MQTT_WS_URL,
      label: "WebSocket (MQTT over WSS)",
      token,
      topics,
      durationMs: LISTEN_MS,
    });
    printMqtt(report.ws);
  } catch (e) {
    console.log(`  WebSocket probe crashed: ${e.message}`);
  }

  head("SUMMARY");
  const restLoc = report.rest?.["location (1 driver)"];
  const restRadio = report.rest?.team_radio;
  console.log(`  REST  location   : ${restLoc?.ok ? `${restLoc.count} row(s)` : "no data / error"}`);
  console.log(`  REST  team_radio : ${restRadio?.ok ? `${restRadio.count} row(s)` : "no data / error"}`);
  for (const [name, m] of [["MQTT", report.mqtt], ["WS", report.ws]]) {
    if (!m) continue;
    const loc = m.counts?.location ?? 0;
    const radio = m.counts?.team_radio ?? 0;
    const laps = m.counts?.laps ?? 0;
    console.log(
      `  ${name.padEnd(4)}  connected=${m.connected}  location=${loc}  team_radio=${radio}  laps=${laps}${m.error ? `  err=${m.error}` : ""}`,
    );
  }
  line("=");
  console.log("");
  console.log("NOTE: team_radio is NOT in the server's MQTT_TOPICS list, so the");
  console.log("      server only ever gets team_radio via REST.");
  console.log("");
})();
