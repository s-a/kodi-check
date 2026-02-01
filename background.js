/* background.js
   - Kodi JSON-RPC über HTTP:8080 + Basic Auth (wie PS1)
   - Liefert EINEN Medium-Status + Details (Trefferliste)
*/

const api = globalThis.browser ?? globalThis.chrome;

const KODI = {
	url: "http://192.168.178.44:8080/jsonrpc",
	user: "kodi",
	pass: "kodi",
	timeoutMs: 6500
};

const MAX_ITEMS = 6; // UX: genug Details, ohne Spam

(function assertHttpOnly() {
	const u = new URL(KODI.url);
	if (u.protocol !== "http:") throw new Error("Kodi URL muss http sein: " + KODI.url);
})();

function b64(str) {
	try { return btoa(str); }
	catch { return btoa(unescape(encodeURIComponent(str))); }
}
function authHeader(user, pass) {
	return "Basic " + b64(`${user}:${pass}`);
}

function normalizeText(input) {
	return String(input || "")
		.replace(/[\u2013\u2014\u2212\u2015]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u2026/g, "...")
		.replace(/\s+/g, " ")
		.trim();
}

function splitTitleArtist(raw) {
	const s = normalizeText(raw);
	const parts = s.split(/\s-\s/); // exakt " - "
	if (parts.length >= 2) {
		return { raw: s, title: parts[0].trim(), artist: parts.slice(1).join(" - ").trim() };
	}
	return { raw: s, title: s, artist: "" };
}

async function kodiJsonRpc(payload) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), KODI.timeoutMs);

	try {
		console.log("[BG] Kodi URL:", KODI.url, "method:", payload?.method);

		const res = await fetch(KODI.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Accept": "application/json",
				"Authorization": authHeader(KODI.user, KODI.pass)
			},
			body: JSON.stringify(payload),
			signal: ctrl.signal,
			cache: "no-store",
			redirect: "manual"
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status} ${res.statusText}${body ? " – " + body.slice(0, 200) : ""}`);
		}

		const json = await res.json();
		if (json?.error) throw new Error(`Kodi JSON-RPC: ${json.error.message ?? "unknown error"}`);
		return json.result;
	} finally {
		clearTimeout(timer);
	}
}

async function querySongs(candidate) {
	const result = await kodiJsonRpc({
		jsonrpc: "2.0",
		id: 1,
		method: "AudioLibrary.GetSongs",
		params: {
			filter: { operator: "contains", field: "title", value: candidate },
			properties: ["title", "artist", "album"],
			limits: { start: 0, end: MAX_ITEMS }
		}
	});

	const total = Number(result?.limits?.total ?? 0);
	const songs = Array.isArray(result?.songs) ? result.songs : [];
	return { total, songs };
}

async function queryMovies(candidate) {
	const result = await kodiJsonRpc({
		jsonrpc: "2.0",
		id: 1,
		method: "VideoLibrary.GetMovies",
		params: {
			filter: { operator: "contains", field: "title", value: candidate },
			properties: ["title", "year", "file"],
			limits: { start: 0, end: MAX_ITEMS }
		}
	});

	const total = Number(result?.limits?.total ?? 0);
	const movies = Array.isArray(result?.movies) ? result.movies : [];
	return { total, movies };
}

function formatSongItem(s) {
	const title = s?.title ?? "";
	const artist = Array.isArray(s?.artist) ? s.artist.join(", ") : (s?.artist ?? "");
	const album = s?.album ?? "";
	// Keine harte Typ-Differenz im Status; Details dürfen trotzdem erkennbar bleiben:
	// Icon ist rein informativ.
	return `♪ ${title}${artist ? " — " + artist : ""}${album ? " — " + album : ""}`.trim();
}

function formatMovieItem(m) {
	const title = m?.title ?? "";
	const year = m?.year ? ` (${m.year})` : "";
	const file = m?.file ? ` — ${m.file}` : "";
	return `🎬 ${title}${year}${file}`.trim();
}

function uniqNonEmpty(arr) {
	const seen = new Set();
	const out = [];
	for (const x of arr) {
		const v = normalizeText(x);
		if (!v) continue;
		const k = v.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(v);
	}
	return out;
}

async function checkMedium(rawText) {
	const parsed = splitTitleArtist(rawText);

	// Kandidatenlogik:
	// - Wenn "Title - Artist": für Audio primär Title, für Video primär Raw
	// - Fallbacks jeweils umgekehrt
	const audioCandidates = uniqNonEmpty([parsed.title, parsed.raw]);
	const videoCandidates = uniqNonEmpty([parsed.raw, parsed.title]);

	let audio = { total: 0, used: "", items: [] };
	for (const c of audioCandidates) {
		const r = await querySongs(c);
		audio.used = c;
		audio.total = r.total;
		audio.items = r.songs.map(formatSongItem);
		if (r.total > 0) break;
	}

	let video = { total: 0, used: "", items: [] };
	for (const c of videoCandidates) {
		const r = await queryMovies(c);
		video.used = c;
		video.total = r.total;
		video.items = r.movies.map(formatMovieItem);
		if (r.total > 0) break;
	}

	const total = (audio.total || 0) + (video.total || 0);
	const found = total > 0;

	// Details: zusammenführen, aber kompakt halten
	const items = []
		.concat(audio.items || [])
		.concat(video.items || [])
		.slice(0, MAX_ITEMS);

	return {
		ok: true,
		query: parsed.raw,
		found,
		total,
		used: {
			audio: audio.used,
			video: video.used
		},
		details: {
			// Für Debug/Transparenz (kein Status-Splitting im UI nötig)
			audioTotal: audio.total,
			videoTotal: video.total
		},
		items
	};
}

api.runtime.onMessage.addListener((msg) => {
	if (!msg || typeof msg !== "object") return;

	if (msg.type === "CHECK_MEDIUM") {
		return checkMedium(String(msg.text ?? "")).catch((e) => ({
			ok: false,
			error: String(e?.message || e)
		}));
	}
});
