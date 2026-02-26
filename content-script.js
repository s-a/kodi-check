const api = globalThis.browser ?? globalThis.chrome;

const STATE = {
	inspectMode: false,
	lastEl: null,
	timer: null,
	reqSeq: 0,
	overlay: null,
	badge: null,
	tip: null,
	lastMouse: { x: 0, y: 0 },
	cache: new Map(), // key -> {ts, resp}
	cacheTtlMs: 5 * 60 * 1000
};

const DEBOUNCE_MS = 220;

function sendMessagePromise(message) {
	if (globalThis.browser?.runtime?.sendMessage) return globalThis.browser.runtime.sendMessage(message);
	return new Promise((resolve, reject) => {
		globalThis.chrome.runtime.sendMessage(message, (resp) => {
			const err = globalThis.chrome.runtime.lastError;
			if (err) reject(err);
			else resolve(resp);
		});
	});
}

function ensureUi() {
	if (STATE.overlay) return;

	const overlay = document.createElement("div");
	overlay.style.position = "fixed";
	overlay.style.zIndex = "2147483647";
	overlay.style.pointerEvents = "none";
	overlay.style.border = "2px solid rgba(255,255,0,0.95)";
	overlay.style.background = "rgba(255,255,0,0.08)";
	overlay.style.borderRadius = "6px";
	overlay.style.display = "none";
	overlay.style.boxSizing = "border-box";

	const badge = document.createElement("div");
	badge.textContent = "Medium: …";
	badge.style.position = "absolute";
	badge.style.left = "8px";
	badge.style.top = "8px";
	badge.style.padding = "3px 8px";
	badge.style.borderRadius = "999px";
	badge.style.font = "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
	badge.style.background = "rgba(60,60,60,0.92)";
	badge.style.color = "#fff";
	badge.style.boxShadow = "0 2px 10px rgba(0,0,0,0.25)";

	overlay.appendChild(badge);

	const tip = document.createElement("div");
	tip.style.position = "fixed";
	tip.style.zIndex = "2147483647";
	tip.style.pointerEvents = "none";
	tip.style.display = "none";
	tip.style.maxWidth = "720px";
	tip.style.whiteSpace = "pre-wrap";
	tip.style.padding = "10px 12px";
	tip.style.borderRadius = "10px";
	tip.style.background = "rgba(20,20,20,0.92)";
	tip.style.color = "#fff";
	tip.style.font = "12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace";
	tip.style.boxShadow = "0 10px 26px rgba(0,0,0,0.28)";
	tip.style.border = "1px solid rgba(255,255,255,0.08)";

	document.documentElement.appendChild(overlay);
	document.documentElement.appendChild(tip);

	STATE.overlay = overlay;
	STATE.badge = badge;
	STATE.tip = tip;
}

function setOverlay(state) {
	if (!STATE.overlay) return;
	if (state === "loading") {
		STATE.overlay.style.border = "2px solid rgba(255,255,0,0.95)";
		STATE.overlay.style.background = "rgba(255,255,0,0.08)";
	} else if (state === "ok") {
		STATE.overlay.style.border = "2px solid rgba(0,200,0,0.95)";
		STATE.overlay.style.background = "rgba(0,200,0,0.08)";
	} else {
		STATE.overlay.style.border = "2px solid rgba(220,0,0,0.95)";
		STATE.overlay.style.background = "rgba(220,0,0,0.08)";
	}
}

function setBadgeLoading() {
	if (!STATE.badge) return;
	STATE.badge.textContent = "Medium: …";
	STATE.badge.style.background = "rgba(60,60,60,0.92)";
}

function setBadgeResult(found, total) {
	if (!STATE.badge) return;
	if (found) {
		STATE.badge.textContent = `Medium: ✓ (${total})`;
		STATE.badge.style.background = "rgba(0,140,0,0.92)";
	} else {
		STATE.badge.textContent = "Medium: ✗";
		STATE.badge.style.background = "rgba(180,0,0,0.92)";
	}
}

function showTip(text) {
	ensureUi();
	STATE.tip.textContent = text;
	STATE.tip.style.display = "block";
	placeTip(STATE.lastMouse.x, STATE.lastMouse.y);
}

function placeTip(x, y) {
	if (!STATE.tip || STATE.tip.style.display === "none") return;
	const pad = 16;
	STATE.tip.style.left = `${Math.min(x + pad, window.innerWidth - 60)}px`;
	STATE.tip.style.top = `${Math.min(y + pad, window.innerHeight - 60)}px`;
}

function hideUi() {
	if (STATE.overlay) STATE.overlay.style.display = "none";
	if (STATE.tip) STATE.tip.style.display = "none";
	STATE.lastEl = null;
	if (STATE.timer) clearTimeout(STATE.timer);
	STATE.timer = null;
}

function showOverlayFor(el) {
	ensureUi();
	const r = el.getBoundingClientRect();
	if (r.width <= 0 || r.height <= 0) {
		STATE.overlay.style.display = "none";
		return;
	}
	STATE.overlay.style.left = `${Math.max(0, r.left)}px`;
	STATE.overlay.style.top = `${Math.max(0, r.top)}px`;
	STATE.overlay.style.width = `${Math.max(0, r.width)}px`;
	STATE.overlay.style.height = `${Math.max(0, r.height)}px`;
	STATE.overlay.style.display = "block";
}

