const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { PluginManager } = require("../core/dist/plugins");
const { BasePlugin } = require("../core/dist/plugins/BasePlugin");

class MockPlugin extends BasePlugin {
	constructor(name, priority = 0, options = {}) {
		super();
		this.name = name;
		this.priority = priority;
		this.canStream = options.canStream ?? true;
		this.canFallback = options.canFallback ?? false;
		this.matchUrl = options.matchUrl ?? false;
		this.fallbackScore = options.fallbackScore ?? 0.8;
		this.calls = [];
	}

	validate(url) {
		return Boolean(this.matchUrl && url && url.includes(this.name));
	}

	canHandle(query) {
		return Boolean(query && query.includes(this.name));
	}

	async getStream(track) {
		this.calls.push({ method: "getStream", track });
		if (!this.canStream) return null;
		return {
			stream: Readable.from([Buffer.from(`stream-from-${this.name}`)]),
			type: "arbitrary",
		};
	}

	async getFallback(track) {
		this.calls.push({ method: "getFallback", track });
		if (!this.canFallback) return null;
		return {
			stream: Readable.from([Buffer.from(`fallback-from-${this.name}`)]),
			type: "arbitrary",
			metadata: { title: track.title },
		};
	}
}

test("deterministic getAll ordering: priority DESC, registration ASC tie-break", () => {
	const pm = new PluginManager();
	const pA = new MockPlugin("A", 10);
	const pB = new MockPlugin("B", 20);
	const pC = new MockPlugin("C", 10);
	const pD = new MockPlugin("D", 0);
	const pE = new MockPlugin("E", 20);

	pm.register(pA); // index 0, prio 10
	pm.register(pB); // index 1, prio 20
	pm.register(pC); // index 2, prio 10
	pm.register(pD); // index 3, prio 0
	pm.register(pE); // index 4, prio 20

	const names = pm.getAll().map((p) => p.name);
	// Priority 20: B (reg 1), E (reg 4)
	// Priority 10: A (reg 0), C (reg 2)
	// Priority 0: D (reg 3)
	assert.deepEqual(names, ["B", "E", "A", "C", "D"]);
});

test("provenance priority: Track.source owner is tried first even with lowest priority", async () => {
	const pm = new PluginManager({ enableCache: false });
	const slowSource = new MockPlugin("slow-source", 0, { matchUrl: true, canStream: true });
	const highPrio = new MockPlugin("high-prio", 100, { matchUrl: true, canStream: true });

	pm.register(highPrio);
	pm.register(slowSource);

	const track = {
		title: "Test Track",
		url: "https://slow-source.com/song",
		source: "slow-source",
	};

	const stream = await pm.getStream(track, { fresh: true });
	assert.ok(stream);
	assert.equal(slowSource.calls.length, 1);
	assert.equal(highPrio.calls.length, 0); // highPrio should never be touched!
});

test("fallback ordering: if provenance owner fails, fallback follows priority DESC then registration ASC", async () => {
	const pm = new PluginManager({ enableCache: false, maxFallbackAttempts: 5 });
	const brokenSource = new MockPlugin("broken-source", 0, { matchUrl: true, canStream: false });
	const fb1 = new MockPlugin("fb1", 10, { canFallback: false });
	const fb2 = new MockPlugin("fb2", 50, { canFallback: false });
	const fb3 = new MockPlugin("fb3", 50, { canFallback: true });
	const fb4 = new MockPlugin("fb4", 10, { canFallback: true });

	pm.register(brokenSource);
	pm.register(fb1); // index 1, prio 10
	pm.register(fb2); // index 2, prio 50 (fails)
	pm.register(fb3); // index 3, prio 50 (succeeds)
	pm.register(fb4); // index 4, prio 10

	const track = {
		title: "Broken Track",
		url: "https://broken-source.com/song",
		source: "broken-source",
	};

	const stream = await pm.getStream(track, { fresh: true });
	assert.ok(stream);

	// brokenSource was called first for direct stream, then fallback
	assert.equal(brokenSource.calls.length, 2);
	assert.equal(brokenSource.calls[0].method, "getStream");
	assert.equal(brokenSource.calls[1].method, "getFallback");
	// fb2 was called next (priority 50, reg index 2)
	assert.equal(fb2.calls.length, 1);
	assert.equal(fb2.calls[0].method, "getFallback");
	// fb3 was called next (priority 50, reg index 3) and succeeded
	assert.equal(fb3.calls.length, 1);
	// fb1 and fb4 should not be called because fb3 already resolved
	assert.equal(fb1.calls.length, 0);
	assert.equal(fb4.calls.length, 0);
});

test("candidate selection when track has no source: priority DESC then registration ASC", async () => {
	const pm = new PluginManager({ enableCache: false });
	const cand1 = new MockPlugin("cand1", 10, { matchUrl: true, canStream: true });
	const cand2 = new MockPlugin("cand2", 10, { matchUrl: true, canStream: true });

	pm.register(cand1); // index 0, prio 10
	pm.register(cand2); // index 1, prio 10

	const track = {
		title: "No Source Track",
		url: "https://cand1.com/cand2.com/song",
	};

	const stream = await pm.getStream(track, { fresh: true });
	assert.ok(stream);
	// cand1 should be chosen because it has earlier registration
	assert.equal(cand1.calls.length, 1);
	assert.equal(cand2.calls.length, 0);
});

test("missing source fallback: Track.source not registered falls back to candidates by priority/registration", async () => {
	const pm = new PluginManager({ enableCache: false });
	const pLow = new MockPlugin("low", 5, { canFallback: true });
	const pHigh = new MockPlugin("high", 25, { canFallback: true });

	pm.register(pLow);
	pm.register(pHigh);

	const track = {
		title: "Ghost Source Track",
		url: "https://unknown.com/song",
		source: "unregistered-source",
	};

	const stream = await pm.getStream(track, { fresh: true });
	assert.ok(stream);
	// pHigh (priority 25) should be attempted before pLow (priority 5)
	assert.equal(pHigh.calls.length, 1);
	assert.equal(pLow.calls.length, 0);
});

test("decoupled PluginManager: can be created and resolve related tracks with context without Player", async () => {
	let debugMsg = "";
	const pm = new PluginManager({
		extractorTimeout: 3000,
		debug: (msg) => {
			debugMsg = msg;
		},
	});

	class RelatedPlugin extends BasePlugin {
		constructor() {
			super();
			this.name = "related-plug";
			this.priority = 10;
		}
		async getRelatedTracks(track, options) {
			assert.ok(options.history);
			assert.equal(options.history.length, 1);
			assert.equal(options.history[0].title, "History Track");
			return [
				{
					title: "Similar Song",
					author: "Same Artist",
					url: "https://music/similar",
					duration: 180000,
				},
			];
		}
	}

	const plug = new RelatedPlugin();
	pm.register(plug);

	pm.debug("Testing decoupled debug callback");
	assert.match(debugMsg, /Testing decoupled debug callback/);

	const currentTrack = {
		title: "Current Song",
		author: "Same Artist",
		url: "https://music/current",
		duration: 180000,
	};
	const historyTrack = {
		title: "History Track",
		author: "Other Artist",
		url: "https://music/history",
		duration: 180000,
	};

	const related = await pm.getRelatedTracks(currentTrack, { history: [historyTrack] });
	assert.equal(related.length, 1);
	assert.equal(related[0].title, "Similar Song");
});
