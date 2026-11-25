"use strict";

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var jwt = require("jsonwebtoken");
var fs = require("fs");
var path = require("path");

var PORT = process.env.PORT || 3000;
var TEAM_ID = process.env.APPLE_TEAM_ID || "QN6DJ39GCZ";
var KEY_ID = process.env.APPLE_KEY_ID || "FM4R5UXR97";
var STOREFRONT = (process.env.APPLE_STOREFRONT || "us").toLowerCase();
var PRIVATE_KEY_FILE = process.env.APPLE_PRIVATE_KEY_FILE ||
  path.join(__dirname, "AuthKey_FM4R5UXR97.p8");
var PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY
  ? process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : (fs.existsSync(PRIVATE_KEY_FILE) ? fs.readFileSync(PRIVATE_KEY_FILE, "utf8") : "");
var ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(function (s) {
  return s.trim();
}).filter(Boolean);

var cache = new Map();
var CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000);
var CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 1000);
var tokenCache = { value: "", expiresAt: 0 };
var inflight = new Map();

function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!PRIVATE_KEY) throw new Error("APPLE_PRIVATE_KEY is not configured.");

  /* Apple rejects a token whose `iat` is even slightly in the future, which a
   * clock skew of a second or two is enough to cause — and the symptom is a
   * 401 that clears on a later request. Backdating `iat` and setting `exp`
   * explicitly removes that whole class of failure. */
  var issuedAt = Math.floor(Date.now() / 1000) - 5;
  var expiresAt = issuedAt + 180 * 24 * 60 * 60;
  tokenCache.value = jwt.sign({ iat: issuedAt, exp: expiresAt }, PRIVATE_KEY, {
    algorithm: "ES256",
    issuer: TEAM_ID,
    noTimestamp: true,
    header: { alg: "ES256", kid: KEY_ID },
  });
  tokenCache.expiresAt = (issuedAt + 179 * 24 * 60 * 60) * 1000;
  return tokenCache.value;
}

function cacheGet(key) {
  var hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value: value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function appleFetch(path) {
  var key = STOREFRONT + ":" + path;
  var cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);
  if (inflight.has(key)) return inflight.get(key);

  function call(retries) {
    var token = getToken();
    var url = "https://api.music.apple.com/v1/catalog/" + STOREFRONT + path;
    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, 15000);
    return fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    }).then(function (res) {
      clearTimeout(timeout);
      return res.json().catch(function () { return null; }).then(function (body) {
        if (res.status === 401 && retries > 0) {
          tokenCache = { value: "", expiresAt: 0 };
          /* Small pause before retrying: a 401 often arrives because the token
           * was issued in the same second it was first used. */
          return new Promise(function (resolve) {
            setTimeout(resolve, 300);
          }).then(function () {
            return call(retries - 1);
          });
        }
        if ((res.status === 429 || res.status >= 500) && retries > 0) {
          var wait = res.status === 429
            ? (Number(res.headers.get("retry-after")) || 2) * 1000
            : 750;
          return new Promise(function (resolve) {
            setTimeout(resolve, wait);
          }).then(function () {
            return call(retries - 1);
          });
        }
        if (!res.ok) {
          var message = body && body.errors && body.errors[0] && body.errors[0].detail
            ? body.errors[0].detail
            : "Apple Music API error " + res.status;
          var err = new Error(message);
          err.status = res.status;
          throw err;
        }
        cacheSet(key, body);
        return body;
      });
    }).catch(function (err) {
      clearTimeout(timeout);
      if (err && err.name === "AbortError") {
        err.status = 504;
        err.message = "Apple Music request timed out.";
      }
      throw err;
    });
  }
  var promise = call(3);
  inflight.set(key, promise);
  promise.then(function () {
    inflight.delete(key);
  }, function () {
    inflight.delete(key);
  });
  return promise;
}

var app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({
  origin: ALLOWED_ORIGINS.indexOf("*") !== -1 ? true : ALLOWED_ORIGINS,
}));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 240),
  standardHeaders: true,
  legacyHeaders: false,
}));

app.get("/health", function (req, res) {
  res.json({
    ok: !!PRIVATE_KEY,
    service: "apple-music-catalog",
    configured: !!PRIVATE_KEY,
    storefront: STOREFRONT,
    cacheEntries: cache.size,
  });
});

app.get("/search", function (req, res) {
  var term = String(req.query.term || "").trim();
  var types = req.query.types || "artists";
  var limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 5));
  if (!term) return res.status(400).json({ error: "Missing term parameter." });
  appleFetch("/search?" + new URLSearchParams({
    term: term,
    types: types,
    limit: String(limit),
  }).toString()).then(function (body) {
    res.json(body);
  }).catch(function (err) {
    res.status(err.status || 502).json({ error: err.message });
  });
});

app.get("/artists/:id", function (req, res) {
  appleFetch("/artists/" + encodeURIComponent(req.params.id)).then(function (body) {
    res.json(body);
  }).catch(function (err) {
    res.status(err.status || 502).json({ error: err.message });
  });
});

app.get("/artists/:id/top-songs", function (req, res) {
  var limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 25));
  appleFetch("/artists/" + encodeURIComponent(req.params.id) +
    "/view/top-songs?limit=" + limit).then(function (body) {
    res.json(body);
  }).catch(function (err) {
    res.status(err.status || 502).json({ error: err.message });
  });
});

app.get("/artists/:id/albums", function (req, res) {
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
  var offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  appleFetch("/artists/" + encodeURIComponent(req.params.id) +
    "/albums?limit=" + limit + "&offset=" + offset).then(function (body) {
    res.json(body);
  }).catch(function (err) {
    res.status(err.status || 502).json({ error: err.message });
  });
});

app.get("/albums/:id/tracks", function (req, res) {
  appleFetch("/albums/" + encodeURIComponent(req.params.id) +
    "/tracks?limit=100").then(function (body) {
    res.json(body);
  }).catch(function (err) {
    res.status(err.status || 502).json({ error: err.message });
  });
});

app.use(function (req, res) {
  res.status(404).json({ error: "Unknown endpoint." });
});

app.listen(PORT, function () {
  console.log("apple-music-catalog listening on port " + PORT);
  if (!PRIVATE_KEY) console.warn("APPLE_PRIVATE_KEY is not configured.");
});