function extractQueryText(el) {
	let cur = el;
	for (let i = 0; i < 7 && cur; i++) {
		const t = (cur.innerText || cur.textContent || "").replace(/\s+/g, " ").trim();
		if (t) {
			return t.length > 220 ? t.slice(0, 220).trim() : t;
		}
		cur = cur.parentElement;
	}
	return "";
}

function cacheGet(key) {
	const v = STATE.cache.get(key);
	if (!v) return null;
	if (Date.now() - v.ts > STATE.cacheTtlMs) {
		STATE.cache.delete(key);
		return null;
	}
	return v.resp;
}

function cacheSet(key, resp) {
	STATE.cache.set(key, { ts: Date.now(), resp });
}

function formatTooltip(query, resp) {
	if (!resp?.ok) return `"${query}"\nFehler: ${resp?.error ?? "Unbekannt"}`;

	const statusLine = resp.found
		? `Status: FOUND (${resp.total})`
		: `Status: missing`;

	const lines = [];
	lines.push(`"${resp.query}"`);
	lines.push(statusLine);

	// kleine Transparenzhilfe (kein Split-Status, nur “was wurde gesucht”)
	if (resp.used?.audio || resp.used?.video) {
		const a = resp.used.audio ? `audio="${resp.used.audio}"` : "";
		const v = resp.used.video ? `video="${resp.used.video}"` : "";
		const uv = [a, v].filter(Boolean).join("  ");
		if (uv) lines.push(`Query: ${uv}`);
	}

	if (Array.isArray(resp.items) && resp.items.length) {
		lines.push("");
		lines.push("Treffer:");
		for (const it of resp.items.slice(0, 8)) lines.push(`- ${it}`);
	}

	return lines.join("\n");
}

async function runCheck(query, seq, isManual = false) {
	// Cache zuerst (UX: sofortiges Ergebnis bei wiederholtem Hover)
	const cached = cacheGet(query);
	if (cached) {
		if (!isManual) {
			setOverlay(cached.ok && cached.found ? "ok" : (cached.ok ? "missing" : "missing"));
			setBadgeResult(!!cached.found, cached.total ?? 0);
		} else {
			STATE.overlay.style.display = "none"; // Bei manueller Suche Overlay verstecken
		}
		showTip(formatTooltip(query, cached));
		return;
	}

	if (!isManual) {
		setOverlay("loading");
		setBadgeLoading();
	} else {
		STATE.overlay.style.display = "none"; // Bei manueller Suche Overlay verstecken
	}
	showTip(`"${query}"\nStatus: …`);

	const resp = await sendMessagePromise({ type: "CHECK_MEDIUM", text: query })
		.catch((e) => ({ ok: false, error: String(e?.message || e) }));

	if (seq !== STATE.reqSeq) return;
	if (!STATE.inspectMode && !isManual) return;

	if (resp?.ok) cacheSet(query, resp);

	const ok = !!resp?.ok;
	const found = !!resp?.found;
	const total = Number(resp?.total ?? 0);

	if (!isManual) {
		setOverlay(ok ? (found ? "ok" : "missing") : "missing");
		setBadgeResult(found, total);
	}
	showTip(formatTooltip(query, resp));
}

function scheduleCheck(el, query, isManual = false) {
	if (STATE.timer) clearTimeout(STATE.timer);
	const seq = ++STATE.reqSeq;

	STATE.timer = setTimeout(() => {
		if (!STATE.inspectMode && !isManual) return;
		if (!isManual && STATE.lastEl !== el) return;
		if (!query) return;
		runCheck(query, seq, isManual);
	}, DEBOUNCE_MS);
}

// F8 toggelt Modus nur per keydown (kein keyup)
document.addEventListener("keydown", (e) => {
	if (e.key === "F8" && !e.repeat) {
		e.preventDefault();
		e.stopPropagation();

		STATE.inspectMode = !STATE.inspectMode;

		if (STATE.inspectMode) {
			ensureUi();
			showTip("Inspect-Modus: ON");
			setOverlay("loading");
			setBadgeLoading();
		} else {
			hideUi();
		}
	} else if (e.key === "F9" && !e.repeat) { // Neue Option: F9 für manuelle Suche
		e.preventDefault();
		e.stopPropagation();

		const manualQuery = window.prompt("Manuelle Suche: Geben Sie den Text ein (z.B. Filmname oder Titel - Artist):");
		if (manualQuery && manualQuery.trim()) {
			ensureUi();
			STATE.lastEl = null; // Kein Element, Overlay verstecken
			scheduleCheck(null, manualQuery.trim(), true); // isManual=true
		}
	}
}, true);

document.addEventListener("mousemove", (e) => {
	STATE.lastMouse.x = e.clientX;
	STATE.lastMouse.y = e.clientY;

	if (!STATE.inspectMode) return;

	placeTip(e.clientX, e.clientY);

	const el = document.elementFromPoint(e.clientX, e.clientY);
	if (!el) return;

	if (el !== STATE.lastEl) {
		STATE.lastEl = el;
		showOverlayFor(el);

		const query = extractQueryText(el);

		setOverlay("loading");
		setBadgeLoading();

		if (query) {
			showTip(`"${query}"\nStatus: …`);
			scheduleCheck(el, query);
		} else {
			showTip("(kein Text)");
			setOverlay("missing");
			setBadgeResult(false, 0);
		}
	}
});