/*
 * FLPlayer — in-terminal MP3 playback for Futureland Records over the
 * SyncTERM APC audio protocol (APC SyncTERM:... ST), with album-art
 * backdrop, synced lyrics, floating avatar sprites, and an audio-reactive
 * visualizer driven by real per-chunk features (RMS loudness + zero
 * crossing rate) computed while slicing.
 *
 * Protocol (canonical spec: src/conio/cterm.adoc + syncterm/audio_apc.c):
 *   Store   APC SyncTERM:C;S;<name>;<base64>          -> file into client cache
 *   Load    APC SyncTERM:A;Load;S=<slot>;<name>       -> libsndfile decode to patch
 *   Queue   APC SyncTERM:A;Queue;C=<ch>;S=<slot>      -> append patch to channel
 *   Flush   APC SyncTERM:A;Flush;C=<ch>[;O=<ms>]      -> clear channel (opt fade)
 *   Volume  APC SyncTERM:A;Volume;C=<ch>;V=<pct>[;T=<ms>]
 *   Update  APC SyncTERM:A;Update;C=<ch>              -> arm one-shot idle notify
 *   notify  CSI = 7 ; <ch> ; 0 n                      -> armed channel went idle
 *   query   APC SyncTERM:Q;libsndfile -> CSI = 7 ; 100 ; <0|1> n
 *
 * The client (SyncTERM's xp_sndfile) resamples anything libsndfile can
 * read up to 44.1 kHz stereo, so the door streams low-rate WAV as the
 * bandwidth lever. BBSproxy.py implements the same Store/Load/Queue/
 * Update dialect for iTerm2, so both terminals play. Detection ladder:
 * the libsndfile feature query answers on real SyncTERM; a silent
 * Update-armed probe chunk answers on any drain-notify-capable sink
 * (BBSproxy); otherwise audio is unavailable.
 *
 * Playback is a single-threaded paced loop (the door has no threads):
 * each iteration tops up the client's audio cushion (Store+Load+Queue
 * per chunk), pumps input (keys + CSI notify replies), and repaints the
 * overlay/visualizer. An armed Update firing while chunks remain means
 * underrun -> re-anchor the clock and re-prime the cushion (the same
 * closed-loop recovery lameboy's apc_audio.rs uses); firing after the
 * last chunk means the song finished.
 *
 * Screen (bottom-anchored; art is grid-rendered, centered and trimmed):
 *   1 .. H-8   album art (FLAnsiGrid) with floating avatar sprites
 *   H-7        glow strip (audio-reactive)
 *   H-6        synced lyric line
 *   H-5        glow strip (mirror)
 *   H-4..H-1   double-line box: title / progress+time+volume
 *   H          key hints
 */

namespace FLPlayer {

    // Self-provide the sbbsdefs constants (K_NONE etc). Synchronet's load()
    // executes into the CALLER'S scope: the door's IIFE loading sbbsdefs does
    // not make the constants visible out here — that only appeared to work
    // when an outer shell had already loaded them globally (ssh sessions via
    // future_shell). Fresh contexts (webv4 fTelnet path) crashed with
    // "K_NONE is not defined".
    load("sbbsdefs.js");

    // ---- tuning -------------------------------------------------------
    var CHUNK_MS = 300;          // clip length; also the pacing quantum
    var PREBUFFER = 3;           // chunks queued ahead of realtime
    var CHANNEL = 2;             // first APC-dedicated channel (0/1 are cterm's)
    var SLOTS = 8;               // patch slots cycled for chunk clips
    var PCM_RATE = 22050;        // transcode rate (client resamples to 44.1k)
    var PCM_CHANNELS = 2;        // stereo; halve bandwidth with 1 if needed
    var UI_TICK_MS = 150;        // overlay/visualizer repaint cadence
    var SEEK_SECONDS = 10;
    // Synchronet's console.inkey() COOKS recognized cursor keys into single
    // control bytes (see key_defs.js) rather than passing the raw ESC[ sequence,
    // so real arrow presses never reach the ESC-sequence decoder below. Map the
    // cooked codes to navigation here so every consumer sees arrows uniformly.
    // (KEY_DOWN is \x0a = '\n' — reading it as Enter is what made the song list's
    // Down arrow "play" the track.)
    var COOKED_NAV: { [ch: string]: string } = {
        "\x1e": "up", "\x0a": "down", "\x1d": "left", "\x06": "right",
        "\x10": "pgup", "\x0e": "pgdn", "\x02": "home", "\x05": "end"
    };
    var ART_WIDTH = 80;          // classic ANSI art wrap column
    var AVATAR_W = 10;           // Synchronet avatar cell dimensions
    var AVATAR_H = 6;

    // ---- shared state ---------------------------------------------------
    export type SinkKind = "syncterm" | "apc" | "none";
    var detectedSink: SinkKind | null = null;   // per-session cache

    export interface LyricLine {
        time: number;   // seconds
        text: string;
    }

    export interface PlayableTrack {
        path: string;       // mp3 on disk
        name: string;       // filename (cache key component)
        title: string;
        artist: string;
        size: number;
        mtime: number;
        ansiArt: string;    // raw CP437 .ans bytes ("" when absent)
        lyrics?: LyricLine[];   // timestamped (SYLT or .lrc); preferred
        flatLyrics?: string;    // untimed fallback, distributed over duration
        avatars?: string[];     // raw 10x6 BIN blobs (decoded), up to 2
        queueName?: string;     // playlist name when the queue IS a playlist ("" = radio/browse)
        queuePos?: number;      // 1-based position of this track in the queue
        queueLen?: number;      // queue length (for the "3/12" indicator)
    }

    export type PlayResult = "quit" | "next" | "prev" | "ended" | "error" | "browse" | "create" | "addplaylist" | "removeplaylist";

    // Track-shuffle toggle (S key). playInTerminal reads this when advancing:
    // on -> next track is random from the queue, off -> sequential. Shared here
    // so both the player (toggle/display) and the jukebox loop (advance) see it.
    export var shuffle = false;
    // Set whenever shuffle is switched ON (any off->on). playInTerminal consumes
    // it on the next advance to start a BRAND-NEW shuffle from position 1, rather
    // than resuming the old deck -- so shuffle->off->on gives a fresh shuffle.
    export var shuffleReset = false;

    // ---- small helpers --------------------------------------------------
    function shellQuote(s: string): string {
        return "'" + s.replace(/'/g, "'\\''") + "'";
    }

    function nowMs(): number {
        return new Date().getTime();
    }

    function clamp(v: number, lo: number, hi: number): number {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    function fmtTime(totalSeconds: number): string {
        var s = Math.max(0, Math.floor(totalSeconds));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ":" + (r < 10 ? "0" : "") + r;
    }

    function apc(payload: string): void {
        console.write("\x1b_SyncTERM:" + payload + "\x1b\\");
    }

    // ---- WAV plumbing ---------------------------------------------------
    // We always transcode to canonical PCM (pcm_s16le) with metadata
    // stripped, so the header is the fixed 44 bytes; the parser still walks
    // RIFF chunks and the reader grows its buffer, in case a pre-data chunk
    // ever appears anyway.

    function le16(v: number): string {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
    }

    function le32(v: number): string {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    }

    function rd16(s: string, o: number): number {
        return (s.charCodeAt(o) & 0xff) | ((s.charCodeAt(o + 1) & 0xff) << 8);
    }

    function rd32(s: string, o: number): number {
        return ((s.charCodeAt(o) & 0xff)) +
            ((s.charCodeAt(o + 1) & 0xff) * 0x100) +
            ((s.charCodeAt(o + 2) & 0xff) * 0x10000) +
            ((s.charCodeAt(o + 3) & 0xff) * 0x1000000);
    }

    export function wavHeader(dataBytes: number, rate: number, channels: number): string {
        var blockAlign = channels * 2;
        var byteRate = rate * blockAlign;
        return "RIFF" + le32(36 + dataBytes) + "WAVE" +
            "fmt " + le32(16) + le16(1) + le16(channels) +
            le32(rate) + le32(byteRate) + le16(blockAlign) + le16(16) +
            "data" + le32(dataBytes);
    }

    export interface WavInfo {
        rate: number;
        channels: number;
        dataOffset: number;
        dataBytes: number;
    }

    /** Parse the header, growing the read until the data chunk is in view
     *  (metadata LIST chunks can push it well past 512 bytes). */
    export function readWavInfo(f: File): WavInfo | null {
        var want = 512;
        for (; ;) {
            f.position = 0;
            var head = f.read(want);
            if (!head || head.length < 44)
                return null;
            var info = parseWavHeader(head, f.length);
            if (info)
                return info;
            if (head.length < want || want >= 65536)
                return null;    // whole file scanned (or cap hit): truly bad
            want *= 4;
        }
    }

    export function parseWavHeader(head: string, fileLength: number): WavInfo | null {
        if (head.length < 44 || head.substr(0, 4) !== "RIFF" || head.substr(8, 4) !== "WAVE")
            return null;
        var rate = 0;
        var channels = 0;
        var off = 12;
        while (off + 8 <= head.length) {
            var id = head.substr(off, 4);
            var len = rd32(head, off + 4);
            if (id === "fmt " && off + 8 + 16 <= head.length) {
                channels = rd16(head, off + 10);
                rate = rd32(head, off + 12);
            } else if (id === "data") {
                if (!rate || !channels)
                    return null;
                var avail = fileLength - (off + 8);
                return {
                    rate: rate,
                    channels: channels,
                    dataOffset: off + 8,
                    dataBytes: Math.min(len, avail < 0 ? 0 : avail)
                };
            }
            off += 8 + len + (len & 1);
        }
        return null;
    }

    // ---- transcode cache ------------------------------------------------
    function pcmDir(): string {
        return backslash(js.exec_dir) + "data/pcm";
    }

    export function ffmpegAvailable(): boolean {
        var out = system.popen("which ffmpeg 2>/dev/null");
        return !!(out && out.length && out[0].length);
    }

    /** Transcode (once) to the canonical low-rate WAV; returns its path or null. */
    export function ensureTranscoded(track: PlayableTrack): string | null {
        var key = md5_calc(track.name + ":" + track.size + ":" + track.mtime +
            ":v2:" + PCM_RATE + "x" + PCM_CHANNELS, true);
        var out = pcmDir() + "/" + key + ".wav";
        if (file_exists(out) && file_size(out) > 44)
            return out;
        if (!mkpath(pcmDir()))
            return null;
        // -map_metadata -1 + -bitexact: no RIFF LIST/INFO chunks, so the
        // header is the canonical 44 bytes (a fat ID3 comment once pushed the
        // data chunk past the header read and broke playback).
        var cmd = "ffmpeg -v quiet -y -i " + shellQuote(track.path) +
            " -map_metadata -1 -bitexact" +
            " -ar " + PCM_RATE + " -ac " + PCM_CHANNELS +
            " -c:a pcm_s16le -f wav " + shellQuote(out) + " </dev/null";
        system.exec(cmd);
        if (file_exists(out) && file_size(out) > 44)
            return out;
        return null;
    }

    // ---- terminal input: keys + CSI audio notifications -------------------
    export interface PumpResult {
        keys: string[];       // plain keys, uppercased ("Q", " ", "\r"...)
        arrows: string[];     // "up" | "down" | "left" | "right"
        esc: boolean;         // lone ESC key
        audio: number[][];    // [id, state] pairs from CSI =7;...n reports
        cpr: number[][];      // [rows, cols] cursor-position reports (size probe)
        other: string[];      // CSI sequences we do not handle (diagnostics)
    }

    function parseAudioBody(parts: string[], res: PumpResult): void {
        for (var i = 1; i + 1 < parts.length + 1; i += 2) {
            var id = parseInt(parts[i], 10);
            var st = parseInt(parts[i + 1], 10);
            if (!isNaN(id) && !isNaN(st))
                res.audio.push([id, st]);
        }
    }

    export class InputPump {
        private buf: string = "";
        private escAt: number = 0;     // when a lone ESC started waiting
        private bracketAt: number = 0; // when a possible orphaned tail started waiting

        /** Poll for up to maxMs, decoding everything that arrives. */
        pump(maxMs: number): PumpResult {
            var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
            var deadline = nowMs() + maxMs;
            do {
                var k = console.inkey(K_NONE, 10);
                while (typeof k === "string" && k.length) {
                    this.buf += k;
                    k = console.inkey(K_NONE, 0);
                }
                this.drain(res, false);
            } while (nowMs() < deadline);
            this.drain(res, true);
            return res;
        }

        private drain(res: PumpResult, idle: boolean): void {
            for (; ;) {
                if (!this.buf.length)
                    return;
                var c = this.buf.charAt(0);
                if (c !== "\x1b") {
                    var nav = COOKED_NAV[c];
                    if (nav) {
                        res.arrows.push(nav);
                        this.buf = this.buf.substr(1);
                        continue;
                    }
                    // Orphaned reply tails: the engine's getdimensions() reader
                    // can consume the ESC of an in-flight notify while hunting
                    // its own CPR answer, leaving "[=7;2;0n" as bare text whose
                    // trailing 'n' reads as a phantom [N]ext (flight-recorder
                    // confirmed). Recognize the two known reply shapes before
                    // treating '[' as a keystroke.
                    if (c === "[") {
                        var oa = /^\[(=7[0-9;]*)n/.exec(this.buf);
                        if (oa) {
                            parseAudioBody(oa[1].substr(2).split(";"), res);
                            this.buf = this.buf.substr(oa[0].length);
                            this.bracketAt = 0;
                            continue;
                        }
                        var oc = /^\[(\d{1,4});(\d{1,4})R/.exec(this.buf);
                        if (oc) {
                            res.cpr.push([parseInt(oc[1], 10), parseInt(oc[2], 10)]);
                            this.buf = this.buf.substr(oc[0].length);
                            this.bracketAt = 0;
                            continue;
                        }
                        // Could still be an incomplete orphan: wait briefly.
                        if (/^\[[=0-9;]{0,12}$/.test(this.buf)) {
                            if (!idle)
                                return;
                            if (!this.bracketAt) {
                                this.bracketAt = nowMs();
                                return;
                            }
                            if (nowMs() - this.bracketAt < 250)
                                return;
                            // Aged out: it really is a '[' keystroke.
                        }
                        this.bracketAt = 0;
                    }
                    res.keys.push(c.toUpperCase());
                    this.buf = this.buf.substr(1);
                    continue;
                }
                // ESC ...: need at least ESC [ + final byte to decode a CSI.
                if (this.buf.length === 1) {
                    // A lone ESC is only the Esc KEY once it has sat
                    // unextended for a real interval. Resolving it at every
                    // pump boundary shredded async CSI replies that straddled
                    // the window: the ESC read as quit, and the tail arrived
                    // as plain chars — the 'n' of a drain notify became a
                    // phantom [N]ext (and skipped several tracks).
                    if (idle) {
                        if (!this.escAt) {
                            this.escAt = nowMs();
                        } else if (nowMs() - this.escAt >= 250) {
                            res.esc = true;
                            this.buf = "";
                            this.escAt = 0;
                        }
                    }
                    return;
                }
                this.escAt = 0;       // ESC got a continuation: a real sequence
                // SS3 / application-cursor arrows: ESC O A/B/C/D. Some SyncTERM
                // modes send these instead of CSI ESC[A; without this they fell
                // through as a bare Esc (= quit) plus a stray letter.
                if (this.buf.charAt(1) === "O") {
                    if (this.buf.length < 3)
                        return;           // wait for the final byte (may be split)
                    var ss3 = this.buf.charAt(2);
                    if (ss3 >= "A" && ss3 <= "D") {
                        res.arrows.push(ss3 === "A" ? "up" : ss3 === "B" ? "down" :
                            ss3 === "C" ? "right" : "left");
                        this.buf = this.buf.substr(3);
                        continue;
                    }
                    // ESC O <other>: not an arrow, fall through to Esc handling.
                }
                if (this.buf.charAt(1) !== "[") {
                    res.esc = true;       // ESC + non-CSI: treat as Esc, re-scan rest
                    this.buf = this.buf.substr(1);
                    continue;
                }
                var m = /^\x1b\[([0-9;=?]*)([@-~])/.exec(this.buf);
                if (!m) {
                    if (idle && this.buf.length > 24)
                        this.buf = "";    // malformed: don't wedge
                    return;               // incomplete CSI: wait for more bytes
                }
                this.buf = this.buf.substr(m[0].length);
                var body = m[1];
                var fin = m[2];
                if (fin === "n" && body.substr(0, 2) === "=7") {
                    // "=7;a;b[;c;d...]n" -> leading empty from ";a" split
                    parseAudioBody(body.substr(2).split(";"), res);
                } else if (fin === "R") {
                    var rc = body.split(";");
                    var pr = parseInt(rc[0], 10);
                    var pc = parseInt(rc[1], 10);
                    if (!isNaN(pr) && !isNaN(pc))
                        res.cpr.push([pr, pc]);
                } else if (fin === "A") {
                    res.arrows.push("up");
                } else if (fin === "B") {
                    res.arrows.push("down");
                } else if (fin === "C") {
                    res.arrows.push("right");
                } else if (fin === "D") {
                    res.arrows.push("left");
                } else {
                    // Unhandled CSI: recorded so diagnostics can see what a
                    // terminal is REALLY sending (kitty-mode keys, mouse...).
                    res.other.push("[" + body + fin);
                }
            }
        }
    }

    // ---- flight recorder (armed by data/player-debug.on) -------------------
    var dbgChecked = false;
    var dbgOn = false;

    export function dbg(line: string): void {
        if (!dbgChecked) {
            dbgChecked = true;
            dbgOn = file_exists(backslash(js.exec_dir) + "data/player-debug.on");
        }
        if (!dbgOn)
            return;
        try {
            var f = new File(backslash(js.exec_dir) + "data/player-debug.log");
            if (f.open("a")) {
                f.writeln(new Date().getTime() + " " + line);
                f.close();
            }
        } catch (e) { }
    }

    function fmtPump(ev: PumpResult): string {
        var bits: string[] = [];
        if (ev.keys.length) bits.push("keys=" + ev.keys.join(""));
        if (ev.arrows.length) bits.push("arrows=" + ev.arrows.join(","));
        if (ev.esc) bits.push("ESC");
        for (var i = 0; i < ev.audio.length; i++)
            bits.push("audio=" + ev.audio[i][0] + ":" + ev.audio[i][1]);
        for (var c = 0; c < ev.cpr.length; c++)
            bits.push("cpr=" + ev.cpr[c][0] + "x" + ev.cpr[c][1]);
        for (var o = 0; o < ev.other.length; o++)
            bits.push("other=^" + ev.other[o]);
        return bits.join(" ");
    }

    // The ONE input pump. Detection, playback, and the between-tracks window
    // must all read through the same buffer: separate pump instances bisected
    // CSI replies at their hand-off boundaries (one pump holds "\x1b[=7;2",
    // the next reads ";0n" as plain chars — and that trailing 'n' was a
    // phantom [N]ext). A partial held here completes on the next pump call,
    // no matter which phase makes it.
    var sharedPump = new InputPump();

    /** Pump input through the shared buffer (for inter-track windows). */
    export function pumpShared(maxMs: number): PumpResult {
        return sharedPump.pump(maxMs);
    }

    // Read and normalize ONE key the proven in-process way (as future_shell
    // does). console.inkey returns a cursor key EITHER as a cooked control byte
    // OR as a whole ESC sequence -- CSI ("[A"/"[B") or SS3 ("OA"/"OB"). We map
    // every representation to the single cursor control code so callers match
    // one value. "" on timeout. K_NOECHO|K_NOSPIN so the wait neither echoes the
    // key nor spins a cursor (the mode the shell uses). This is for menus/browse
    // that have no live audio; the player still uses the pump (it must interleave
    // APC audio replies with keystrokes).
    // Normalize one raw inkey value to a single cursor code / plain key. Maps
    // every arrow representation Synchronet may deliver -- cooked control byte,
    // raw CSI ("[A"), raw SS3 ("OA") -- to the cursor code. Pure, so it's tested.
    export function normalizeKey(k: string): string {
        if (!k || !k.length) return "";
        if (k.charAt(0) === "\x1b" && k.length >= 2) {
            var seq = k.substr(1);
            if (seq === "[A" || seq === "OA") return "\x1e";                              // up
            if (seq === "[B" || seq === "OB") return "\x0a";                              // down
            if (seq === "[C" || seq === "OC") return "\x06";                              // right
            if (seq === "[D" || seq === "OD") return "\x1d";                              // left
            if (seq === "[H" || seq === "OH" || seq === "[1~" || seq === "[7~") return "\x02"; // home
            if (seq === "[F" || seq === "OF" || seq === "[4~" || seq === "[8~") return "\x05"; // end
            if (seq === "[5~") return "\x10";                                             // page up
            if (seq === "[6~") return "\x0e";                                             // page down
            return "";                       // other escape sequence (e.g. an APC reply) -> ignore
        }
        return k.charAt(0);                  // cooked cursor code or a plain key
    }

    export function readKey(ms: number): string {
        var k = console.inkey(K_NOECHO | K_NOSPIN, ms);
        if (typeof k !== "string" || !k.length) return "";
        if (k.length > 1) { dbg("readKey whole=" + JSON.stringify(k)); return normalizeKey(k); }
        if (k !== "\x1b") return k;          // cooked cursor code or a plain key
        // ESC: inkey here delivers the sequence byte-by-byte, so ASSEMBLE the
        // rest of a CSI ("[ ... final") or SS3 ("O <letter>") before deciding.
        // Without this the "[" and "B" of a down arrow leak in as typed text.
        var seq = "";
        for (var i = 0; i < 8; i += 1) {
            var c = console.inkey(K_NOECHO | K_NOSPIN, 60);
            if (typeof c !== "string" || !c.length) break;   // nothing more -> lone Esc/partial
            seq += c;
            if (seq.charAt(0) !== "[" && seq.charAt(0) !== "O") break;    // not an escape sequence
            if (seq.charAt(0) === "O") { if (seq.length >= 2) break; else continue; }
            if (seq.length >= 2) {                                        // CSI: stop at the final byte
                var last = seq.charAt(seq.length - 1);
                if (last >= "@" && last <= "~" && !(last >= "0" && last <= "9") && last !== ";") break;
            }
        }
        dbg("readKey ESC seq=" + JSON.stringify(seq));
        if (!seq.length) return "\x1b";       // a genuine lone Esc
        return normalizeKey("\x1b" + seq);
    }

    // ---- sink detection ---------------------------------------------------
    /**
     * Two-stage probe:
     *  1. APC SyncTERM:Q;libsndfile -> CSI =7;100;1 n  => real SyncTERM.
     *  2. Store+Load+Queue a ~60ms silent clip with Update armed; a
     *     CSI =7;<ch>;0 n drain notify => any APC sink (BBSproxy).
     * Cached for the session; pass force=true to redetect.
     */
    export function detectSink(force?: boolean): SinkKind {
        if (detectedSink !== null && !force)
            return detectedSink;
        var pumpr = sharedPump;
        var found: SinkKind = "none";

        apc("Q;libsndfile");
        var deadline = nowMs() + 700;
        while (nowMs() < deadline) {
            var r = pumpr.pump(50);
            for (var i = 0; i < r.audio.length; i++) {
                if (r.audio[i][0] === 100 && r.audio[i][1] === 1) {
                    found = "syncterm";
                    break;
                }
            }
            if (found !== "none")
                break;
        }

        if (found === "none") {
            // Silent probe clip: 60ms of zeros at the streaming format.
            var bytes = Math.floor(PCM_RATE * PCM_CHANNELS * 2 * 0.06);
            var silence = wavHeader(bytes, PCM_RATE, PCM_CHANNELS) +
                repeatByte("\x00", bytes);
            apc("C;S;flrprobe.wav;" + base64_encode(silence));
            apc("A;Load;S=0;flrprobe.wav");
            apc("A;Update;C=" + CHANNEL);
            apc("A;Queue;C=" + CHANNEL + ";S=0");
            deadline = nowMs() + 1200;
            while (nowMs() < deadline) {
                var r2 = pumpr.pump(60);
                for (var j = 0; j < r2.audio.length; j++) {
                    if (r2.audio[j][0] === CHANNEL && r2.audio[j][1] === 0) {
                        found = "apc";
                        break;
                    }
                }
                if (found !== "none")
                    break;
            }
        }

        detectedSink = found;
        return found;
    }

    function repeatByte(ch: string, count: number): string {
        var out = "";
        while (out.length < count)
            out += (out.length * 2 <= count && out.length) ? out : ch;
        return out.substr(0, count);
    }

    // ---- per-chunk audio features -----------------------------------------
    export function chunkFeatures(slice: string, channels: number): { rms: number; raw: number; zcr: number; lo: number; mid: number; hi: number } {
        var frames = Math.floor(slice.length / (channels * 2));
        if (frames < 2)
            return { rms: 0, raw: 0, zcr: 0, lo: 0, mid: 0, hi: 0 };
        // RMS (loudness): strided samples across the whole chunk.
        var points = 256;
        var step = Math.max(1, Math.floor(frames / points));
        var sumSq = 0;
        var count = 0;
        for (var f = 0; f < frames; f += step) {
            var v = rd16(slice, f * channels * 2);   // left channel
            if (v >= 0x8000)
                v -= 0x10000;
            sumSq += v * v;
            count++;
        }
        if (!count)
            return { rms: 0, raw: 0, zcr: 0, lo: 0, mid: 0, hi: 0 };
        var raw = Math.sqrt(sumSq / count) / 32768;
        // Perceptual-ish lift for METERS only: quiet music still moves them.
        // Beat/onset detection uses `raw` — the lift compresses loud passages
        // so hard that deltas vanish and beats never fire on hot mixes.
        var rms = Math.sqrt(clamp(raw * 3.2, 0, 1));
        // ZCR (brightness): must be measured over CONTIGUOUS samples — strided
        // points ~26ms apart are decorrelated and always read ~50% flips.
        var winFrames = Math.min(frames, 512);
        var start = Math.floor((frames - winFrames) / 2);
        var crossings = 0;
        var prev = 0;
        // Genuine 3-band energy from the SAME contiguous window: two one-pole
        // low-passes split the waveform into lows (<~300Hz) / mids / highs
        // (>~1.3kHz), so the equaliser reacts to real frequency content, not a
        // faked per-bar wobble. lp1/lp2 are the running low-passed signals.
        var lp1 = 0, lp2 = 0, eLo = 0, eMid = 0, eHi = 0;
        for (var w = 0; w < winFrames; w++) {
            var s = rd16(slice, (start + w) * channels * 2);
            if (s >= 0x8000)
                s -= 0x10000;
            if (w > 0 && ((s >= 0) !== (prev >= 0)))
                crossings++;
            prev = s;
            var sn = s / 32768;
            lp1 += (sn - lp1) * 0.08;              // heavy low-pass  -> bass
            lp2 += (sn - lp2) * 0.34;              // lighter low-pass -> bass+mid
            var bLo = lp1, bMid = lp2 - lp1, bHi = sn - lp2;
            eLo += bLo * bLo; eMid += bMid * bMid; eHi += bHi * bHi;
        }
        // crossings/frame *at the PCM rate*: ~0.02 = bassy, ~0.25+ = bright.
        var zcr = clamp((crossings / winFrames) * 5, 0, 1);
        // Band RMS with a per-band perceptual lift (upper bands carry less
        // energy, so they get a bigger multiplier to stay visible on the meter).
        var lo = clamp(Math.sqrt(eLo / winFrames) * 3.6, 0, 1);
        var mid = clamp(Math.sqrt(eMid / winFrames) * 6.5, 0, 1);
        var hi = clamp(Math.sqrt(eHi / winFrames) * 9.0, 0, 1);
        return { rms: rms, raw: raw, zcr: zcr, lo: lo, mid: mid, hi: hi };
    }

    // ---- synced lyrics -------------------------------------------------------
    /** Index of the lyric line active at `sec`, or -1. `fromIdx` makes the
     *  common forward walk O(1); it resets automatically after a back-seek. */
    export function lyricIndexFor(lyrics: LyricLine[], sec: number, fromIdx: number): number {
        if (!lyrics || !lyrics.length || sec < lyrics[0].time)
            return -1;
        var i = fromIdx >= 0 && fromIdx < lyrics.length && lyrics[fromIdx].time <= sec
            ? fromIdx : 0;
        while (i + 1 < lyrics.length && lyrics[i + 1].time <= sec)
            i++;
        return i;
    }

    /** Distribute untimed lyric text evenly across the song duration. */
    export function distributeLyrics(flat: string, totalSec: number): LyricLine[] {
        var lines: string[] = [];
        var parts = String(flat || "").split("\n");
        for (var i = 0; i < parts.length; i++) {
            var t = parts[i].replace(/^\s+|\s+$/g, "");
            if (t.length)
                lines.push(t);
        }
        var out: LyricLine[] = [];
        if (!lines.length || totalSec <= 0)
            return out;
        var span = totalSec / (lines.length + 1);
        for (var j = 0; j < lines.length; j++)
            out.push({ time: span * (j + 1), text: lines[j] });
        return out;
    }

    // ---- playback screen ----------------------------------------------------
    var CLR = "\x1b[0m";

    function sgr(codes: string): string {
        return "\x1b[" + codes + "m";
    }

    function gotoRC(row: number, col: number): string {
        return "\x1b[" + row + ";" + col + "H";
    }

    interface Layout {
        cols: number;
        rows: number;
        boxTop: number;    // first row of the overlay box (4 rows)
        boxLeft: number;
        boxWidth: number;
        glowRow1: number;  // strip above the lyric line
        lyricRow: number;
        lyricLeft: number; // lyric strip can be WIDER than the box on wide
        lyricWidth: number;// terminals with long lines (never narrower)
        glowRow2: number;  // strip below the lyric line
        artTop: number;    // art window: rows artTop .. artBottom (inclusive)
        artBottom: number;
    }

    // maxLyricLen (a track's longest line) lets the lyric strip grow past the
    // box on a wide terminal so long lines aren't ellipsized -- computed once
    // per track so the width is stable across lines, never shrinking the box.
    function layout(termCols?: number, termRows?: number, maxLyricLen?: number): Layout {
        var cols = Math.max(40, termCols || console.screen_columns || 80);
        var rows = Math.max(14, termRows || console.screen_rows || 24);
        var width = Math.min(cols - 2, 76);
        var lyricW = width;
        if (maxLyricLen && maxLyricLen + 2 > width)
            lyricW = Math.min(cols - 2, maxLyricLen + 2);
        return {
            cols: cols,
            rows: rows,
            boxTop: rows - 4,
            boxLeft: Math.max(1, Math.floor((cols - width) / 2) + 1),
            boxWidth: width,
            glowRow1: rows - 7,
            lyricRow: rows - 6,
            lyricLeft: Math.max(1, Math.floor((cols - lyricW) / 2) + 1),
            lyricWidth: lyricW,
            glowRow2: rows - 5,
            artTop: 1,
            artBottom: rows - 8
        };
    }

    // The art backdrop: grid-rendered, centered, trimmed. The blit descriptor
    // doubles as the backing store so sprites can restore what they fly over.
    interface ArtBlit {
        grid: FLAnsiGrid.Grid | null;
        left: number;      // screen col of blit origin (1-based)
        top: number;       // screen row of blit origin
        srcRow: number;    // first grid row shown
        srcCol: number;
        nRows: number;
        nCols: number;
        pal: number;       // FLAnsiGrid.PALETTES index currently shown
    }

    function makeArtBlit(track: PlayableTrack, l: Layout): ArtBlit {
        var blit: ArtBlit = {
            grid: null, left: 1, top: l.artTop,
            srcRow: 0, srcCol: 0, nRows: 0, nCols: 0, pal: 0
        };
        if (!track.ansiArt.length)
            return blit;
        var grid = FLAnsiGrid.render(FLAnsiGrid.stripSauce(track.ansiArt), ART_WIDTH);
        if (!grid.height)
            return blit;
        var availRows = l.artBottom - l.artTop + 1;
        var availCols = l.cols;
        blit.grid = grid;
        blit.nRows = Math.min(grid.height, availRows);
        blit.nCols = Math.min(grid.width, availCols);
        blit.srcRow = 0;                                  // trim bottom overflow
        blit.srcCol = Math.max(0, Math.floor((grid.width - blit.nCols) / 2));
        blit.top = l.artTop + Math.max(0, Math.floor((availRows - blit.nRows) / 2));
        blit.left = Math.max(1, Math.floor((availCols - blit.nCols) / 2) + 1);
        return blit;
    }

    function drawArt(blit: ArtBlit): void {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emit(blit.grid, blit.left, blit.top,
            blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, blit.pal));
    }

    /** Recolour the whole art by a full 16-colour rotation (BLACK pinned) --
     *  quick all-at-once cycles, like the avatar flash. */
    function drawArtFlash(blit: ArtBlit, rot: number): void {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emitFlash(blit.grid, blit.left, blit.top,
            blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, rot));
    }

    /** Render the art with a per-cell palette (for a spatial fill transition). */
    function drawArtWipe(blit: ArtBlit, palFor: (x: number, y: number) => number): void {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emitWipe(blit.grid, blit.left, blit.top,
            blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, palFor));
    }

    // Video-style wipe geometries. Given progress p (0..1) and the region bounds,
    // return true where the wipe has passed (the NEW side). One is chosen at
    // random per transition so wipes look different every time.
    interface WipeBounds { x0: number; x1: number; y0: number; y1: number; cx: number; cy: number; maxR: number; }
    var WIPES: ((x: number, y: number, p: number, b: WipeBounds) => boolean)[] = [
        function (x, y, p, b) { return (x - b.x0) <= p * (b.x1 - b.x0 + 1); },              // left -> right
        function (x, y, p, b) { return (b.x1 - x) <= p * (b.x1 - b.x0 + 1); },              // right -> left
        function (x, y, p, b) { return (y - b.y0) <= p * (b.y1 - b.y0 + 1); },              // top -> bottom
        function (x, y, p, b) { return (b.y1 - y) <= p * (b.y1 - b.y0 + 1); },              // bottom -> top
        function (x, y, p, b) {                                                              // diagonal TL -> BR
            return ((x - b.x0) / (b.x1 - b.x0 + 1) + (y - b.y0) / (b.y1 - b.y0 + 1)) * 0.5 <= p;
        },
        function (x, y, p, b) {                                                              // diagonal TR -> BL
            return ((b.x1 - x) / (b.x1 - b.x0 + 1) + (y - b.y0) / (b.y1 - b.y0 + 1)) * 0.5 <= p;
        },
        function (x, y, p, b) {                                                              // radial out
            var dx = (x - b.cx) * 0.5, dy = y - b.cy; return Math.sqrt(dx * dx + dy * dy) * 2 <= p * b.maxR;
        },
        function (x, y, p, b) {                                                              // radial in
            var dx = (x - b.cx) * 0.5, dy = y - b.cy; return Math.sqrt(dx * dx + dy * dy) * 2 >= (1 - p) * b.maxR;
        },
        function (x, y, p, b) { return Math.abs(x - b.cx) <= p * (b.x1 - b.x0 + 1) * 0.5; }, // barn door (H split)
        function (x, y, p, b) { return Math.abs(y - b.cy) <= p * (b.y1 - b.y0 + 1) * 0.5; }, // barn door (V split)
        function (x, y, p, b) { return (((y - b.y0) % 5) / 5) <= p; },                       // venetian blinds
        function (x, y, p, b) { return (((x - b.x0) % 6) / 6) <= p; }                        // vertical blinds
    ];

    function wipeBoundsFor(x0: number, y0: number, x1: number, y1: number): WipeBounds {
        var hw = (x1 - x0 + 1) * 0.25, hh = (y1 - y0 + 1) * 0.5;
        return {
            x0: x0, y0: y0, x1: x1, y1: y1,
            cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
            maxR: Math.sqrt(hw * hw + hh * hh) * 2 + 3
        };
    }

    /** Restore the backdrop over a screen rect: art cells where the rect
     *  overlaps the art blit; elsewhere a "wake" — a colored shade (the
     *  sprite's trail) that the next background repaint dissolves. */
    function restoreRect(blit: ArtBlit, l: Layout, x: number, y: number, w: number, h: number,
        trailSgr?: string): void {
        var y0 = Math.max(l.artTop, y);
        var y1 = Math.min(l.artBottom, y + h - 1);
        var x0 = Math.max(1, x);
        var x1 = Math.min(l.cols, x + w - 1);
        if (y1 < y0 || x1 < x0)
            return;
        // Fill the whole rect first (trail or blank), then re-blit the
        // overlapping slice of art on top — trails only ever show where the
        // art doesn't cover.
        var out = trailSgr ? sgr(trailSgr) : CLR;
        var fill = repeatByte(trailSgr ? "\xB0" : " ", x1 - x0 + 1);
        for (var r = y0; r <= y1; r++)
            out += gotoRC(r, x0) + fill;
        console.write(out + CLR);
        if (!blit.grid)
            return;
        var ax0 = Math.max(x0, blit.left);
        var ax1 = Math.min(x1, blit.left + blit.nCols - 1);
        var ay0 = Math.max(y0, blit.top);
        var ay1 = Math.min(y1, blit.top + blit.nRows - 1);
        if (ax1 < ax0 || ay1 < ay0)
            return;
        console.write(FLAnsiGrid.emit(blit.grid,
            ax0, ay0,
            blit.srcRow + (ay0 - blit.top), ay1 - ay0 + 1,
            blit.srcCol + (ax0 - blit.left), ax1 - ax0 + 1,
            blit.pal));
    }

    function drawBackdrop(track: PlayableTrack, l: Layout, blit: ArtBlit): void {
        console.write(CLR + "\x1b[2J\x1b[H");
        if (blit.grid) {
            drawArt(blit);
        } else {
            // No embedded art: a dim generated backdrop so the box isn't lonely.
            var mid = Math.max(2, Math.floor((l.artTop + l.artBottom) / 2) - 1);
            var t = track.title.length > l.cols - 4 ? track.title.substr(0, l.cols - 4) : track.title;
            var a = track.artist.length > l.cols - 4 ? track.artist.substr(0, l.cols - 4) : track.artist;
            console.write(gotoRC(mid, Math.max(1, Math.floor((l.cols - t.length) / 2))) +
                sgr("1;36") + t + CLR);
            console.write(gotoRC(mid + 2, Math.max(1, Math.floor((l.cols - a.length) / 2))) +
                sgr("0;36") + a + CLR);
        }
    }

    /** The double-line overlay box: static parts drawn once. */
    function drawBoxFrame(l: Layout, borderSgr: string): void {
        var horiz = repeatByte("\xCD", l.boxWidth - 2);
        console.write(sgr(borderSgr));
        console.write(gotoRC(l.boxTop, l.boxLeft) + "\xC9" + horiz + "\xBB");
        for (var r = 1; r <= 2; r++) {
            console.write(gotoRC(l.boxTop + r, l.boxLeft) + "\xBA" +
                repeatByte(" ", l.boxWidth - 2) + "\xBA");
        }
        console.write(gotoRC(l.boxTop + 3, l.boxLeft) + "\xC8" + horiz + "\xBC");
        console.write(CLR);
    }

    function drawTitleLine(l: Layout, track: PlayableTrack): void {
        var inner = l.boxWidth - 4;
        var label = "\x0e " + track.title + (track.artist.length ? " - " + track.artist : "");
        if (label.length > inner)
            label = label.substr(0, inner - 3) + "...";
        console.write(gotoRC(l.boxTop + 1, l.boxLeft + 2) +
            sgr("1;36") + label + repeatByte(" ", inner - label.length) + CLR);
    }

    function drawProgress(l: Layout, playedSec: number, totalSec: number, paused: boolean, posTxt: string): void {
        var inner = l.boxWidth - 4;
        var timeTxt = fmtTime(playedSec) + "/" + fmtTime(totalSec);
        var volTxt = paused ? " PAUSED " : (shuffle ? " SHUF " : "");
        var posSeg = posTxt.length ? " " + posTxt : "";     // queue position, e.g. " 3/42"
        var barWidth = inner - timeTxt.length - posSeg.length - volTxt.length - 2;
        if (barWidth < 8) {          // tight: drop the volume tag first
            volTxt = "";
            barWidth = inner - timeTxt.length - posSeg.length - 2;
        }
        if (barWidth < 8) {          // still tight: drop the position too
            posSeg = "";
            barWidth = inner - timeTxt.length - 2;
        }
        var fill = totalSec > 0 ? clamp(Math.round(barWidth * playedSec / totalSec), 0, barWidth) : 0;
        var bar = sgr(paused ? "1;33" : "1;37") + repeatByte("\xDB", fill) +
            sgr("0;34") + repeatByte("\xB0", barWidth - fill) + CLR;
        console.write(gotoRC(l.boxTop + 2, l.boxLeft + 2) +
            bar + " " + sgr("0;37") + timeTxt +
            (posSeg.length ? sgr("1;35") + posSeg : "") +
            sgr(paused ? "1;33" : "0;36") + volTxt + CLR);
    }

    // Hint bar with three luminance tiers -- dim separators ("[" "]" "/"),
    // medium labels, bright hotkeys -- and a hue that cycles on the beat.
    // ASCII only (CP437 arrow glyphs sit at C0 control positions).
    var HINTS: { keys: string[]; label: string }[] = [
        { keys: ["Space"], label: "Pause" },
        { keys: ["N", "P"], label: "Track" },
        { keys: ["S"], label: "huffle" },
        { keys: ["A"], label: "dd" },
        { keys: ["B"], label: "rowse" },
        { keys: ["C"], label: "reate" },
        { keys: ["Q"], label: "uit" }
    ];
    // [dim, medium, bright] SGR per triad: dim = plain hue, medium = bold hue,
    // bright = bold white/accent, so the tier hierarchy always reads.
    var HINT_TRIADS = [
        ["0;36", "0;1;36", "1;37"],   // cyan
        ["0;35", "0;1;35", "1;37"],   // magenta
        ["0;32", "0;1;32", "1;37"],   // green
        ["0;33", "0;1;33", "1;37"],   // amber
        ["0;34", "0;1;34", "1;36"],   // blue / cyan hotkeys
        ["0;31", "0;1;31", "1;33"]    // red / yellow hotkeys
    ];

    function buildHints(withLabels: boolean, tri: string[]): { text: string; len: number } {
        var dim = sgr(tri[0]);
        var med = sgr(tri[1]);
        var brt = sgr(tri[2]);
        var out = "";
        var len = 0;
        var gap = withLabels ? "  " : " ";
        for (var i = 0; i < HINTS.length; i++) {
            if (i > 0) { out += gap; len += gap.length; }
            var h = HINTS[i];
            out += dim + "[";
            len += 1;
            for (var k = 0; k < h.keys.length; k++) {
                if (k > 0) { out += dim + "/"; len += 1; }
                out += brt + h.keys[k];
                len += h.keys[k].length;
            }
            out += dim + "]";
            len += 1;
            if (withLabels) { out += med + h.label; len += h.label.length; }
        }
        return { text: out, len: len };
    }

    function drawHints(l: Layout, triadIdx: number): void {
        var n = HINT_TRIADS.length;
        var tri = HINT_TRIADS[((triadIdx % n) + n) % n];
        var h = buildHints(true, tri);
        if (h.len > l.boxWidth)
            h = buildHints(false, tri);
        var col = Math.max(1, l.boxLeft + Math.floor((l.boxWidth - h.len) / 2));
        console.write(gotoRC(Math.min(l.rows, l.boxTop + 4), col) + h.text + CLR);
    }

    // Audio-reactive glow strips flanking the lyric line: reach follows
    // loudness, color follows brightness (ZCR): bass reads red/magenta,
    // bright reads cyan/white.
    // Art palette swaps are part of the default look; [V] steps away from it.
    var VIS_MODES = ["glow+art", "glow", "border", "off"];

    function drawGlow(l: Layout, row: number, rms: number, zcr: number, on: boolean): void {
        if (!on) {
            // Vis off: the row belongs to the background effect (or blank).
            console.write(gotoRC(row, l.boxLeft) + bgFillRun(l.boxLeft, row, l.boxWidth));
            return;
        }
        var half = Math.floor(l.boxWidth / 2);
        var reach = Math.round(half * rms);
        var color = zcr > 0.66 ? "1;37" : zcr > 0.45 ? "1;36" : zcr > 0.28 ? "0;36" : zcr > 0.15 ? "1;35" : "0;31";
        var line = "";
        for (var i = 0; i < half; i++) {
            if (i < reach) {
                var d = i / Math.max(1, reach);   // fade toward the edges
                line += d > 0.75 ? "\xB0" : d > 0.45 ? "\xB1" : d > 0.2 ? "\xB2" : "\xDB";
            } else {
                line += " ";
            }
        }
        var left = line.split("").reverse().join("");
        var half2 = l.boxWidth - half * 2;
        // Glow chars in the center; whatever it doesn't reach shows the
        // background effect instead of a black cutout.
        var gap = half - reach;
        console.write(
            gotoRC(row, l.boxLeft) + bgFillRun(l.boxLeft, row, gap) +
            sgr(color) + left.substr(gap) + line.substr(0, reach) + CLR +
            bgFillRun(l.boxLeft + half + reach, row, gap + half2));
    }

    // Each lyric line gets a random color pair (base, light) and sweeps in
    // with a moving wave: cells near the crest render white -> light -> base,
    // cells far away sit dark until the wave passes (the avatar_chat room
    // join/leave effect, retargeted). Beats re-trigger short mini-sweeps.
    var LYRIC_COLORS: string[][] = [
        ["0;33", "1;33"], ["0;36", "1;36"], ["0;35", "1;35"],
        ["0;32", "1;32"], ["0;31", "1;31"], ["0;34", "1;36"]
    ];
    var LYRIC_SWEEP_MS = 1500;

    function drawLyric(l: Layout, text: string, colorIdx: number, progress: number): void {
        var t = text.length > l.lyricWidth - 2 ? text.substr(0, l.lyricWidth - 5) + "..." : text;
        var pad = l.lyricWidth - t.length;
        var lead = Math.floor(pad / 2);
        var pair = LYRIC_COLORS[colorIdx % LYRIC_COLORS.length];
        var out = gotoRC(l.lyricRow, l.lyricLeft) + bgFillRun(l.lyricLeft, l.lyricRow, lead);
        if (progress >= 1 || !t.length) {
            out += sgr(pair[1]) + t;
        } else {
            // Wave enters/exits off the ends for a smooth arrival.
            var margin = 5;
            var waveX = progress * (t.length + margin * 2) - margin;
            var last = "";
            for (var i = 0; i < t.length; i++) {
                var d = Math.abs(i - waveX);
                var code = d < 1.6 ? "1;37" : d < 4.5 ? pair[1] : d < 8 ? pair[0] : "1;30";
                if (code !== last) {
                    out += sgr(code);
                    last = code;
                }
                out += t.charAt(i);
            }
        }
        console.write(out + CLR +
            bgFillRun(l.lyricLeft + lead + t.length, l.lyricRow, pad - lead));
    }

    // ---- background effects in the art margins --------------------------------
    // Whatever art-zone area the (centered) art does not cover gets a music-
    // locked effect: a checkerboard whose phase steps on beats and whose
    // shade/color follow loudness/brightness, with a bright strobe flash
    // decaying over a few frames on hard beats. The lyric line, glow strips,
    // box and hints rows are never touched. [B] cycles auto/checker/strobe/off.
    var BG_MODES = ["auto", "checker", "plasma", "ripple", "tunnel", "starfield", "lyrics", "fire", "equalizer", "spiral", "aurora", "sweep", "strobe", "off"];

    interface Rect { x: number; y: number; w: number; h: number; }

    function marginRects(l: Layout, blit: ArtBlit): Rect[] {
        var rects: Rect[] = [];
        var zoneTop = l.artTop;
        var zoneBottom = l.artBottom;
        if (!blit.grid || !blit.nRows) {
            // No art: the whole zone (the box already carries the title).
            rects.push({ x: 1, y: zoneTop, w: l.cols, h: zoneBottom - zoneTop + 1 });
        } else {
            var artL = blit.left;
            var artR = blit.left + blit.nCols - 1;
            var artT = blit.top;
            var artB = blit.top + blit.nRows - 1;
            if (artT > zoneTop)
                rects.push({ x: 1, y: zoneTop, w: l.cols, h: artT - zoneTop });
            if (artB < zoneBottom)
                rects.push({ x: 1, y: artB + 1, w: l.cols, h: zoneBottom - artB });
            if (artL > 1)
                rects.push({ x: 1, y: artT, w: artL - 1, h: artB - artT + 1 });
            if (artR < l.cols)
                rects.push({ x: artR + 1, y: artT, w: l.cols - artR, h: artB - artT + 1 });
        }
        // Bottom zone: effects run BEHIND the status content. The glow/lyric
        // rows and the hints row are painted full-width (their renderers fill
        // gaps with the effect pattern, so text rides on top); only the box
        // itself stays opaque, so just its flanking columns are painted.
        rects.push({ x: 1, y: l.glowRow1, w: l.cols, h: 3 });
        var boxH = 4;
        if (l.boxLeft > 1)
            rects.push({ x: 1, y: l.boxTop, w: l.boxLeft - 1, h: boxH });
        var boxR = l.boxLeft + l.boxWidth;
        if (boxR <= l.cols)
            rects.push({ x: boxR, y: l.boxTop, w: l.cols - boxR + 1, h: boxH });
        var hintsRow = Math.min(l.rows, l.boxTop + 4);
        if (hintsRow > l.boxTop + 3) {
            // NEVER include the terminal's bottom-right cell: writing a glyph
            // there wraps the cursor and SCROLLS the whole screen — every
            // effect repaint shifted the display up a line (the smeared,
            // repeated-status corruption on fTelnet and SyncTERM alike).
            var hw = hintsRow >= l.rows ? l.cols - 1 : l.cols;
            if (hw > 0)
                rects.push({ x: 1, y: hintsRow, w: hw, h: 1 });
        }
        return rects;
    }

    // The active background effect's cell sampler: returns [sgrCode, char]
    // for a screen cell, or null for empty. Text renderers in the bottom zone
    // use it to fill their padding, so the pattern shows BEHIND the text.
    var bgCellFn: ((x: number, y: number) => string[] | null) | null = null;

    function bgFillRun(x: number, y: number, count: number): string {
        var out = "";
        var last = "@";
        for (var i = 0; i < count; i++) {
            var cell = bgCellFn ? bgCellFn(x + i, y) : null;
            var code = cell ? cell[0] : "0";
            var ch = cell ? cell[1] : " ";
            if (code !== last) {
                out += sgr(code);
                last = code;
            }
            out += ch;
        }
        return out + CLR;
    }

    function glowColor(zcr: number): string {
        return zcr > 0.66 ? "1;37" : zcr > 0.45 ? "1;36" : zcr > 0.28 ? "0;36"
            : zcr > 0.15 ? "1;35" : "0;31";
    }

    /** Checkerboard: 3-col blocks alternating shade/space; one SGR per row. */
    function drawChecker(rects: Rect[], phase: number, rms: number, zcr: number): void {
        var shade = rms > 0.7 ? "\xB2" : rms > 0.4 ? "\xB1" : "\xB0";
        var cc = glowColor(zcr);
        bgCellFn = function (x: number, y: number): string[] | null {
            return ((Math.floor((x - 1) / 3) + y + phase) % 2 === 0) ? [cc, shade] : null;
        };
        var out = sgr(cc);
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            for (var row = 0; row < rc.h; row++) {
                var line = "";
                for (var col = 0; col < rc.w; col++) {
                    var block = Math.floor(col / 3) + row + phase;
                    line += (block % 2 === 0) ? shade : " ";
                }
                out += gotoRC(rc.y + row, rc.x) + line;
            }
        }
        console.write(out + CLR);
    }

    // Shared band tables for the field effects: cool family for bright
    // (high-ZCR) passages, warm for bassy ones; char density rises with the
    // field value so the pattern reads even on monochrome-ish terminals.
    var FIELD_COOL = ["0;34", "0;36", "1;36", "1;37"];
    var FIELD_WARM = ["0;35", "0;31", "1;35", "1;33"];
    var FIELD_CHARS = [" ", "\xB0", "\xB1", "\xB2"];

    /** Paint every cell of the margin rects from a value field (0..1). */
    function fieldPaint(rects: Rect[], zcr: number,
        valueAt: (x: number, y: number) => number): void {
        var colors = zcr > 0.4 ? FIELD_COOL : FIELD_WARM;
        bgCellFn = function (x: number, y: number): string[] | null {
            var vv = valueAt(x, y);
            var b = Math.floor(clamp(vv, 0, 0.999) * FIELD_CHARS.length);
            return b > 0 ? [colors[b], FIELD_CHARS[b]] : null;
        };
        var out = "";
        var lastBand = -1;
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            for (var row = 0; row < rc.h; row++) {
                out += gotoRC(rc.y + row, rc.x);
                lastBand = -1;
                for (var col = 0; col < rc.w; col++) {
                    var v = valueAt(rc.x + col, rc.y + row);
                    var band = Math.floor(clamp(v, 0, 0.999) * FIELD_CHARS.length);
                    if (band !== lastBand) {
                        out += sgr(colors[band]);
                        lastBand = band;
                    }
                    out += FIELD_CHARS[band];
                }
            }
        }
        console.write(out + CLR);
    }

    /** Plasma: layered sine field; time advances with loudness, beats jolt it. */
    function drawPlasma(rects: Rect[], t: number, zcr: number): void {
        var scale = 0.12;
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var nx = x * scale;
            var ny = y * scale * 2;   // terminal cells are ~2x taller than wide
            var val = Math.sin(nx + t) +
                Math.sin((ny + t * 0.7) * 1.3) +
                Math.sin(Math.sqrt(nx * nx + ny * ny) + t * 0.4);
            return (val + 3) / 6;
        });
    }

    interface Ripple { cx: number; cy: number; r: number; }

    /** Ripples: beat-spawned expanding rings summed as an interference field. */
    function drawRipples(rects: Rect[], rings: Ripple[], zcr: number): void {
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var value = 0;
            for (var i = 0; i < rings.length; i++) {
                var dx = (x - rings[i].cx) * 0.5;   // squash for cell aspect
                var dy = y - rings[i].cy;
                var dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
                value += Math.sin(dist * 0.5 - rings[i].r * 0.7) / (1 + dist * 0.12);
            }
            return (value + 1.2) / 2.4;
        });
    }

    /** Strobe frame at decay level 3..1 (3 = brightest); 0 clears. */
    function drawStrobe(rects: Rect[], level: number, zcr: number): void {
        var ch = level >= 3 ? "\xB2" : level === 2 ? "\xB1" : level === 1 ? "\xB0" : " ";
        var sc = glowColor(zcr);
        bgCellFn = level > 0
            ? function (x: number, y: number): string[] | null { return [sc, ch]; }
            : null;
        var out = level > 0 ? sgr(sc) : CLR;
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            var line = repeatByte(ch, rc.w);
            for (var row = 0; row < rc.h; row++)
                out += gotoRC(rc.y + row, rc.x) + line;
        }
        console.write(out + CLR);
    }

    // Generic per-cell paint: fn(x,y) -> [sgr, char] | null (null = blank). Sets
    // bgCellFn so text rides on top, then paints the margin cells. Used by the
    // sparse effects (starfield, lyric rain) that place characters, not fill fields.
    function cellPaint(rects: Rect[], fn: (x: number, y: number) => string[] | null): void {
        bgCellFn = fn;
        var out = "";
        for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            for (var row = 0; row < rc.h; row++) {
                out += gotoRC(rc.y + row, rc.x);
                var last = "@";
                for (var col = 0; col < rc.w; col++) {
                    var cell = fn(rc.x + col, rc.y + row);
                    var code = cell ? cell[0] : "0";
                    var ch = cell ? cell[1] : " ";
                    if (code !== last) { out += sgr(code); last = code; }
                    out += ch;
                }
            }
        }
        console.write(out + CLR);
    }

    /** Tunnel: perspective depth rings + angular spokes receding to centre. */
    function drawTunnel(rects: Rect[], t: number, zcr: number, cx: number, cy: number): void {
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var dx = (x - cx) * 0.5;              // squash for cell aspect
            var dy = y - cy;
            var dist = Math.sqrt(dx * dx + dy * dy) + 0.6;
            var ang = Math.atan2(dy, dx);
            return Math.sin(9 / dist + t) * 0.5 + Math.sin(ang * 8 - t * 0.5) * 0.3 + 0.5;
        });
    }

    // Starfield warp: points stream out from the centre, accelerating as they
    // approach the viewer (far = dim dot, near = bright). Speed follows loudness.
    interface Star { x: number; y: number; dx: number; dy: number; }
    function spawnStar(cx: number, cy: number): Star {
        var a = Math.random() * Math.PI * 2;
        return { x: cx, y: cy, dx: Math.cos(a), dy: Math.sin(a) * 0.5 };
    }
    function stepStars(stars: Star[], want: number, cx: number, cy: number,
        cols: number, rows: number, top: number, rms: number): void {
        while (stars.length < want) stars.push(spawnStar(cx, cy));
        var speed = 0.4 + rms * 2.4;
        for (var i = 0; i < stars.length; i++) {
            var s = stars[i];
            var d = Math.abs(s.x - cx) + Math.abs(s.y - cy) + 1;
            s.x += s.dx * speed * (0.4 + d * 0.05);
            s.y += s.dy * speed * (0.4 + d * 0.05);
            if (s.x < 1 || s.x > cols || s.y < top || s.y > rows)
                stars[i] = spawnStar(cx, cy);
        }
    }
    function drawStars(rects: Rect[], stars: Star[], cx: number, cy: number): void {
        var map: { [k: string]: string[] } = {};
        for (var i = 0; i < stars.length; i++) {
            var sx = Math.round(stars[i].x), sy = Math.round(stars[i].y);
            var d = Math.abs(sx - cx) * 0.5 + Math.abs(sy - cy);
            map[sx + "," + sy] = d > 16 ? ["1;37", "*"] : d > 8 ? ["0;37", "+"] : ["1;30", "."];
        }
        cellPaint(rects, function (x: number, y: number): string[] | null {
            return map[x + "," + y] || null;
        });
    }

    // Lyric rain: instead of played-out random glyphs, WORDS from the current
    // lyric line fall as cyan streams (brightest at the leading edge). On beats
    // the falling characters flash to green binary (0/1) -- the words "digitize"
    // to the music, then resolve back to letters as the beat decays. Fed only
    // while a lyric line is active, and kept out of the auto-rotation entirely
    // on instrumental tracks, so it rains vocals rather than noise.
    interface LyricDrop { col: number; head: number; text: string; speed: number; glitch: number; }
    function rainWord(src: string): string {
        var words = src.split(" ");
        var w = "";
        for (var tries = 0; tries < 6 && !w; tries++) {
            var cand = words[Math.floor(Math.random() * words.length)] || "";
            w = cand.replace(/[^\x21-\x7e]/g, "");     // printable ASCII only (vertical text)
        }
        return w.length > 12 ? w.substr(0, 12) : w;
    }
    function stepLyricRain(drops: LyricDrop[], cols: number, rows: number, top: number,
        rms: number, hi: number, beat: boolean, src: string): void {
        if (src && drops.length < cols + 6 && (Math.random() < 0.22 + rms * 0.5 || beat)) {
            var w = rainWord(src);
            if (w)
                drops.push({
                    col: 1 + Math.floor(Math.random() * cols), head: top, text: w,
                    speed: 0.3 + Math.random() * 0.5, glitch: 0
                });
        }
        // Binary flashing tracks the music two ways: beats spike it, and bright
        // (trebly / electronic) passages hold a floor so the words keep
        // digitizing -- mellow acoustic parts decay back to readable letters.
        var floor = hi * 0.45;
        for (var i = drops.length - 1; i >= 0; i--) {
            var d = drops[i];
            d.head += d.speed * (0.5 + rms * 0.9);       // slow enough that words stay readable
            d.glitch = beat ? Math.min(1, d.glitch + 0.6) : Math.max(floor, d.glitch * 0.82);
            if (d.head - d.text.length > rows) drops.splice(i, 1);
        }
    }
    function drawLyricRain(rects: Rect[], drops: LyricDrop[]): void {
        var map: { [k: string]: string[] } = {};
        for (var i = 0; i < drops.length; i++) {
            var d = drops[i];
            var h = Math.floor(d.head);
            var len = d.text.length;
            for (var t = 0; t < len; t++) {
                var row = h - (len - 1) + t;             // word reads top->bottom, head at bottom
                var dist = (len - 1) - t;                // 0 at the bright leading edge
                if (d.glitch > 0 && Math.random() < d.glitch)
                    map[d.col + "," + row] = ["1;32", Math.random() < 0.5 ? "0" : "1"];   // binary flash
                else
                    map[d.col + "," + row] = [dist === 0 ? "1;37" : dist < 3 ? "1;36" : "0;36", d.text.charAt(t)];
            }
        }
        cellPaint(rects, function (x: number, y: number): string[] | null {
            return map[x + "," + y] || null;
        });
    }

    // Fire: a heat field seeded along the bottom (fuel follows loudness/beats)
    // that rises and cools -- classic demoscene fire, warm ASCII gradient.
    var FIRE_CHARS = [" ", "\xB0", "\xB1", "\xB2", "\xB2", "\xDB"];
    var FIRE_COLORS = ["0", "0;31", "1;31", "1;33", "1;33", "1;37"];
    function drawFire(rects: Rect[], heat: { [k: string]: number }, cols: number, rows: number,
        top: number, rms: number, beat: boolean): void {
        // Seed the bottom rows with fuel.
        var base = rows;
        for (var x = 1; x <= cols; x++) {
            var fuel = 0.5 + Math.random() * (0.4 + rms * 1.0) + (beat ? 0.35 : 0);
            heat[x + "," + base] = Math.min(1, fuel);
            heat[x + "," + (base - 1)] = Math.min(1, fuel * 0.92);
        }
        // Propagate upward with cooling (average of the row below +/- a column).
        var next: { [k: string]: number } = {};
        for (var y = top; y < base - 1; y++) {
            for (var cx2 = 1; cx2 <= cols; cx2++) {
                var below = (heat[cx2 + "," + (y + 1)] || 0) +
                    (heat[(cx2 - 1) + "," + (y + 1)] || 0) +
                    (heat[(cx2 + 1) + "," + (y + 1)] || 0) +
                    (heat[cx2 + "," + (y + 2)] || 0);
                var v = below / 4 - 0.032;   // less cooling per row -> flames climb higher
                if (v > 0.02) next[cx2 + "," + y] = v > 1 ? 1 : v;
            }
        }
        next[""] = 0;
        for (var bx = 1; bx <= cols; bx++) {
            next[bx + "," + base] = heat[bx + "," + base] || 0;
            next[bx + "," + (base - 1)] = heat[bx + "," + (base - 1)] || 0;
        }
        for (var kk in heat) if (heat.hasOwnProperty(kk)) delete heat[kk];
        for (var k2 in next) if (next.hasOwnProperty(k2)) heat[k2] = next[k2];
        cellPaint(rects, function (x: number, y: number): string[] | null {
            var hv = heat[x + "," + y];
            if (!hv) return null;
            var b = Math.min(FIRE_CHARS.length - 1, Math.floor(hv * FIRE_CHARS.length));
            return b > 0 ? [FIRE_COLORS[b], FIRE_CHARS[b]] : null;
        });
    }

    /** Spiral: rotating arms winding into the centre (hypnotic). */
    function drawSpiral(rects: Rect[], t: number, zcr: number, cx: number, cy: number): void {
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            var dx = (x - cx) * 0.5, dy = y - cy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var ang = Math.atan2(dy, dx);
            return Math.sin(ang * 3 + dist * 0.4 - t) * 0.5 + 0.5;
        });
    }

    /** Aurora: soft horizontal curtains undulating side to side. */
    function drawAurora(rects: Rect[], t: number, zcr: number): void {
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            return Math.sin(y * 0.5 + Math.sin(x * 0.08 + t) * 2 + t * 0.5) * 0.5 + 0.5;
        });
    }

    // Cyberpunk graphic equaliser. Bars are driven by REAL frequency bands
    // (chunkFeatures lo/mid/hi from the one-pole split), interpolated across the
    // bar row: left = lows, right = highs. Thin 1-col bars with a 1-col gap
    // (EQ_PERIOD 2) read as a segmented spectrum, and the top cell uses a CP437
    // half-block so heights land on half-cell steps instead of snapping to whole
    // rows -- crisper, more analog. Gentle oscillation adds life without driving
    // the height (the old faked wobble maxed every bar on the beat). Neon ramp
    // cyan -> purple -> magenta -> hot red, white floating peak caps.
    var EQ_PERIOD = 2;
    function eqColor(frac: number): string {
        return frac > 0.78 ? "1;31" : frac > 0.52 ? "1;35" : frac > 0.26 ? "0;35" : "1;36";
    }
    function stepEq(bars: number[], peaks: number[], cols: number, lo: number,
        mid: number, hi: number, beat: boolean, t: number): void {
        var n = Math.floor(cols / EQ_PERIOD) + 2;
        while (bars.length < n) { bars.push(0); peaks.push(0); }
        for (var i = 0; i < n; i++) {
            var f = n > 1 ? i / (n - 1) : 0;                       // 0 lows .. 1 highs
            // sample the real 3-band spectrum at this bar position
            var band = f < 0.5 ? lo + (mid - lo) * (f * 2)
                : mid + (hi - mid) * ((f - 0.5) * 2);
            var osc = 0.84 + 0.16 * Math.sin(i * 0.7 + t * (1.2 + f * 2));   // subtle shimmer
            var target = clamp(band * osc * 1.3 + (beat ? 0.09 : 0), 0, 1);
            if (target > bars[i]) bars[i] += (target - bars[i]) * 0.66;   // snappy attack
            else bars[i] += (target - bars[i]) * 0.13;                    // slow decay
            if (bars[i] > peaks[i]) peaks[i] = bars[i];
            else peaks[i] = Math.max(bars[i], peaks[i] - 0.03);
        }
    }
    function drawEq(rects: Rect[], bars: number[], peaks: number[], top: number, base: number): void {
        var span = Math.max(1, base - top);
        cellPaint(rects, function (x: number, y: number): string[] | null {
            if ((x - 1) % EQ_PERIOD !== 0) return null;                    // gap column
            var i = (x - 1) / EQ_PERIOD;
            var h = bars[i] || 0;
            var pk = peaks[i] || 0;
            var hc = h * span;                          // fractional height in cells
            var full = Math.floor(hc);
            var frac = hc - full;
            var fullTopY = base - full + 1;             // topmost full-block row
            var halfY = base - full;                    // half-block row (above full)
            var py = base - Math.round(pk * span);      // floating peak-cap row
            if (pk > 0.06 && y === py && y < halfY) return ["1;37", "\xDF"];       // peak cap
            if (h >= 0.02 && y >= fullTopY && y <= base) return [eqColor((base - y) / span), "\xDB"];
            if (frac >= 0.35 && y === halfY && halfY >= top) return [eqColor((base - halfY) / span), "\xDC"];
            return null;
        });
    }

    // Background sweep: a bright band wipes across the margins (a random wipe
    // geometry) leaving a fading trail, and re-fires in a new direction on each
    // beat -- the "wipe" idea applied to the whole backdrop.
    function drawSweep(rects: Rect[], p: number, geoIdx: number, zcr: number, b: WipeBounds): void {
        var g = WIPES[geoIdx % WIPES.length];
        fieldPaint(rects, zcr, function (x: number, y: number): number {
            if (!g(x, y, p, b)) return 0.08;                 // ahead of the front: faint wash
            if (!g(x, y, p - 0.12, b)) return 1;             // the leading band: bright
            if (!g(x, y, p - 0.35, b)) return 0.5;           // recent trail
            return 0.2;                                       // settled trail
        });
    }

    // ---- floating avatar sprites ---------------------------------------------
    // Avatars drift over the art like a screensaver, bounce off the art-zone
    // walls and each other, speed up with loudness, and get a velocity kick
    // on every beat. Erasing = restoring the art grid cells they vacated.
    interface Sprite {
        grid: FLAnsiGrid.Grid;
        flipped: FLAnsiGrid.Grid;   // vertical-axis mirror (faces the other way)
        facing: number;             // 1 = normal art, -1 = mirrored
        x: number;        // float position (screen cols/rows, 1-based)
        y: number;
        vx: number;
        vy: number;
        drawnX: number;   // last drawn integer position (-1 = not drawn)
        drawnY: number;
        trail: number;    // TRAIL_COLORS index; shifts on bounces and beats
        flash: number;    // palette-strobe frames remaining (beats)
        glitch: number;   // glitch-out frames remaining (hard accents)
        wiggle: number;   // head-shake frames remaining (alternating +-1 col)
        pad: number;      // horizontal spill of the last draw (glitch/wiggle)
    }

    var TRAIL_COLORS = ["0;35", "0;34", "0;36", "0;31", "0;32", "1;30"];

    function makeSprites(track: PlayableTrack, l: Layout): Sprite[] {
        var sprites: Sprite[] = [];
        var blobs = track.avatars || [];
        var zoneW = l.cols;
        var zoneH = l.artBottom - l.artTop + 1;
        if (zoneW < AVATAR_W + 4 || zoneH < AVATAR_H + 2)
            return sprites;
        var count = Math.min(blobs.length, 4);
        for (var i = 0; i < count; i++) {
            var grid = FLAnsiGrid.renderBin(blobs[i], AVATAR_W, AVATAR_H);
            if (!grid)
                continue;
            // Spread starting positions across the zone so a full crew
            // doesn't spawn stacked.
            var span = Math.max(1, zoneW - AVATAR_W - 4);
            var sx = 3 + (count > 1 ? Math.floor(span * i / (count - 1)) : Math.floor(span / 2));
            sprites.push({
                grid: grid,
                flipped: FLAnsiGrid.mirror(grid),
                facing: (i % 2 === 0) ? 1 : -1,
                x: sx,
                y: l.artTop + 1 + (i * 3) % Math.max(1, zoneH - AVATAR_H),
                vx: (i % 2 === 0 ? 1 : -1) * 0.9,
                vy: 0.35 * (i % 2 === 0 ? 1 : -1),
                drawnX: -1,
                drawnY: -1,
                trail: i % TRAIL_COLORS.length,
                flash: 0,
                glitch: 0,
                wiggle: 0,
                pad: 0
            });
        }
        return sprites;
    }

    // Avatar motion modes (rotate with the visualizer): "float" = free drift +
    // beat kicks; "gravity" = fall + floor-bounce, jump on beats; "mosh" =
    // pulled to the centre, explode outward on beats, slam into each other.
    var SPRITE_MODES = ["float", "gravity", "mosh"];

    function stepSprites(sprites: Sprite[], l: Layout, rms: number, beat: boolean,
        hardBeat: boolean, mode: string): void {
        var minX = 1;
        var maxX = l.cols - AVATAR_W + 1;
        var minY = l.artTop;
        var maxY = l.artBottom - AVATAR_H + 1;
        if (maxX <= minX || maxY <= minY)
            return;
        var speed = 0.6 + rms * 1.8;    // loudness drives the drift
        var ccx = (minX + maxX) / 2;
        var ccy = (minY + maxY) / 2;
        var i: number;

        for (i = 0; i < sprites.length; i++) {
            var s = sprites[i];
            if (beat) s.flash = 3;                          // palette strobe
            if (hardBeat) s.glitch = 3;                     // glitch-out on hard accents
            else if (beat && s.wiggle === 0 && Math.random() < 0.35) s.wiggle = 4;

            var hit = false;
            if (mode === "gravity") {
                if (beat) { s.vy = -(1.3 + rms * 1.7); s.vx += (Math.random() - 0.5) * 1.7; }  // jump
                s.vy += 0.14;                               // gravity
                s.vx = clamp(s.vx, -1.9, 1.9);
                s.x += s.vx * speed;
                s.y += s.vy;
                if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); hit = true; }
                if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); hit = true; }
                if (s.y > maxY) { s.y = maxY; s.vy = -Math.abs(s.vy) * 0.55; s.vx *= 0.92; hit = true; }  // floor
                if (s.y < minY) { s.y = minY; s.vy = Math.abs(s.vy) * 0.5; hit = true; }
            } else if (mode === "mosh") {
                if (beat) {                                 // explode outward from the centre
                    var ang = Math.atan2(s.y - ccy, s.x - ccx);
                    s.vx += Math.cos(ang) * (1.6 + rms * 2.2);
                    s.vy += Math.sin(ang) * (1.3 + rms * 1.7);
                } else {                                    // otherwise get pulled back in
                    s.vx += (ccx - s.x) * 0.022;
                    s.vy += (ccy - s.y) * 0.022;
                }
                s.vx = clamp(s.vx, -2.1, 2.1);
                s.vy = clamp(s.vy, -1.7, 1.7);
                s.x += s.vx * speed;
                s.y += s.vy * speed;
                if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); hit = true; }
                if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); hit = true; }
                if (s.y < minY) { s.y = minY; s.vy = Math.abs(s.vy); hit = true; }
                if (s.y > maxY) { s.y = maxY; s.vy = -Math.abs(s.vy); hit = true; }
            } else {                                        // float (default)
                if (beat) { s.vx += (Math.random() - 0.5) * 1.6; s.vy += (Math.random() - 0.5) * 1.2; }
                s.vx = clamp(s.vx, -1.6, 1.6);
                s.vy = clamp(s.vy, -1.1, 1.1);
                s.x += s.vx * speed;
                s.y += s.vy * speed;
                if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); hit = true; }
                if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); hit = true; }
                if (s.y < minY) { s.y = minY; s.vy = Math.abs(s.vy); hit = true; }
                if (s.y > maxY) { s.y = maxY; s.vy = -Math.abs(s.vy); hit = true; }
            }
            // Face the direction of travel.
            if (s.vx > 0.15) s.facing = 1;
            else if (s.vx < -0.15) s.facing = -1;
            if (hit || beat)
                s.trail = (s.trail + 1 + Math.floor(Math.random() * 2)) % TRAIL_COLORS.length;
        }

        // Pairwise collision (all pairs): overlap -> swap velocities and separate.
        for (i = 0; i < sprites.length; i++)
        for (var j = i + 1; j < sprites.length; j++) {
            var a = sprites[i];
            var b = sprites[j];
            if (Math.abs(a.x - b.x) < AVATAR_W && Math.abs(a.y - b.y) < AVATAR_H) {
                var tvx = a.vx; a.vx = b.vx; b.vx = tvx;
                var tvy = a.vy; a.vy = b.vy; b.vy = tvy;
                var tt = a.trail; a.trail = b.trail; b.trail = tt;
                var push = a.x <= b.x ? 1 : -1;
                a.x = clamp(a.x - push, minX, maxX);
                b.x = clamp(b.x + push, minX, maxX);
            }
        }
    }

    function drawSprites(sprites: Sprite[], l: Layout, blit: ArtBlit, force: boolean): void {
        for (var i = 0; i < sprites.length; i++) {
            var s = sprites[i];
            var nx = Math.round(s.x);
            var ny = Math.round(s.y);
            var moved = nx !== s.drawnX || ny !== s.drawnY;
            var animating = s.flash > 0 || s.glitch > 0 || s.wiggle > 0 || s.pad > 0;
            if (!force && !moved && !animating)
                continue;
            if (s.drawnX >= 0 && (moved || s.pad > 0)) {
                // Erase the previous frame (expanded by any glitch spill).
                // Moving leaves a colored wake; in-place redraws restore clean.
                restoreRect(blit, l, s.drawnX - s.pad, s.drawnY,
                    AVATAR_W + s.pad * 2, AVATAR_H,
                    moved ? TRAIL_COLORS[s.trail] : undefined);
            }
            s.pad = 0;
            var face = s.facing < 0 ? s.flipped : s.grid;
            if (s.glitch > 0) {
                // Glitch-out: each row lands with its own horizontal jitter,
                // drawn through the scramble palette (and one dropped row).
                s.glitch--;
                var dropRow = Math.floor(Math.random() * AVATAR_H);
                for (var gr = 0; gr < AVATAR_H; gr++) {
                    if (gr === dropRow)
                        continue;
                    var jx = nx + Math.floor(Math.random() * 5) - 2;
                    console.write(FLAnsiGrid.emitFlash(face, Math.max(1, jx), ny + gr,
                        gr, 1, 0, AVATAR_W, gr * 2 + s.glitch * 4 + 6));
                }
                s.pad = 2;
            } else {
                var wx = nx;
                if (s.wiggle > 0) {
                    wx = nx + (s.wiggle % 2 === 0 ? 1 : -1);
                    wx = Math.max(1, Math.min(l.cols - AVATAR_W + 1, wx));
                    s.wiggle--;
                    s.pad = 1;      // the shake spills a column either side
                }
                if (s.flash > 0) {
                    // Palette strobe: rotate the whole colour wheel a few frames
                    // per beat -- grays and white included, BLACK pinned.
                    console.write(FLAnsiGrid.emitFlash(face, wx, ny, 0, AVATAR_H, 0, AVATAR_W,
                        s.flash * 3 + i + 4));
                    s.flash--;
                } else {
                    console.write(FLAnsiGrid.emit(face, wx, ny, 0, AVATAR_H, 0, AVATAR_W, 0));
                }
            }
            s.drawnX = nx;
            s.drawnY = ny;
        }
    }

    // ---- the player -----------------------------------------------------------
    export function playTrack(track: PlayableTrack, statusLine?: (msg: string) => void): PlayResult {
        var say = statusLine || function (msg: string): void {
            console.write(CLR + "\r\x1b[K" + msg);
        };

        if (detectSink() === "none")
            return "error";
        if (!ffmpegAvailable()) {
            say("ffmpeg is not installed on the BBS host; terminal playback unavailable.");
            mswait(1800);
            return "error";
        }
        say("Preparing audio (transcoding)...");
        var wavPath = ensureTranscoded(track);
        if (wavPath === null) {
            say("Transcode failed for " + track.name);
            mswait(1800);
            return "error";
        }

        var f = new File(wavPath);
        if (!f.open("rb"))
            return "error";
        try {
            var info = readWavInfo(f);
            if (!info || !info.dataBytes) {
                say("Bad PCM cache file.");
                mswait(1500);
                return "error";
            }
            return playLoop(track, f, info);
        } finally {
            f.close();
        }
    }

    function playLoop(track: PlayableTrack, f: File, info: WavInfo): PlayResult {
        var bytesPerSec = info.rate * info.channels * 2;
        var chunkBytes = Math.floor(bytesPerSec * CHUNK_MS / 1000);
        // Frame-align so a chunk never splits a sample frame.
        chunkBytes -= chunkBytes % (info.channels * 2);
        var totalChunks = Math.ceil(info.dataBytes / chunkBytes);
        var totalSec = info.dataBytes / bytesPerSec;

        var termCols = 0;             // 0 = trust console.screen_*
        var termRows = 0;
        var l = layout();
        var pump = sharedPump;
        var visMode = 0;
        var bgMode = 0;               // BG_MODES index
        var borderPulse = 0;          // decaying beat flash
        var hintTriad = 0;            // HINT_TRIADS index; cycles on beats
        var hintFlashAt = 0;          // rate-cap for the hint hue cycle
        var lastRms = 0;
        var artFlashAt = nowMs();
        var ART_STATIC_MS = 6000;    // force an art transition at least this often,
        // even with no beats -- keeps soft/ambient passages from freezing the art.
        var PALETTE_SEQ: number[] = [];   // chosen once the art grid exists
        var palStep = 0;
        // Art-swap styles (rotate with the effect): pulse = step the palette on
        // beats; rotate = quick full-colour cycle bursts; wipe = fill the next
        // random wipe geometry. Each beat rolls a transition (mostly a wipe).
        var artRot = 0;                   // flash: colour-wheel phase
        var artRotFrames = 0;             // flash: rapid-cycle frames left after a beat
        var wipeActive = false;
        var wipeProg = 0;                 // 0..1 progress of the active wipe
        var wipeStep = 0.12;
        var wipeGeo = 0;                  // WIPES index
        var wipeOld = 0;
        var wipeNew = 0;
        var wipeBounds: WipeBounds = wipeBoundsFor(0, 0, 0, 0);
        var sweepP = 0;                   // bg "sweep" effect progress
        var sweepGeo = 0;
        var margins: Rect[] = [];
        var checkerPhase = 0;
        var checkerDirty = true;
        var strobeLevel = 0;
        var plasmaT = 0;
        var rings: Ripple[] = [];
        var fieldTick = 0;            // field effects repaint on alternate ticks
        var lastProbeAt = nowMs();   // no probe on the first iterations: the
                                     // previous track's drain notify is in
                                     // flight then, and the engine's reply
                                     // reader must not race it
        var lastConsoleCols = console.screen_columns || 0;
        var lastConsoleRows = console.screen_rows || 0;
        var cprSeen = 0;              // resize diagnostics (corner readout)
        var relayouts = 0;
        // Onset + energy tracking (all on RAW rms, updated once per chunk):
        // emaFast (~1s) is the local level — a chunk jumping clearly above it
        // is a beat/accent, even mid-plateau. emaSlow (~6s) is the passage
        // energy — fast diverging from slow marks quiet<->loud transitions,
        // which drive the auto background rotation.
        var emaFast = -1;
        var emaSlow = -1;
        // ~3s envelopes of energy + brightness for SECTION detection (verse /
        // chorus / bridge shifts), and their value at the last effect switch.
        var secRms = -1;
        var secZcr = -1;
        var secBaseRms = 0;
        var secBaseZcr = 0;
        var lastFeatChunk = -1;
        var spriteMode = 0;          // avatar motion mode, rotates with the effect
        var AUTO_EFFECTS = ["checker", "plasma", "ripple", "tunnel", "starfield", "fire", "equalizer", "spiral", "aurora", "sweep"];
        // "lyrics" (lyric rain) is appended to the pool below, but only when the
        // track actually has lyrics -- so instrumental tracks never rotate to it.
        var autoIdx = Math.floor(Math.random() * AUTO_EFFECTS.length);  // random start, random switches
        var tunnelT = 0;             // tunnel scroll phase
        var waveT = 0;               // spiral / aurora phase
        var stars: Star[] = [];      // starfield warp points
        var lyricDrops: LyricDrop[] = [];  // lyric-rain word streams
        var rainSrc = "";            // last active lyric line (rain material; persists gaps)
        var fireHeat: { [k: string]: number } = {};  // fire heat field
        var eqBars: number[] = [];   // equaliser bar heights (per column)
        var eqPeaks: number[] = [];  // equaliser peak-hold caps
        var eqT = 0;                 // equaliser oscillation phase
        var lastAutoSwitchAt = nowMs();

        var blit = makeArtBlit(track, l);
        var sprites = makeSprites(track, l);
        margins = marginRects(l, blit);
        // Beat-stepped palette sequences: every other step returns to the
        // true palette so the art keeps reading as itself between swaps.
        // Colorful art cycles the structure-preserving maps; grayscale-heavy
        // art (where those maps are invisible no-ops) gets the colorizers
        // and black-movers that wash the whole canvas.
        var SEQ_COLORFUL = [0, 1, 0, 3, 0, 5, 0, 2, 0, 9, 0, 7, 0, 4, 0, 6];
        var SEQ_GRAYSCALE = [0, 5, 0, 9, 0, 6, 0, 10, 0, 7, 0, 11, 0, 8];
        PALETTE_SEQ = SEQ_COLORFUL;
        if (blit.grid) {
            var chroma = 0;
            var cells = 0;
            for (var gy = 0; gy < blit.grid.rows.length; gy++) {
                var grow = blit.grid.rows[gy];
                for (var gx = 0; gx < grow.length; gx++) {
                    var at = grow[gx] >> 8;
                    var fgIdx = at & 0x07;
                    var bgIdx = (at >> 4) & 0x07;
                    cells++;
                    if ((fgIdx >= 1 && fgIdx <= 6) || (bgIdx >= 1 && bgIdx <= 6))
                        chroma++;
                }
            }
            if (cells > 0 && chroma / cells < 0.15)
                PALETTE_SEQ = SEQ_GRAYSCALE;
        }
        var lyrics: LyricLine[] = track.lyrics && track.lyrics.length
            ? track.lyrics
            : distributeLyrics(track.flatLyrics || "", totalSec);
        if (lyrics.length)
            AUTO_EFFECTS.push("lyrics");   // rain the vocals -- only on tracks that have them
        // Size the lyric strip to this track's longest line so a wide terminal
        // shows full lines instead of ellipsis. Per track (stable across lines),
        // never narrower than the box; the glow/viz bars keep the box width.
        var maxLyricLen = 0;
        for (var mli = 0; mli < lyrics.length; mli++) {
            var llen = lyrics[mli] && lyrics[mli].text ? lyrics[mli].text.length : 0;
            if (llen > maxLyricLen) maxLyricLen = llen;
        }
        l = layout(l.cols, l.rows, maxLyricLen);
        var lyricIdx = -1;
        var lyricColor = Math.floor(Math.random() * 6);
        var lyricSweepAt = 0;         // 0 = steady (no sweep running)

        function redrawAll(): void {
            drawBackdrop(track, l, blit);
            drawBoxFrame(l, "0;34");
            drawTitleLine(l, track);
            drawHints(l, hintTriad);
            checkerDirty = true;
            strobeLevel = 0;
            for (var si = 0; si < sprites.length; si++) {
                // Clamp into the (possibly smaller) new zone; force redraw.
                sprites[si].x = clamp(sprites[si].x, 1, Math.max(1, l.cols - AVATAR_W + 1));
                sprites[si].y = clamp(sprites[si].y, l.artTop, Math.max(l.artTop, l.artBottom - AVATAR_H + 1));
                sprites[si].drawnX = -1;
                sprites[si].drawnY = -1;
            }
            drawSprites(sprites, l, blit, true);
        }

        function relayout(cols: number, rows: number): void {
            if (cols === l.cols && rows === l.rows)
                return;
            termCols = cols;
            termRows = rows;
            relayouts++;
            l = layout(termCols, termRows, maxLyricLen);
            blit = makeArtBlit(track, l);
            margins = marginRects(l, blit);
            lyricIdx = -1;      // repaint the lyric row after the redraw
            rings = [];
            stars = []; lyricDrops = []; fireHeat = {};   // positions were screen-relative
            eqBars = []; eqPeaks = [];
            wipeActive = false;
            redrawAll();
        }

        // Drop input that leaked in before this track took the keyboard
        // (auto-repeat dregs; buffered intent was already honored by the
        // caller between tracks). This MUST go through the pump, not raw
        // zero-timeout inkey reads: a raw flush can bisect an in-flight CSI
        // reply and leave a tail like "0n" that the next pump reads as plain
        // keys — the 'n' became a phantom [N]ext that fought P presses. The
        // pump reassembles sequences and keeps partials buffered instead.
        pump.pump(40);

        redrawAll();

        apc("A;Update;C=" + CHANNEL);

        var chunk = 0;                 // next chunk to emit
        var t0 = nowMs();              // wall-clock anchor: chunk i plays at t0 + i*CHUNK_MS
        var paused = false;
        var pausedMs = 0;              // frozen playhead while paused
        // Any intentional Flush (track start counts: the PREVIOUS track's fade
        // tail may still fire its armed notify) opens a grace window during
        // which drain notifies are stale echoes of our own Flush, NOT
        // underruns. Treating them as underruns re-Flushes, which fires the
        // next notify: a restart ping-pong that scrubs the song back and forth.
        var FLUSH_GRACE_MS = 1500;
        var lastFlushAt = nowMs();
        var lastUiAt = 0;
        var result: PlayResult = "ended";
        var features: { rms: number; raw: number; zcr: number; lo: number; mid: number; hi: number } =
            { rms: 0, raw: 0, zcr: 0, lo: 0, mid: 0, hi: 0 };
        var featForChunk: { rms: number; raw: number; zcr: number; lo: number; mid: number; hi: number }[] = [];

        function emitChunk(idx: number): void {
            f.position = info.dataOffset + idx * chunkBytes;
            var want = Math.min(chunkBytes, info.dataBytes - idx * chunkBytes);
            var slice = f.read(want);
            if (!slice || !slice.length)
                return;
            featForChunk[idx] = chunkFeatures(slice, info.channels);
            var name = "flr" + (idx % SLOTS) + ".wav";
            var slot = idx % SLOTS;
            console.write(
                "\x1b_SyncTERM:C;S;" + name + ";" +
                base64_encode(wavHeader(slice.length, info.rate, info.channels) + slice) +
                "\x1b\\" +
                "\x1b_SyncTERM:A;Load;S=" + slot + ";" + name + "\x1b\\" +
                "\x1b_SyncTERM:A;Queue;C=" + CHANNEL + ";S=" + slot + "\x1b\\");
        }

        function rePrime(fromChunk: number): void {
            chunk = clamp(fromChunk, 0, totalChunks);
            t0 = nowMs() - chunk * CHUNK_MS + PREBUFFER * CHUNK_MS;
            lastFlushAt = nowMs();
            apc("A;Flush;C=" + CHANNEL);
            apc("A;Update;C=" + CHANNEL);
        }

        dbg("playLoop start: " + track.name + " chunks=" + totalChunks);
        console.write("\x1b[?25l");   // hide the cursor for the show
        while (bbs.online && !js.terminated) {
            var now = nowMs();
            var playMs = paused ? pausedMs : (now - t0);
            var playChunk = clamp(Math.floor(playMs / CHUNK_MS), 0, totalChunks);

            if (!paused) {
                // Top up the cushion: emit every chunk whose send-time has come.
                var guard = 0;
                while (chunk < totalChunks &&
                       chunk <= playChunk + PREBUFFER &&
                       guard++ < PREBUFFER + 2) {
                    emitChunk(chunk);
                    chunk++;
                }
            }

            // ---- input + audio events ----
            var ev = pump.pump(20);
            if (ev.keys.length || ev.arrows.length || ev.esc || ev.audio.length || ev.other.length)
                dbg("pump: " + fmtPump(ev) + " @chunk " + playChunk + "/" + totalChunks);
            var quitReq = ev.esc;
            if (ev.esc)
                result = "quit";      // Esc means leave, not "song ended"
            for (var i = 0; i < ev.keys.length; i++) {
                var k = ev.keys[i];
                if (k === "Q") {
                    // Without this, breaking with the default result ("ended")
                    // made Q behave exactly like N: jukebox auto-advance.
                    result = "quit";
                    quitReq = true;
                }
                else if (k === " ") {
                    if (!paused) {
                        paused = true;
                        pausedMs = playMs;      // freeze the displayed clock
                        lastFlushAt = now;      // our Flush, not an underrun
                        apc("A;Flush;C=" + CHANNEL);
                        chunk = playChunk;      // resume point
                    } else {
                        paused = false;
                        rePrime(chunk);
                    }
                } else if (k === "N") {
                    result = "next";
                    quitReq = true;
                } else if (k === "P") {
                    result = "prev";
                    quitReq = true;
                } else if (k === "B") {
                    result = "browse";       // open the typeahead song browser
                    quitReq = true;
                } else if (k === "C") {
                    result = "create";       // jump to the compose-a-song flow
                    quitReq = true;
                } else if (k === "A") {
                    result = "addplaylist";  // add the current track to a playlist
                    quitReq = true;
                } else if (k === "R") {
                    result = "removeplaylist"; // remove from the current playlist
                    quitReq = true;
                } else if (k === "S") {
                    shuffle = !shuffle;      // toggle track shuffle (indicator on next tick)
                    if (shuffle) shuffleReset = true;   // entering shuffle -> fresh deck from 1
                }
            }
            for (var a = 0; a < ev.arrows.length; a++) {
                var dir = ev.arrows[a];
                // Any arrow skips tracks. No in-terminal volume: SyncTERM's
                // per-channel gain scratches mid-stream and doesn't take, so
                // volume is left to the OS/terminal mixer.
                if (dir === "up" || dir === "left") {
                    result = "prev";
                    quitReq = true;
                } else if (dir === "down" || dir === "right") {
                    result = "next";
                    quitReq = true;
                }
            }
            for (var e = 0; e < ev.audio.length; e++) {
                if (ev.audio[e][0] === CHANNEL && ev.audio[e][1] === 0 && !paused) {
                    if (chunk >= totalChunks) {
                        // Armed notify after the last chunk: the song finished.
                        result = "ended";
                        quitReq = true;
                    } else if (now - lastFlushAt < FLUSH_GRACE_MS) {
                        dbg("notify: stale (grace), re-armed");
                        // Stale echo of our own Flush (seek/pause/track start):
                        // the one-shot was consumed by it, so just re-arm and
                        // keep playing. Recovering here would re-Flush and
                        // trigger the next echo — the restart ping-pong.
                        apc("A;Update;C=" + CHANNEL);
                    } else {
                        // Underrun: the cushion ran dry (slow link / stall).
                        // Re-anchor and re-prime, exactly like lameboy does.
                        dbg("notify: underrun re-prime @" + playChunk);
                        rePrime(playChunk);
                    }
                }
            }
            if (quitReq)
                break;

            // Responsive layout, two channels, both always live:
            //  - console.screen_* is watched EVERY iteration — for an
            //    in-process door this updates on NAWS / SSH window-change
            //    (and when the BBS consumes a CPR itself), so it works even
            //    if our own probe replies never reach inkey.
            //  - a parked-cursor CPR probe every 2s measures the REAL
            //    terminal through any proxy; its reply, when it arrives,
            //    overrides. relayout() dedupes, so agreement costs nothing.
            var conC = console.screen_columns || 0;
            var conR = console.screen_rows || 0;
            if (conC && conR && (conC !== lastConsoleCols || conR !== lastConsoleRows)) {
                lastConsoleCols = conC;
                lastConsoleRows = conR;
                relayout(conC, conR);
            }
            for (var cp = 0; cp < ev.cpr.length; cp++) {
                cprSeen++;
                relayout(ev.cpr[cp][1], ev.cpr[cp][0]);
            }
            if (now - lastProbeAt >= 2000 && now - lastFlushAt >= 3000) {
                lastProbeAt = now;
                // In-process, the terminal layer CONSUMES raw CPR replies (they
                // feed the engine's own cursor machinery and never reach
                // inkey) — so raw \x1b[6n probes are invisible to us. Ask the
                // engine instead: getdimensions() runs ITS remote size query
                // and refreshes console.screen_columns/rows, which the watcher
                // above relayouts from on the next iteration. (Native doors
                // like spekder/lameboy read the socket directly, which is why
                // the raw-probe pattern works there but not here.)
                try {
                    console.getdimensions();
                } catch (probeErr) { }
            }

            // Natural end fallback (in case the drain notify was lost).
            if (!paused && chunk >= totalChunks && playMs > totalSec * 1000 + 1500) {
                result = "ended";
                break;
            }

            // ---- UI tick ----
            if (now - lastUiAt >= UI_TICK_MS) {
                lastUiAt = now;
                var fi = featForChunk[clamp(playChunk, 0, featForChunk.length - 1)];
                if (fi)
                    features = fi;
                var mode = VIS_MODES[visMode];
                var beat = false;
                var hardBeat = false;
                if (!paused && playChunk !== lastFeatChunk && features.raw > 0) {
                    lastFeatChunk = playChunk;
                    if (emaFast < 0) {
                        emaFast = features.raw;
                        emaSlow = features.raw;
                    }
                    beat = features.raw > emaFast * 1.25 + 0.015;
                    hardBeat = features.raw > emaFast * 1.55 + 0.03;
                    emaFast = emaFast * 0.7 + features.raw * 0.3;
                    emaSlow = emaSlow * 0.95 + features.raw * 0.05;
                    if (secRms < 0) {
                        secRms = features.raw; secZcr = features.zcr;
                        secBaseRms = secRms; secBaseZcr = secZcr;
                    }
                    secRms = secRms * 0.9 + features.raw * 0.1;    // ~3s envelope
                    secZcr = secZcr * 0.9 + features.zcr * 0.1;
                }
                if (beat)
                    borderPulse = 3;
                lastRms = features.rms;

                // Switch effect on SECTION changes, not a plain timer: when the
                // ~3s energy or brightness (melody-height proxy) envelope has
                // drifted well away from what it was at the last switch (a
                // verse<->chorus<->bridge shift), debounced by a 5s floor. A long
                // steady section still rotates on the 24s fallback. The switch
                // announces itself with a strobe flash.
                if (BG_MODES[bgMode] === "auto" && !paused && secRms >= 0) {
                    var swAge = now - lastAutoSwitchAt;
                    var dRms = Math.abs(secRms - secBaseRms) / Math.max(secBaseRms, 0.05);
                    var dZcr = Math.abs(secZcr - secBaseZcr);
                    var sectionChanged = (dRms > 0.45 || dZcr > 0.14);
                    if ((swAge > 5000 && sectionChanged) || swAge > 24000) {
                        lastAutoSwitchAt = now;
                        secBaseRms = secRms; secBaseZcr = secZcr;   // reset the section baseline
                        // Random next effect (no immediate repeat) so all of them
                        // -- equalizer included -- come up evenly, not just the
                        // first few in a sequential 2-minute track.
                        var prevA = autoIdx;
                        do { autoIdx = Math.floor(Math.random() * AUTO_EFFECTS.length); }
                        while (autoIdx === prevA && AUTO_EFFECTS.length > 1);
                        spriteMode = (spriteMode + 1) % SPRITE_MODES.length;   // vary avatar physics too
                        wipeActive = false;
                        rings = [];
                        checkerDirty = true;
                        strobeLevel = 3;
                    }
                }

                // Art color-pulse: on beats, step the palette sequence (a
                // set of distinct permutation maps that keeps returning to the
                // true palette; rate-capped so slow links keep breathing room).
                if (mode === "glow+art" && blit.grid && !paused) {
                    if (wipeActive) {
                        // Advance the active video-style wipe (random geometry).
                        wipeProg += wipeStep;
                        var wg = WIPES[wipeGeo], wp = wipeProg, wo = wipeOld, wn = wipeNew, wb = wipeBounds;
                        drawArtWipe(blit, function (x: number, y: number): number {
                            return wg(x, y, wp, wb) ? wn : wo;
                        });
                        drawSprites(sprites, l, blit, true);
                        if (wipeProg >= 1) { wipeActive = false; blit.pal = wipeNew; }
                    } else if (artRotFrames > 0) {
                        // Quick full-colour cycle burst (all colours at once).
                        artRot = (artRot + 4 + Math.floor(features.rms * 8)) % 15;
                        if (artRot === 0) artRot = 1;
                        drawArtFlash(blit, artRot);
                        drawSprites(sprites, l, blit, true);
                        artRotFrames--;
                        if (artRotFrames === 0) { drawArt(blit); drawSprites(sprites, l, blit, true); }
                    } else if ((beat && now - artFlashAt > 460) || now - artFlashAt > ART_STATIC_MS) {
                        // New transition on the beat -- OR on a time fallback, so
                        // the art never freezes through a soft, beatless passage.
                        // Mostly a wipe (random direction), sometimes an instant
                        // swap or a flash burst. A fallback (no beat) uses only the
                        // calm styles -- never the energetic flash burst in a lull.
                        artFlashAt = now;
                        palStep = PALETTE_SEQ.length ? (palStep + 1) % PALETTE_SEQ.length : 0;
                        var target = PALETTE_SEQ.length ? PALETTE_SEQ[palStep] : 0;
                        var roll = Math.random();
                        if (roll < 0.16) {                       // instant
                            blit.pal = target; drawArt(blit); drawSprites(sprites, l, blit, true);
                        } else if (beat && roll < 0.30) {        // flash burst (real beats only)
                            blit.pal = target; artRotFrames = 4;
                        } else {                                 // WIPE (random geometry) -- the majority
                            wipeActive = true; wipeProg = 0;
                            wipeGeo = Math.floor(Math.random() * WIPES.length);
                            wipeOld = blit.pal; wipeNew = target;
                            wipeBounds = wipeBoundsFor(blit.left, blit.top,
                                blit.left + blit.nCols - 1, blit.top + blit.nRows - 1);
                            wipeStep = 1 / (6 + Math.floor(Math.random() * 6));   // ~6-11 frames
                        }
                    }
                }

                // Hint-bar hue cycles on the beat (rate-capped so it pulses with
                // the music instead of strobing). Redraw now so the color change
                // shows even on frames the background didn't repaint.
                if (beat && now - hintFlashAt > 220) {
                    hintFlashAt = now;
                    hintTriad = (hintTriad + 1) % HINT_TRIADS.length;
                    drawHints(l, hintTriad);
                }

                // Background margins, all music-locked: checker phase steps
                // on beats; plasma time flows with loudness and jolts on
                // beats; ripples SPAWN on beats and expand with loudness;
                // hard beats fire a strobe that decays over following frames.
                var bg = BG_MODES[bgMode];
                if (bg === "auto")
                    bg = AUTO_EFFECTS[autoIdx];    // rotated by the music above
                var bgPainted = false;
                var fxCx = Math.floor(l.cols / 2);                         // effect centre (tunnel/starfield)
                var fxCy = Math.floor((l.artTop + l.artBottom) / 2);
                var STAR_COUNT = Math.max(40, Math.min(120, Math.floor(l.cols * l.rows / 45)));
                if (margins.length && BG_MODES[bgMode] !== "off" && !paused) {
                    fieldTick++;
                    if ((BG_MODES[bgMode] === "auto" || BG_MODES[bgMode] === "strobe") && hardBeat)
                        strobeLevel = 3;
                    if (strobeLevel > 0) {
                        drawStrobe(margins, strobeLevel, features.zcr);
                        bgPainted = true;
                        strobeLevel--;
                        if (strobeLevel === 0)
                            checkerDirty = true;   // repaint pattern after decay
                    } else if (bg === "checker") {
                        if (beat) {
                            checkerPhase++;
                            checkerDirty = true;
                        }
                        if (checkerDirty) {
                            drawChecker(margins, checkerPhase, features.rms, features.zcr);
                            bgPainted = true;
                            checkerDirty = false;
                        }
                    } else if (bg === "plasma") {
                        plasmaT += 0.10 + features.rms * 0.35;
                        if (beat)
                            plasmaT += 1.2;
                        if (fieldTick % 2 === 0 || beat) {
                            drawPlasma(margins, plasmaT, features.zcr);
                            bgPainted = true;
                        }
                    } else if (bg === "ripple") {
                        if (beat && rings.length < 4) {
                            rings.push({
                                cx: 1 + Math.floor(Math.random() * l.cols),
                                cy: l.artTop + Math.floor(Math.random() * (l.artBottom - l.artTop + 1)),
                                r: 0
                            });
                        }
                        for (var ri = rings.length - 1; ri >= 0; ri--) {
                            rings[ri].r += 0.8 + features.rms * 1.5;
                            if (rings[ri].r > l.cols)
                                rings.splice(ri, 1);
                        }
                        if (rings.length && (fieldTick % 2 === 0 || beat)) {
                            drawRipples(margins, rings, features.zcr);
                            bgPainted = true;
                        }
                    } else if (bg === "tunnel") {
                        tunnelT += 0.15 + features.rms * 0.55;
                        if (beat) tunnelT += 0.8;
                        if (fieldTick % 2 === 0 || beat) {
                            drawTunnel(margins, tunnelT, features.zcr, fxCx, fxCy);
                            bgPainted = true;
                        }
                    } else if (bg === "starfield") {
                        stepStars(stars, STAR_COUNT, fxCx, fxCy, l.cols, l.rows, l.artTop, features.rms);
                        drawStars(margins, stars, fxCx, fxCy);
                        bgPainted = true;
                    } else if (bg === "lyrics") {
                        // feed the current line (persist the last one through gaps)
                        if (lyricIdx >= 0 && lyrics[lyricIdx] && lyrics[lyricIdx].text)
                            rainSrc = lyrics[lyricIdx].text;
                        stepLyricRain(lyricDrops, l.cols, l.rows, l.artTop, features.rms, features.hi, beat, rainSrc);
                        drawLyricRain(margins, lyricDrops);
                        bgPainted = true;
                    } else if (bg === "fire") {
                        drawFire(margins, fireHeat, l.cols, l.rows, l.artTop, features.rms, beat);
                        bgPainted = true;
                    } else if (bg === "equalizer") {
                        eqT += 0.35 + features.rms * 0.6;
                        stepEq(eqBars, eqPeaks, l.cols, features.lo, features.mid, features.hi, beat, eqT);
                        drawEq(margins, eqBars, eqPeaks, l.artTop, l.artBottom);
                        bgPainted = true;
                    } else if (bg === "spiral") {
                        waveT += 0.12 + features.rms * 0.45;
                        if (beat) waveT += 0.6;
                        if (fieldTick % 2 === 0 || beat) {
                            drawSpiral(margins, waveT, features.zcr, fxCx, fxCy);
                            bgPainted = true;
                        }
                    } else if (bg === "aurora") {
                        waveT += 0.1 + features.rms * 0.4;
                        if (fieldTick % 2 === 0 || beat) {
                            drawAurora(margins, waveT, features.zcr);
                            bgPainted = true;
                        }
                    } else if (bg === "sweep") {
                        sweepP += 0.06 + features.rms * 0.14;
                        if ((beat && sweepP > 0.5) || sweepP > 1.35) {
                            sweepP = 0;
                            sweepGeo = Math.floor(Math.random() * WIPES.length);
                        }
                        drawSweep(margins, sweepP, sweepGeo, features.zcr,
                            wipeBoundsFor(1, l.artTop, l.cols, l.artBottom));
                        bgPainted = true;
                    }
                }

                if (mode !== "off" && borderPulse > 0) {
                    drawBoxFrame(l, borderPulse >= 2 ? "1;36" : "0;36");
                    drawTitleLine(l, track);
                    borderPulse--;
                    if (borderPulse === 0) {
                        drawBoxFrame(l, "0;34");
                        drawTitleLine(l, track);
                    }
                }

                var glowOn = mode === "glow" || mode === "glow+art";
                drawGlow(l, l.glowRow1, paused ? 0 : features.rms, features.zcr, glowOn);
                drawGlow(l, l.glowRow2, paused ? 0 : features.rms, features.zcr, glowOn);

                // Floating avatars: physics every tick, redraw when they move.
                if (sprites.length && !paused) {
                    stepSprites(sprites, l, features.rms, beat, hardBeat, SPRITE_MODES[spriteMode]);
                    drawSprites(sprites, l, blit, false);
                }

                // Synced lyric line between the strips: a new line launches a
                // full color sweep in a fresh random color; beats mid-line
                // re-trigger short mini-sweeps so held lines keep shimmering.
                if (lyrics.length) {
                    var li = lyricIndexFor(lyrics, playMs / 1000, lyricIdx);
                    if (li !== lyricIdx) {
                        lyricIdx = li;
                        lyricColor = (lyricColor + 1 + Math.floor(Math.random() * (6 - 1))) % 6;
                        lyricSweepAt = now;
                    } else if (beat && li >= 0 && lyricSweepAt === 0) {
                        lyricSweepAt = now - Math.floor(LYRIC_SWEEP_MS * 0.55);
                    }
                    if (lyricSweepAt > 0) {
                        var prog = (now - lyricSweepAt) / LYRIC_SWEEP_MS;
                        drawLyric(l, lyricIdx >= 0 ? lyrics[lyricIdx].text : "",
                            lyricColor, clamp(prog, 0, 1));
                        if (prog >= 1)
                            lyricSweepAt = 0;
                    } else if (bgPainted && lyricIdx >= 0) {
                        // The effect just painted over the lyric row's padding
                        // AND its text; put the settled line back on top.
                        drawLyric(l, lyrics[lyricIdx].text, lyricColor, 1);
                    }
                }
                if (bgPainted)
                    drawHints(l, hintTriad);

                var posTxt = (track.queueName && track.queueLen && track.queueLen > 0)
                    ? (track.queuePos + "/" + track.queueLen) : "";
                drawProgress(l, clamp(playMs / 1000, 0, totalSec), totalSec, paused, posTxt);
                var diag = l.cols + "x" + l.rows + " c" + cprSeen + " r" + relayouts;
                console.write(gotoRC(l.rows, Math.max(1, l.cols - diag.length)) +
                    sgr("0;30;1") + diag + CLR);
                console.write(gotoRC(l.rows, l.cols) + CLR);
            }
        }

        apc("A;Flush;C=" + CHANNEL + ";O=250");
        console.write("\x1b[?25h");   // cursor back for the menus
        dbg("playLoop exit: result=" + result);
        return result;
    }

    // ---- self test (jsexec, headless) ----------------------------------------
    export function selfTest(): void {
        // WAV round trip.
        var pcm = "";
        for (var i = 0; i < 2000; i++) {
            var v = Math.round(Math.sin(i / 8) * 12000);
            if (v < 0) v += 0x10000;
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
        }
        var wav = wavHeader(pcm.length, 22050, 2) + pcm;
        var info = parseWavHeader(wav.substr(0, 256), wav.length);
        if (!info) throw new Error("parseWavHeader failed");
        if (info.rate !== 22050 || info.channels !== 2)
            throw new Error("rate/channels mismatch: " + info.rate + "/" + info.channels);
        if (info.dataOffset !== 44 || info.dataBytes !== pcm.length)
            throw new Error("data chunk mismatch: " + info.dataOffset + "/" + info.dataBytes);

        // A WAV whose data chunk sits past 512 bytes (ffmpeg LIST INFO tags)
        // must still parse via the progressive reader's growth path.
        var fat = "RIFF" + le32(4 + 8 + 8 + 700 + 8 + pcm.length) + "WAVE" +
            "fmt " + le32(16) + le16(1) + le16(2) + le32(22050) +
            le32(22050 * 4) + le16(4) + le16(16) +
            "LIST" + le32(700) + repeatByte("x", 700) +
            "data" + le32(pcm.length) + pcm;
        var fatInfo = parseWavHeader(fat.substr(0, 512), fat.length);
        if (fatInfo !== null) throw new Error("512-byte read should NOT see data yet");
        fatInfo = parseWavHeader(fat.substr(0, 2048), fat.length);
        if (!fatInfo) throw new Error("fat header did not parse");
        if (fatInfo.dataOffset !== 12 + 24 + 8 + 700 + 8)
            throw new Error("fat data offset wrong: " + fatInfo.dataOffset);
        if (fatInfo.dataBytes !== pcm.length)
            throw new Error("fat data bytes wrong");

        // Feature extraction: a loud sine has high RMS and some crossings;
        // silence has neither.
        var loud = chunkFeatures(pcm, 2);
        if (!(loud.rms > 0.4)) throw new Error("sine rms too low: " + loud.rms);
        if (!(loud.zcr > 0)) throw new Error("sine zcr zero");
        var quiet = chunkFeatures(repeatByte("\x00", 4000), 2);
        if (quiet.rms !== 0 || quiet.raw !== 0) throw new Error("silence rms nonzero");
        if (!(loud.raw > 0.15)) throw new Error("sine raw rms too low: " + loud.raw);

        // ANSI grid: SAUCE strip, wrap-at-width, SGR attrs, cursor-forward.
        var sauced = "hello" + "\x1a" + repeatByte("\x00", 100) +
            "SAUCE00" + repeatByte("z", 121);
        if (FLAnsiGrid.stripSauce(sauced) !== "hello")
            throw new Error("SAUCE strip failed");
        var artSrc = "\x1b[1;31mAB\x1b[44m\x1b[3CC\r\nD";
        var g = FLAnsiGrid.render(artSrc, 4);
        if (g.height < 2) throw new Error("grid height: " + g.height);
        if ((g.rows[0][0] & 0xff) !== 65 || (g.rows[0][1] & 0xff) !== 66)
            throw new Error("grid chars wrong");
        var attrA = g.rows[0][0] >> 8;
        if ((attrA & 0x0f) !== (0x08 | 4)) // bright red (CGA red=4)
            throw new Error("grid attr wrong: " + attrA);
        var attrC = g.rows[0][3] >> 8;
        if (((attrC >> 4) & 0x07) !== 1)   // blue bg (CGA blue=1)
            throw new Error("grid bg wrong: " + attrC);
        if ((g.rows[1][0] & 0xff) !== 68)  // 'D' after CRLF
            throw new Error("grid newline wrong");
        // Wrap: 5 chars at width 4 flow onto row 1.
        var g2 = FLAnsiGrid.render("ABCDE", 4);
        if ((g2.rows[1][0] & 0xff) !== 69) throw new Error("wrap failed");
        // Emit: positions + chars + hue rotation changes output.
        var em0 = FLAnsiGrid.emit(g2, 5, 3, 0, 1, 0, 4, 0);
        if (em0.indexOf("\x1b[3;5H") !== 0) throw new Error("emit origin wrong");
        if (em0.indexOf("ABCD") < 0) throw new Error("emit chars wrong");
        var emRot = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 1);
        var emPlain = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 0);
        if (emRot === emPlain) throw new Error("hue rotation is a no-op");
        // BIN avatar decode: 10x6 cells, char+attr pairs.
        var bin = "";
        for (var bi = 0; bi < 60; bi++)
            bin += String.fromCharCode(65 + (bi % 26)) + String.fromCharCode(0x1f);
        var av = FLAnsiGrid.renderBin(bin, 10, 6);
        if (!av || av.height !== 6 || (av.rows[0][0] & 0xff) !== 65)
            throw new Error("renderBin failed");

        // Key normalization: every arrow representation -> the cursor code.
        var nk: [string, string][] = [
            ["\x1b[A", "\x1e"], ["\x1bOA", "\x1e"], ["\x1e", "\x1e"],   // up
            ["\x1b[B", "\x0a"], ["\x1bOB", "\x0a"], ["\x0a", "\x0a"],   // down
            ["\x1b[5~", "\x10"], ["\x1b[6~", "\x0e"],                   // pgup/pgdn
            ["\x1b[H", "\x02"], ["\x1b[F", "\x05"],                     // home/end
            ["\x1b", "\x1b"], ["\r", "\r"], ["a", "a"], [" ", " "],     // esc/enter/letter/space
            ["\x1b[=7;2;0n", ""]                                        // APC reply -> ignored
        ];
        for (var nki = 0; nki < nk.length; nki++) {
            if (normalizeKey(nk[nki][0]) !== nk[nki][1])
                throw new Error("normalizeKey " + JSON.stringify(nk[nki][0]) + " -> " +
                    JSON.stringify(normalizeKey(nk[nki][0])) + " want " + JSON.stringify(nk[nki][1]));
        }

        // Avatar flash rotation: BLACK (fg 0) pinned, LIGHTGRAY (fg 7) moves.
        var fg: any = { width: 2, height: 1, rows: [[(0x00 << 8) | 0x41, (0x07 << 8) | 0x42]] };
        var fs = FLAnsiGrid.emitFlash(fg, 1, 1, 0, 1, 0, 2, 5);
        if (fs.indexOf(";30;") < 0) throw new Error("emitFlash moved BLACK");
        if (fs.indexOf(";37;") >= 0) throw new Error("emitFlash left LIGHTGRAY unchanged");

        // Horizontal mirror: cells reverse per row and directional glyphs swap.
        var mg = FLAnsiGrid.render("/(\xDD", 3);
        var mm = FLAnsiGrid.mirror(mg);
        if ((mm.rows[0][0] & 0xff) !== 0xde) throw new Error("half-block not mirrored");
        if ((mm.rows[0][1] & 0xff) !== 0x29) throw new Error("paren not mirrored");
        if ((mm.rows[0][2] & 0xff) !== 0x5c) throw new Error("slash not mirrored");
        if ((mm.rows[0][2] >> 8) !== (mg.rows[0][0] >> 8)) throw new Error("mirror lost attrs");

        // Lyrics: timed lookup walks forward and resets after a back-seek;
        // distribution spaces untimed lines evenly.
        var ly = [{ time: 5, text: "one" }, { time: 10, text: "two" }, { time: 20, text: "three" }];
        if (lyricIndexFor(ly, 3, -1) !== -1) throw new Error("lyric before-first wrong");
        if (lyricIndexFor(ly, 12, 0) !== 1) throw new Error("lyric walk wrong");
        if (lyricIndexFor(ly, 6, 2) !== 0) throw new Error("lyric back-seek wrong");
        var dist = distributeLyrics("a\n\nb\nc", 40);
        if (dist.length !== 3 || Math.abs(dist[0].time - 10) > 0.01)
            throw new Error("lyric distribution wrong");

        // Base64 sanity over binary bytes.
        var rt = base64_decode(base64_encode(wav.substr(0, 200)));
        if (rt !== wav.substr(0, 200)) throw new Error("base64 round trip failed");

        // Reply parser: feature reply, drain notify, arrows, keys, lone ESC.
        var p = new InputPump();
        var res: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (p as any).buf = "\x1b[=7;100;1nq\x1b[C\x1b[=7;2;0n\x1b";
        (p as any).drain(res, true);
        if (res.audio.length !== 2) throw new Error("audio events: " + res.audio.length);
        if (res.audio[0][0] !== 100 || res.audio[0][1] !== 1) throw new Error("feature reply parse");
        if (res.audio[1][0] !== 2 || res.audio[1][1] !== 0) throw new Error("drain notify parse");
        if (res.keys.length !== 1 || res.keys[0] !== "Q") throw new Error("key parse");
        if (res.arrows.length !== 1 || res.arrows[0] !== "right") throw new Error("arrow parse");
        if (res.esc) throw new Error("lone ESC resolved too eagerly");
        (p as any).escAt = nowMs() - 300;   // aged past the patience window
        (p as any).buf = "\x1b";
        (p as any).drain(res, true);
        if (!res.esc) throw new Error("aged lone ESC did not resolve");

        // SS3 / application-cursor arrows (ESC O A..D): decode as arrows, never
        // as a bare Esc plus a stray letter. Also: a split SS3 must wait, not
        // mis-fire.
        var pSS3 = new InputPump();
        var rSS3: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pSS3 as any).buf = "\x1bOA\x1bOB\x1bOC\x1bOD";
        (pSS3 as any).drain(rSS3, true);
        if (rSS3.arrows.join(",") !== "up,down,right,left")
            throw new Error("SS3 arrow parse: " + rSS3.arrows.join(","));
        if (rSS3.esc || rSS3.keys.length) throw new Error("SS3 arrows leaked esc/keys");
        var pSS3s = new InputPump();
        var rSS3s: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pSS3s as any).buf = "\x1bO";
        (pSS3s as any).drain(rSS3s, true);
        if (rSS3s.esc || rSS3s.arrows.length) throw new Error("partial SS3 resolved too eagerly");
        (pSS3s as any).buf += "A";
        (pSS3s as any).drain(rSS3s, true);
        if (rSS3s.arrows.length !== 1 || rSS3s.arrows[0] !== "up")
            throw new Error("split SS3 did not resolve to up");

        // Synchronet cooks cursor keys into single control bytes (console.inkey);
        // the pump must surface those as arrows. KEY_DOWN (\x0a) must NOT read as
        // Enter -- that made the song list's Down arrow play the track.
        var pNav = new InputPump();
        var rNav: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pNav as any).buf = "\x1e\x0a\x1d\x06\x10\x0e\x02\x05";
        (pNav as any).drain(rNav, true);
        if (rNav.arrows.join(",") !== "up,down,left,right,pgup,pgdn,home,end")
            throw new Error("cooked nav parse: " + rNav.arrows.join(","));
        if (rNav.keys.length) throw new Error("cooked nav leaked keys: " + rNav.keys.join(","));

        // The killer case: an audio notify split right after its ESC byte
        // must NOT become Esc + plain chars (the phantom 'N' bug).
        var pSplit = new InputPump();
        var rSplit: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pSplit as any).buf = "\x1b";
        (pSplit as any).drain(rSplit, true);    // pump boundary hits mid-sequence
        (pSplit as any).buf += "[=7;2;0n";      // the rest arrives next pump
        (pSplit as any).drain(rSplit, true);
        if (rSplit.esc) throw new Error("split notify produced phantom Esc");
        if (rSplit.keys.length) throw new Error("split notify leaked keys: " + rSplit.keys.join(","));
        if (rSplit.audio.length !== 1 || rSplit.audio[0][0] !== 2 || rSplit.audio[0][1] !== 0)
            throw new Error("split notify not reassembled");
        var p3 = new InputPump();
        var r3: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (p3 as any).buf = "\x1b[74;162R";
        (p3 as any).drain(r3, true);
        if (r3.cpr.length !== 1 || r3.cpr[0][0] !== 74 || r3.cpr[0][1] !== 162)
            throw new Error("CPR parse failed");

        // Every palette map must be a permutation of 0..7 (no color loss).
        for (var pi = 0; pi < FLAnsiGrid.PALETTES.length; pi++) {
            var seenIdx: { [k: number]: boolean } = {};
            for (var pj = 0; pj < 8; pj++)
                seenIdx[FLAnsiGrid.PALETTES[pi][pj]] = true;
            for (var pk = 0; pk < 8; pk++)
                if (!seenIdx[pk]) throw new Error("palette " + pi + " not a permutation");
        }

        // Orphaned notify tail (the flight-recorder shred): the engine ate
        // the ESC; the bare tail must become an audio event, NOT keys ending
        // in a phantom 'N'.
        var pOrf = new InputPump();
        var rOrf: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pOrf as any).buf = "[=7;2;0n";
        (pOrf as any).drain(rOrf, true);
        if (rOrf.keys.length) throw new Error("orphan tail leaked keys: " + rOrf.keys.join(""));
        if (rOrf.audio.length !== 1 || rOrf.audio[0][0] !== 2 || rOrf.audio[0][1] !== 0)
            throw new Error("orphan tail not recovered as audio");
        // Orphaned CPR tail likewise.
        var rOrf2: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pOrf as any).buf = "[74;162R";
        (pOrf as any).drain(rOrf2, true);
        if (rOrf2.keys.length || rOrf2.cpr.length !== 1 || rOrf2.cpr[0][0] !== 74)
            throw new Error("orphan CPR not recovered");
        // A real '[' keystroke still gets through once aged.
        var rOrf3: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (pOrf as any).buf = "[";
        (pOrf as any).bracketAt = nowMs() - 300;
        (pOrf as any).drain(rOrf3, true);
        if (rOrf3.keys.length !== 1 || rOrf3.keys[0] !== "[")
            throw new Error("aged bracket keystroke lost");

        // Split CSI across feeds must not produce phantom keys.
        var p2 = new InputPump();
        var r2: PumpResult = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        (p2 as any).buf = "\x1b[=7;2";
        (p2 as any).drain(r2, false);
        if (r2.keys.length || r2.audio.length || r2.esc) throw new Error("partial CSI leaked");
        (p2 as any).buf += ";0n";
        (p2 as any).drain(r2, true);
        if (r2.audio.length !== 1) throw new Error("resumed CSI lost");

        // Margin rects: bottom flanks exist beside the box and never cover
        // the box span itself.
        var fakeL: Layout = {
            cols: 120, rows: 40, boxTop: 36, boxLeft: 23, boxWidth: 76,
            glowRow1: 33, lyricRow: 34, lyricLeft: 23, lyricWidth: 76,
            glowRow2: 35, artTop: 1, artBottom: 32
        };
        // Lyric strip grows past the box on a wide terminal with long lines,
        // but never below the box width, and stays capped at cols-2.
        if (layout(120, 40, 100).lyricWidth !== 102) throw new Error("lyric grow");
        if (layout(120, 40, 40).lyricWidth !== 76) throw new Error("lyric no-shrink");
        if (layout(80, 40, 200).lyricWidth !== 78) throw new Error("lyric cap to cols");
        var fakeBlit: ArtBlit = {
            grid: { width: 80, height: 30, rows: [] }, left: 21, top: 2,
            srcRow: 0, srcCol: 0, nRows: 30, nCols: 80, pal: 0
        };
        var mrs = marginRects(fakeL, fakeBlit);
        var stripRows = false;
        var flankL = false;
        var flankR = false;
        for (var mi = 0; mi < mrs.length; mi++) {
            var mr = mrs[mi];
            // Full-width strips over the glow/lyric rows (text rides on top).
            if (mr.y === fakeL.glowRow1 && mr.h === 3 && mr.x === 1 && mr.w === fakeL.cols)
                stripRows = true;
            // Box-row flanks around the opaque box.
            if (mr.y === fakeL.boxTop && mr.x === 1 && mr.x + mr.w - 1 === fakeL.boxLeft - 1)
                flankL = true;
            if (mr.y === fakeL.boxTop && mr.x === fakeL.boxLeft + fakeL.boxWidth)
                flankR = true;
            // The one hard invariant: nothing may overlap the box RECT itself
            // (box rows AND box columns simultaneously).
            var rowsHit = mr.y <= fakeL.boxTop + 3 && mr.y + mr.h - 1 >= fakeL.boxTop;
            var colsHit = mr.x <= fakeL.boxLeft + fakeL.boxWidth - 1 &&
                mr.x + mr.w - 1 >= fakeL.boxLeft;
            if (rowsHit && colsHit)
                throw new Error("margin rect overlaps the box rect");
        }
        if (!stripRows) throw new Error("glow/lyric strip rects missing");
        if (!flankL || !flankR) throw new Error("box-row flanks missing");
        for (var sc = 0; sc < mrs.length; sc++) {
            var sr = mrs[sc];
            if (sr.y + sr.h - 1 >= fakeL.rows && sr.x + sr.w - 1 >= fakeL.cols)
                throw new Error("margin rect covers the bottom-right cell (scroll bug)");
        }

        writeln("FLPlayer self-test: OK");

        // Optional end-to-end leg: --selftest <mp3path> exercises the real
        // ffmpeg transcode + header parse + slicing on an actual track.
        var mp3 = "";
        if (typeof argv !== "undefined" && argv) {
            for (var ai = 0; ai < argv.length; ai++) {
                if (argv[ai] !== "--selftest" && file_exists(argv[ai]))
                    mp3 = argv[ai];
            }
        }
        if (mp3.length) {
            if (!ffmpegAvailable()) throw new Error("ffmpeg not available");
            var t: PlayableTrack = {
                path: mp3,
                name: "selftest.mp3",
                size: file_size(mp3),
                mtime: file_date(mp3),
                title: "Self Test",
                artist: "",
                ansiArt: ""
            };
            var wp = ensureTranscoded(t);
            if (wp === null) throw new Error("transcode failed");
            var tf = new File(wp);
            if (!tf.open("rb")) throw new Error("cache open failed");
            var inf = readWavInfo(tf);
            if (!inf) { tf.close(); throw new Error("ffmpeg WAV did not parse"); }
            var bps = inf.rate * inf.channels * 2;
            var chunkB = Math.floor(bps * CHUNK_MS / 1000);
            chunkB -= chunkB % (inf.channels * 2);
            // Slice a mid-song chunk and make sure it yields features + b64.
            var midChunk = Math.floor((inf.dataBytes / chunkB) / 2);
            tf.position = inf.dataOffset + midChunk * chunkB;
            var slice = tf.read(chunkB);
            tf.close();
            if (!slice || slice.length !== chunkB) throw new Error("slice read failed");
            var feats = chunkFeatures(slice, inf.channels);
            var b64len = base64_encode(wavHeader(slice.length, inf.rate, inf.channels) + slice).length;
            writeln(format("FLPlayer transcode test: OK  rate=%d ch=%d duration=%ds chunks=%d chunkB64=%d rms=%s zcr=%s",
                inf.rate, inf.channels, Math.round(inf.dataBytes / bps),
                Math.ceil(inf.dataBytes / chunkB), b64len,
                feats.rms.toFixed(2), feats.zcr.toFixed(2)));
        }
    }
}

declare function writeln(text: string): void;
