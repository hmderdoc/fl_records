/*
 * uifc console shim — makes the uifc-based UI run in-process (`cmd=?fl_records.js`).
 *
 * The real `uifc` object only exists under jsexec; the terminal server's JS
 * runtime does not provide it. This file installs a console-backed
 * implementation of the subset this door uses (init/bail/msg/input/list/
 * showbuf/help_text + list.CTX) when — and only when — `uifc` is undefined,
 * so the door behaves identically under jsexec and in-process.
 *
 * Lives in src/ deliberately: the previous fix for this lived as hand edits
 * in the BUILT fl_records.js and was lost by a rebuild. Everything must be
 * in src/ so `tsc` output is always the whole program.
 */
var FLUifcShim;
(function (FLUifcShim) {
    // Self-provide sbbsdefs constants (K_NONE/K_EDIT/K_LINE): load() scopes
    // to the caller, so the door IIFE's own load is invisible here. See the
    // matching note in player.ts.
    load("sbbsdefs.js");
    var ESC = "\x1b";
    function scrCols() {
        return Math.max(40, console.screen_columns || 80);
    }
    function scrRows() {
        return Math.max(10, console.screen_rows || 24);
    }
    function sgr(codes) {
        return "\x1b[" + codes + "m";
    }
    function gotoRC(row, col) {
        return "\x1b[" + row + ";" + col + "H";
    }
    function rep(ch, n) {
        var out = "";
        while (out.length < n)
            out += ch;
        return out.substr(0, n);
    }
    function fit(text, width) {
        var t = String(text === undefined || text === null ? "" : text);
        if (t.length > width)
            t = width > 3 ? t.substr(0, width - 3) + "..." : t.substr(0, width);
        return t + rep(" ", width - t.length);
    }
    // Word-wrap plain text into lines no wider than `width` (for multi-line
    // help hints at the bottom of a menu, instead of one truncated line).
    function wrapLines(text, width) {
        var words = String(text || "").split(/\s+/);
        var lines = [];
        var cur = "";
        var i;
        for (i = 0; i < words.length; i++) {
            if (!words[i].length)
                continue;
            if (!cur.length)
                cur = words[i];
            else if (cur.length + 1 + words[i].length <= width)
                cur += " " + words[i];
            else {
                lines.push(cur);
                cur = words[i];
            }
        }
        if (cur.length)
            lines.push(cur);
        return lines;
    }
    // A centered double-line box; returns the interior origin/size.
    function drawBox(title, innerRows, innerCols) {
        var cols = Math.min(innerCols + 4, scrCols() - 2);
        var inner = cols - 4;
        var rows = Math.min(innerRows, scrRows() - 4);
        var top = Math.max(1, Math.floor((scrRows() - (rows + 2)) / 2));
        var left = Math.max(1, Math.floor((scrCols() - cols) / 2) + 1);
        var t = " " + String(title || "") + " ";
        if (t.length > inner)
            t = t.substr(0, inner);
        var head = rep("\xCD", Math.floor((cols - 2 - t.length) / 2)) + t;
        head += rep("\xCD", cols - 2 - head.length);
        console.write(sgr("0;1;36") + gotoRC(top, left) + "\xC9" + head + "\xBB");
        for (var r = 0; r < rows; r++) {
            console.write(gotoRC(top + 1 + r, left) + "\xBA" +
                sgr("0") + rep(" ", cols - 2) + sgr("0;1;36") + "\xBA");
        }
        console.write(gotoRC(top + 1 + rows, left) + "\xC8" + rep("\xCD", cols - 2) + "\xBC" + sgr("0"));
        return { top: top + 1, left: left + 2, rows: rows, cols: inner };
    }
    // Map any arrow representation (cooked byte / raw CSI "[A" / raw SS3 "OA")
    // to the cursor code the menu handles; other keys pass through first char.
    function normKey(k) {
        if (!k || !k.length)
            return "";
        if (k.charAt(0) === "\x1b" && k.length >= 2) {
            var s = k.substr(1);
            if (s === "[A" || s === "OA")
                return "\x1e"; // up
            if (s === "[B" || s === "OB")
                return "\x0a"; // down
            if (s === "[C" || s === "OC")
                return "\x06"; // right
            if (s === "[D" || s === "OD")
                return "\x1d"; // left
            if (s === "[H" || s === "OH" || s === "[1~" || s === "[7~")
                return "\x02"; // home
            if (s === "[F" || s === "OF" || s === "[4~" || s === "[8~")
                return "\x05"; // end
            if (s === "[5~")
                return "\x10"; // pgup
            if (s === "[6~")
                return "\x0e"; // pgdn
            return ""; // unknown escape sequence -> ignore
        }
        return k.charAt(0);
    }
    // Self-contained key read (NO dependency on the FLPlayer namespace -- this
    // shim lives in the persistent global uifc, so it must not close over any
    // per-launch scope). console.inkey delivers an arrow byte-by-byte, so on
    // ESC we assemble the CSI/SS3 sequence before deciding. K_NOECHO|K_NOSPIN
    // like future_shell.
    function waitKey() {
        var mode = (typeof K_NOECHO !== "undefined" ? K_NOECHO : 0) |
            (typeof K_NOSPIN !== "undefined" ? K_NOSPIN : 0);
        for (;;) {
            if (!bbs.online || js.terminated)
                return ESC;
            var k = console.inkey(mode, 200);
            if (typeof k !== "string" || !k.length)
                continue;
            if (k.length > 1) {
                var nWhole = normKey(k);
                if (nWhole)
                    return nWhole;
                continue;
            }
            if (k !== "\x1b")
                return k; // cooked cursor code or plain key
            var seq = "";
            for (var i = 0; i < 8; i += 1) {
                var c = console.inkey(mode, 60);
                if (typeof c !== "string" || !c.length)
                    break;
                seq += c;
                if (seq.charAt(0) !== "[" && seq.charAt(0) !== "O")
                    break;
                if (seq.charAt(0) === "O") {
                    if (seq.length >= 2)
                        break;
                    else
                        continue;
                }
                if (seq.length >= 2) {
                    var last = seq.charAt(seq.length - 1);
                    if (last >= "@" && last <= "~" && !(last >= "0" && last <= "9") && last !== ";")
                        break;
                }
            }
            if (!seq.length)
                return "\x1b"; // lone Esc
            var nSeq = normKey("\x1b" + seq);
            if (nSeq)
                return nSeq; // else unknown -> keep waiting
        }
    }
    // ---- the shim object ----------------------------------------------------
    function CTX() {
        this.cur = 0;
        this.bar = 0;
        this.left = 0;
        this.top = 0;
        this.width = 0;
    }
    function shimList(mode, title, options, ctx) {
        if (!options || !options.length)
            return -1;
        var widest = 10;
        for (var i = 0; i < options.length; i++)
            widest = Math.max(widest, String(options[i]).length);
        widest = Math.min(widest, scrCols() - 8);
        var visible = Math.min(options.length, scrRows() - 6);
        var cur = ctx && typeof ctx.cur === "number" ? ctx.cur : 0;
        cur = cur < 0 ? 0 : (cur >= options.length ? options.length - 1 : cur);
        var top = Math.max(0, Math.min(cur - Math.floor(visible / 2), options.length - visible));
        console.clear();
        var box = drawBox(title, visible, widest);
        var helpText = shim.help_text || "";
        if (helpText.length) {
            // Word-wrap the hint across the rows below the box (up to 3), instead
            // of clipping it to one line -- so the compose menus can explain
            // themselves. Centered + short, so it never touches the corner cell.
            var hlines = wrapLines(helpText, scrCols() - 4);
            var room = scrRows() - (box.top + box.rows);
            var nHelp = Math.min(hlines.length, 3, Math.max(0, room));
            var startRow = scrRows() - nHelp + 1;
            for (var hli = 0; hli < nHelp; hli++) {
                var hl = hlines[hli];
                console.write(gotoRC(startRow + hli, Math.max(1, Math.floor((scrCols() - hl.length) / 2))) +
                    sgr("0;30;1") + hl + sgr("0"));
            }
            shim.help_text = "";
        }
        function paint() {
            for (var r = 0; r < visible; r++) {
                var idx = top + r;
                var line = idx < options.length ? fit(String(options[idx]), box.cols) : rep(" ", box.cols);
                console.write(gotoRC(box.top + r, box.left) +
                    (idx === cur ? sgr("0;37;44") : sgr("0;37")) + line + sgr("0"));
            }
        }
        paint();
        while (bbs.online && !js.terminated) {
            var k = waitKey();
            if (k === "\x1e" || k === "8") { // up
                cur = cur > 0 ? cur - 1 : options.length - 1;
            }
            else if (k === "\x0a" || k === "2") { // down
                cur = cur + 1 < options.length ? cur + 1 : 0;
            }
            else if (k === "\x10") { // page up (KEY_PAGEUP)
                cur = Math.max(0, cur - visible);
            }
            else if (k === "\x0e") { // page down (KEY_PAGEDN)
                cur = Math.min(options.length - 1, cur + visible);
            }
            else if (k === "\x02") { // home
                cur = 0;
            }
            else if (k === "\x05" || k === "\x03") { // end (KEY_END)
                cur = options.length - 1;
            }
            else if (k === "\r" || k === "\n") {
                if (ctx)
                    ctx.cur = cur;
                return cur;
            }
            else if (k === ESC || k === "q" || k === "Q" || k === "\b" || k === "\x7f") {
                // Backspace (\x08/\x7f) closes the fly menu, like Esc.
                if (ctx)
                    ctx.cur = cur;
                return -1;
            }
            else if (ctx && ctx.actionKeys && k &&
                ctx.actionKeys[k.toUpperCase()] !== undefined) {
                // Caller-defined hotkey: remember the row and return its
                // sentinel so the caller can act on the highlighted item
                // (e.g. "T" opens track details from the song list).
                ctx.cur = cur;
                return ctx.actionKeys[k.toUpperCase()];
            }
            if (cur < top)
                top = cur;
            if (cur >= top + visible)
                top = cur - visible + 1;
            paint();
        }
        return -1;
    }
    var shim = {
        FLSHIM: true,
        help_text: "",
        init: function (title, mode) {
            console.clear();
            return true;
        },
        bail: function () {
            console.write(sgr("0"));
        },
        msg: function (text) {
            console.clear();
            var lines = String(text).split("\n");
            var widest = 10;
            for (var i = 0; i < lines.length; i++)
                widest = Math.max(widest, lines[i].length);
            var box = drawBox("Message", Math.min(lines.length + 1, scrRows() - 6), widest);
            for (var r = 0; r < Math.min(lines.length, box.rows); r++)
                console.write(gotoRC(box.top + r, box.left) + sgr("0;37") +
                    fit(lines[r], box.cols) + sgr("0"));
            console.write(gotoRC(box.top + box.rows - 1, box.left) + sgr("0;30;1") +
                fit("[ Press any key ]", box.cols) + sgr("0"));
            waitKey();
        },
        input: function (mode, prompt, initial, maxLen) {
            console.clear();
            var max = maxLen && maxLen > 0 ? maxLen : 60;
            var box = drawBox(prompt, 2, Math.min(max + 2, scrCols() - 10));
            console.write(gotoRC(box.top, box.left) + sgr("0;37"));
            // K_EDIT preloads the initial value for editing when supported.
            var got = console.getstr(String(initial || ""), max, K_EDIT | K_LINE);
            console.write(sgr("0"));
            if (got === null || got === undefined)
                return "";
            return String(got);
        },
        showbuf: function (mode, title, text) {
            console.clear();
            var lines = String(text).split("\n");
            var page = scrRows() - 5;
            var offset = 0;
            for (;;) {
                console.clear();
                var box = drawBox(title, page, scrCols() - 8);
                for (var r = 0; r < page; r++) {
                    var idx = offset + r;
                    console.write(gotoRC(box.top + r, box.left) + sgr("0;37") +
                        fit(idx < lines.length ? lines[idx] : "", box.cols) + sgr("0"));
                }
                console.write(gotoRC(scrRows(), 2) + sgr("0;30;1") +
                    "[Up/Down/PgUp/PgDn scroll, Q/Esc done]" + sgr("0"));
                var k = waitKey();
                if (k === ESC || k === "q" || k === "Q" || k === "\r")
                    return;
                if ((k === "\x1e" || k === "8") && offset > 0)
                    offset--;
                else if ((k === "\x0a" || k === "2") && offset + page < lines.length)
                    offset++;
                else if (k === "\x10")
                    offset = Math.max(0, offset - page);
                else if (k === "\x0e")
                    offset = Math.min(Math.max(0, lines.length - page), offset + page);
            }
        },
        list: null
    };
    shim.list = shimList;
    shimList.CTX = CTX;
    // Install only where the real uifc is absent (in-process door runs).
    // Install in-process. Reinstall when a STALE shim from a prior door launch
    // is still sitting in the persistent global uifc (its closures point at a
    // dead scope) -- but never clobber the real uifc (jsexec), which has no
    // FLSHIM marker.
    if (typeof uifc === "undefined" || (uifc && uifc.FLSHIM)) {
        js.global.uifc = shim;
    }
})(FLUifcShim || (FLUifcShim = {}));
var FLRecordsData;
(function (FLRecordsData) {
    FLRecordsData.hybridPresetFields = [
        "genre",
        "feel",
        "tone",
        "arrangement",
        "instrumentation",
        "groove",
        "band",
        "leadvocal",
        "backingvocal"
    ];
    FLRecordsData.sectionDefs = [
        { key: "intro", label: "Intro" },
        { key: "verse1", label: "Verse 1" },
        { key: "chorus", label: "Chorus" },
        { key: "verse2", label: "Verse 2" },
        { key: "bridge", label: "Bridge" },
        { key: "outro", label: "Outro" }
    ];
    FLRecordsData.presetOptions = {
        genre: [
            "Futurepop / Synthpop",
            "Electropop",
            "Synth-Funk",
            "Synthwave",
            "Darksynth",
            "Retrowave",
            "Vaporwave",
            "Chillwave",
            "Hyperpop",
            "House / Disco Hybrid",
            "Deep House",
            "Tech House",
            "Progressive House",
            "Afro House",
            "Acid House",
            "Chicago House",
            "French Touch",
            "Nu-Disco",
            "Italo Disco",
            "Eurodance",
            "Techno",
            "Detroit Electro",
            "Minimal Techno",
            "Dub Techno",
            "EBM (Electronic Body Music)",
            "Ambient Techno",
            "Breakbeat",
            "Big Beat",
            "Jungle",
            "Drum & Bass",
            "Liquid Drum & Bass",
            "Darkstep / Neurofunk",
            "Dubstep",
            "Future Bass",
            "UK Garage",
            "Grime",
            "Jersey Club",
            "2-Step Garage",
            "Bassline / Speed Garage",
            "Trip-Hop",
            "Downtempo",
            "Lo-Fi Beats",
            "Ambient",
            "New Age / Space Music",
            "Balearic / Sunset Chill",
            "Trance",
            "Psytrance",
            "Progressive Trance",
            "Vocal Trance",
            "Boom-Bap Hip-Hop",
            "Trap",
            "Cloud Rap",
            "Phonk",
            "Neo-Soul",
            "Contemporary R&B",
            "Electrofunk",
            "Funk",
            "Boogie",
            "G-Funk",
            "Post-Punk",
            "Gothic Rock",
            "Shoegaze",
            "Dream Pop",
            "Noise Pop",
            "Indie Rock",
            "Garage Rock",
            "Surf Rock",
            "Psychedelic Rock",
            "Stoner Rock / Desert Rock",
            "Grunge",
            "Pop Punk",
            "Hardcore Punk",
            "Skate Punk / Melodic Punk",
            "Emo / Post-Emo",
            "Screamo / Skramz",
            "Punkfuture",
            "Metal Future",
            "Industrial Metal",
            "Industrial Pop",
            "Thrash Metal",
            "Progressive Metal",
            "Djent",
            "Doom Metal",
            "Black Metal",
            "Metalcore / Post-Hardcore",
            "Math Rock",
            "Post-Rock",
            "Post-Metal",
            "Neue Deutsche Harte",
            "Darkwave",
            "Coldwave",
            "Witch House",
            "Dark Ambient",
            "Aggrotech",
            "Industrial Electro",
            "Deathrock",
            "Dance-Pop",
            "Bubblegum Pop",
            "Art Pop",
            "Experimental Pop",
            "Chamber Pop",
            "Baroque Pop",
            "K-Pop Futurism",
            "City Pop",
            "J-Pop / Shibuya-kei",
            "Twee Pop",
            "Jazz Fusion",
            "Acid Jazz",
            "Nu Jazz / Jazztronica",
            "Smooth Jazz",
            "Bebop",
            "Free Jazz / Avant-Garde Jazz",
            "Jazz Rap",
            "Ska",
            "Ska Punk",
            "Reggae",
            "Dub",
            "Dancehall",
            "Lovers Rock",
            "Reggaeton",
            "Latin House",
            "Cumbia Digital",
            "Bossa Nova",
            "Tropicalia",
            "Afrobeat",
            "Amapiano",
            "Kuduro",
            "Dembow",
            "Soca",
            "Calypso",
            "Celtic / Folk-Electronic",
            "Balkan Beat",
            "Bollywood Fusion",
            "Middle Eastern Electronic",
            "Tuareg Desert Blues",
            "Highlife",
            "Soukous",
            "Fado (modernized)",
            "Flamenco Fusion",
            "Klezmer Punk",
            "Outlaw Country",
            "Alt-Country / Americana",
            "Country Pop",
            "Cosmic Country",
            "Western Swing",
            "Electric Blues",
            "Delta Blues (modernized)",
            "Northern Soul",
            "Classic Soul",
            "Gospel",
            "Motown",
            "Neoclassical",
            "Orchestral Cinematic",
            "Classical Crossover",
            "Minimal / Post-Minimal",
            "Glitch",
            "IDM (Intelligent Dance Music)",
            "Noise",
            "Drone",
            "Musique Concrete",
            "Plunderphonics",
            "Hauntology / Ghost Box",
            "Chiptune",
            "Bitpop",
            "Video Game Soundtrack",
            "Nintendocore",
            "Footwork / Juke",
            "Hardstyle",
            "Gabber / Hardcore",
            "Happy Hardcore",
            "Speedcore",
            "Breakcore",
            "Folktronica",
            "Indietronica",
            "Electro Swing",
            "Steampunk Cabaret"
        ],
        feel: [
            "euphoric and driving",
            "warm and intimate",
            "swaggering and playful",
            "melancholy but resilient",
            "hypnotic and nocturnal",
            "tense and cinematic",
            "romantic and weightless",
            "aggressive and kinetic",
            "loose and human",
            "glossy and triumphant",
            "dreamy and dissociative",
            "brooding and stormy",
            "hopeful and wide-open",
            "shuffling and body-moving",
            "anxious and jittery",
            "bittersweet and reflective",
            "carefree and sun-drenched",
            "defiant and anthemic",
            "eerie and unsettling",
            "fierce and empowering",
            "haunted and longing",
            "irreverent and chaotic",
            "lazy and drifting",
            "majestic and soaring",
            "paranoid and claustrophobic",
            "peaceful and meditative",
            "raw and confessional",
            "sarcastic and detached",
            "sensual and slow-burning",
            "spiritual and transcendent",
            "vengeful and sharp-edged",
            "wistful and fading",
            "frantic and overwhelming",
            "celebratory and larger-than-life",
            "mysterious and fog-wrapped",
            "goofy and irreverent"
        ],
        tone: [
            "neon-lit and glossy",
            "gritty and raw",
            "organic and lived-in",
            "chrome-plated and futuristic",
            "dusty and tape-worn",
            "dark and haunted",
            "sun-bleached and nostalgic",
            "expensive and cinematic",
            "intimate and close-mic",
            "cold and mechanical",
            "lush and romantic",
            "playful and hyper-saturated",
            "cavernous and reverb-drenched",
            "crisp and hi-fi digital",
            "lo-fi and cassette-warm",
            "underwater and submerged",
            "smoggy and distortion-heavy",
            "crystalline and shimmering",
            "weathered and analog-decayed",
            "punchy and in-your-face",
            "spacious and wide-screen",
            "claustrophobic and compressed",
            "pastoral and open-air",
            "sepia-toned and vintage",
            "holographic and prismatic",
            "scorched and overdriven",
            "gossamer and barely-there",
            "monochrome and stark",
            "thick and syrupy",
            "brittle and fractured"
        ],
        arrangement: [
            "hook-first verse / chorus with a breakdown and final lift",
            "slow-burn intro into a hard chorus lift",
            "DJ-friendly extended mix with long transitions",
            "verse / pre-chorus / chorus / bridge pop structure",
            "chant-driven loop that grows in layers",
            "minimal opening that blooms into a maximal finish",
            "instrumental showcase between choruses",
            "call-and-response vocal arrangement",
            "cinematic rise with a final payoff chorus",
            "club tool structure with frequent drops and builds",
            "AABA classic song form with modern production",
            "through-composed narrative with no repeated sections",
            "verse / chorus / verse / chorus / double chorus out",
            "intro jam that locks a groove then adds vocals mid-song",
            "spoken-word intro into a beat-drop payoff",
            "strophic folk form with evolving instrumentation each verse",
            "medley / suite with distinct movements stitched together",
            "stripped acoustic open into full-band explosion",
            "tension-release cycles with no traditional chorus",
            "round-robin vocal sections trading lead between voices",
            "ambient first half into driving second half",
            "false ending followed by a surprise final section",
            "refrain-heavy anthem structure with singalong repetition",
            "duet structure alternating perspectives each verse"
        ],
        instrumentation: [
            "analog synth stack, live bass, and tight drum programming",
            "electric piano, dry drum kit, and rubbery bass",
            "FM synths, drum machines, and bright octave leads",
            "guitars, live drums, bass, and layered vocal doubles",
            "modular synth textures, sub bass, and restrained percussion",
            "horn section, clavinet, rhythm guitar, and live drums",
            "string pads, piano, arpeggiators, and gated drums",
            "breakbeat chops, samplers, bass guitar, and effect throws",
            "distorted guitars, synth bass, and machine percussion",
            "ska upstrokes, live brass, bass pocket, and snare-forward drums",
            "chiptune leads, crunchy drums, and wide supporting pads",
            "sitar, tabla, synth drones, and electronic percussion",
            "steel drums, congas, marimba, and slap bass",
            "pipe organ, choir pads, orchestral hits, and booming timpani",
            "turntable scratches, sampled horns, MPC drums, and 808 bass",
            "acoustic guitar, upright bass, brushed drums, and pedal steel",
            "theremin, tape loops, analog delay, and bowed vibraphone",
            "west-African kora, djembe, kalimba, and synth bass",
            "harpsichord, chamber strings, celeste, and programmed beats",
            "sax solo breaks, Rhodes keys, fingerstyle bass, and brushed snare",
            "prepared piano, granular textures, and field recordings",
            "banjo, fiddle, harmonica, and stomping percussion",
            "talkbox, wah guitar, slap bass, and tight hi-hats",
            "accordion, nylon guitar, hand claps, and shaker groove",
            "dual guitar attack, double kick drums, and growling bass",
            "harp, flute, glockenspiel, and soft mallet percussion",
            "massive detuned saw leads, sidechained pads, and sub-rattling 808s",
            "lap steel, wurlitzer, room-mic drums, and vintage spring reverb"
        ],
        groove: [
            "four-on-the-floor pulse with syncopated percussion",
            "laid-back pocket just behind the beat",
            "tight disco strut with open-hat lift",
            "swung breakbeat with ghost-note movement",
            "motorik pulse that never lets up",
            "half-time head-nod with low-end drag",
            "rolling jungle momentum",
            "ska upstroke bounce",
            "shuffling pocket with human push-pull",
            "locked electro snap",
            "dubwise lurch and spacious echoes",
            "New Orleans second-line swing",
            "bossa nova sway with brushed cross-stick",
            "trap hi-hat rolls with 808 bounce",
            "go-go swing with conga-driven push",
            "reggaeton dembow riddim",
            "footwork juke stutter at 160 BPM",
            "afrobeat polyrhythmic interlock",
            "waltz-time sway with electronic undercurrent",
            "soca party drive with rapid snare accents",
            "blast beat fury with double-kick barrage",
            "krautrock metronomic precision",
            "boom-bap boom-clap with vinyl crackle",
            "cumbia chugging offbeat",
            "swing-era big-band bounce",
            "glitchy stuttered micro-edits",
            "marching cadence with militaristic snare rolls",
            "surf-rock spring-reverb tom gallop"
        ],
        band: [
            "hybrid electronic band with expressive lead vocal",
            "tight five-piece live session band",
            "machine-precise producer duo and featured vocalist",
            "loose late-night bar band with real human imperfection",
            "virtuoso trio with rhythm-section chemistry",
            "club producer with hype vocal chops and stacked harmonies",
            "punk rhythm section with synth operator support",
            "dubwise studio crew with live overdubs",
            "orchestral-electronic ensemble with cinematic players",
            "solo bedroom producer with laptop and MIDI controller",
            "supergroup of session legends trading solos",
            "DJ and MC tandem with live turntablism",
            "string quartet augmented by subtle electronics",
            "big band horn section with rhythm combo",
            "all-vocal a cappella group with beatboxer",
            "power duo of guitar and drums only",
            "lo-fi four-track home-recording project",
            "Afrobeat-style large ensemble with multiple percussionists",
            "singer-songwriter with sparse piano accompaniment",
            "marching band reimagined with electronic backline"
        ],
        leadvocal: [
            "breathy femme lead",
            "soulful tenor lead",
            "androgynous synthpop lead",
            "gritty baritone lead",
            "sweet high-register pop lead",
            "detached coldwave lead",
            "animated punk lead",
            "silky neo-soul lead",
            "robotic vocoder lead",
            "spoken-word / half-sung lead",
            "theatrical glam lead",
            "rap-sung crossover lead",
            "deep bass / basso profondo lead",
            "raspy blues-rock belter",
            "airy falsetto lead",
            "operatic soprano lead",
            "gravel-voiced Tom Waits-style storyteller",
            "Auto-Tuned melodic rap lead",
            "whispery ASMR-close lead",
            "shouting hardcore lead",
            "crooning lounge-jazz lead",
            "nasal indie-folk lead",
            "chanting / mantra-style lead",
            "dual-voice harmony lead (two singers as one)",
            "growled / screamed metal lead",
            "yodel-inflected lead",
            "conversational talk-singing lead",
            "child-like innocent vocal lead"
        ],
        backingvocal: [
            "no background singers",
            "tight unison doubles",
            "airy female harmonies",
            "stacked mixed-gender chorus",
            "call-and-response hype voices",
            "gospel-style backing stack",
            "robotic vocoder choir",
            "whispered doubles and ghost harmonies",
            "punk gang vocals",
            "lush R&B harmony stack",
            "distant choir pad vocals",
            "octave doubles only",
            "barbershop-style close harmonies",
            "chanted crowd vocals",
            "ethereal wordless soprano ooh-ahhs",
            "doo-wop vocal group style",
            "throat-singing overtone textures",
            "children's choir accents",
            "sampled and pitched vocal chops",
            "layered self-harmony (one voice stacked many times)",
            "spoken-word ensemble recitation",
            "antiphonal split-stereo call and answer"
        ],
        language: [
            "English",
            "Instrumental / non-vocal",
            "Bilingual / code-switching",
            "English with Japanese hooks",
            "English with Korean hooks",
            "Spanish",
            "Japanese",
            "Korean",
            "French",
            "Portuguese",
            "German",
            "Italian",
            "Mandarin Chinese",
            "Cantonese",
            "Hindi",
            "Arabic",
            "Swahili",
            "Russian",
            "Swedish",
            "Icelandic",
            "Yoruba",
            "Tagalog / Filipino",
            "Hawaiian / Pidgin",
            "Turkish",
            "Hebrew",
            "Creole / Patois",
            "Constructed language / conlang",
            "Scat / vocables / nonsense syllables"
        ],
        key: [
            "C major",
            "C minor",
            "C Dorian",
            "C Mixolydian",
            "Db major",
            "Db minor",
            "D major",
            "D minor",
            "D Dorian",
            "Eb major",
            "Eb minor",
            "E major",
            "E minor",
            "E Phrygian",
            "F major",
            "F minor",
            "F Lydian",
            "F# major",
            "F# minor",
            "G major",
            "G minor",
            "G Mixolydian",
            "Ab major",
            "Ab minor",
            "A major",
            "A minor",
            "A Dorian",
            "A harmonic minor",
            "Bb major",
            "Bb minor",
            "B major",
            "B minor",
            "B Locrian",
            "C blues scale",
            "A blues scale",
            "E blues scale",
            "D Phrygian dominant (Spanish)",
            "A Hungarian minor",
            "Whole-tone scale",
            "Chromatic / atonal"
        ],
        timesig: [
            "4/4",
            "3/4",
            "6/8",
            "12/8",
            "5/4",
            "7/8",
            "2/4",
            "6/4",
            "9/8",
            "11/8",
            "7/4",
            "5/8",
            "mixed meter / shifting"
        ],
        bpmMode: [
            { value: "genre_default", label: "Match genre default" },
            { value: "slow_genre", label: "Slow for genre" },
            { value: "mid_genre", label: "Midtempo for genre" },
            { value: "fast_genre", label: "Fast for genre" },
            { value: "half_time", label: "Half-time feel" },
            { value: "double_time", label: "Double-time feel" },
            { value: "rubato", label: "Rubato / free tempo" },
            { value: "accelerando", label: "Gradual accelerando" },
            { value: "custom_numeric", label: "Custom numeric" }
        ]
    };
})(FLRecordsData || (FLRecordsData = {}));
/*
 * FLAnsiGrid — interpret CP437 ANSI art into a cell grid, then blit
 * arbitrary windows of it anywhere on screen.
 *
 * Classic .ans art has no newlines: it relies on the terminal wrapping at
 * column 80. Dumping it raw onto a wider terminal skews every row (and a
 * trailing SAUCE metadata record prints as garbage). Interpreting into a
 * grid fixes both, and gives us free extras: center/trim to any terminal
 * size, palette rotation for the beat visualizer without re-parsing, and
 * the same cell/attr model for 10x6 BIN avatars.
 *
 * Cell attr byte = CGA convention: fg 0-7 | bright 0x08 | bg<<4 | blink 0x80.
 */
var FLAnsiGrid;
(function (FLAnsiGrid) {
    var DEFAULT_ATTR = 0x07;
    var MAX_ROWS = 200;
    // CGA color index -> ANSI SGR foreground code (bg = +10).
    var CGA_TO_SGR = [30, 34, 32, 36, 31, 35, 33, 37];
    // SGR 30-37 parameter -> CGA index.
    var SGR_TO_CGA = [0, 4, 2, 6, 1, 5, 3, 7];
    // Palette maps: permutations of the CGA indices. Structure-preserving
    // (multicolor art stays multicolor — unlike a single-color strobe), with
    // black/white anchored so silhouettes and highlights survive the swap.
    FLAnsiGrid.PALETTES = [
        [0, 1, 2, 3, 4, 5, 6, 7], // 0 identity (the real art)
        [0, 5, 3, 1, 6, 4, 2, 7], // 1 hue rotate
        [0, 4, 1, 5, 2, 6, 3, 7], // 2 hue rotate, second step
        [0, 6, 5, 4, 3, 2, 1, 7], // 3 complement (cool<->warm)
        [0, 3, 6, 2, 5, 1, 4, 7], // 4 scramble (high contrast)
        // Colorizers: these MOVE the grays (7, and 8 even black), so
        // grayscale-heavy art gets washed in color instead of sitting still.
        [0, 1, 2, 3, 4, 5, 7, 6], // 5 amber: white <-> brown (bright = gold)
        [0, 1, 2, 7, 4, 5, 6, 3], // 6 ice: white <-> cyan
        [0, 1, 2, 3, 4, 7, 6, 5], // 7 neon: white <-> magenta
        [7, 1, 2, 3, 4, 5, 6, 0], // 8 negative: black <-> white flash
        // Black-movers: the void itself takes color, flooding the canvas.
        [1, 0, 2, 3, 4, 5, 6, 7], // 9 midnight: black <-> blue
        [1, 0, 2, 7, 4, 5, 6, 3], // 10 abyss duotone: black<->blue, white<->cyan
        [4, 1, 2, 3, 0, 5, 6, 7] // 11 ember: black <-> red
    ];
    /** Remove a trailing SAUCE record (and the EOF marker it follows). */
    function stripSauce(art) {
        if (art.length >= 128 && art.substr(art.length - 128, 7) === "SAUCE00") {
            var eof = art.lastIndexOf("\x1a");
            return eof >= 0 ? art.substr(0, eof) : art.substr(0, art.length - 128);
        }
        var bare = art.indexOf("\x1a");
        return bare >= 0 ? art.substr(0, bare) : art;
    }
    FLAnsiGrid.stripSauce = stripSauce;
    function blankRow(width) {
        var row = [];
        for (var i = 0; i < width; i++)
            row.push((DEFAULT_ATTR << 8) | 0x20);
        return row;
    }
    /** Interpret ANSI/CP437 bytes into a grid, wrapping at `width`. */
    function render(art, width) {
        var grid = { width: width, height: 0, rows: [] };
        var x = 0;
        var y = 0;
        var attr = DEFAULT_ATTR;
        var savedX = 0;
        var savedY = 0;
        function row(yy) {
            while (grid.rows.length <= yy)
                grid.rows.push(blankRow(width));
            if (yy + 1 > grid.height)
                grid.height = yy + 1;
            return grid.rows[yy];
        }
        function put(ch) {
            // Lazy wrap (last-column-flag semantics): a char written in the
            // final column leaves the cursor "hanging" and only wraps when
            // the NEXT printable arrives. Eager wrapping would double-space
            // art whose rows end exactly at the wrap column before a CRLF.
            if (x >= width) {
                x = 0;
                y++;
            }
            if (y >= MAX_ROWS)
                return;
            row(y)[x] = (attr << 8) | ch;
            x++;
        }
        function sgr(params) {
            var parts = params.length ? params.split(";") : ["0"];
            for (var i = 0; i < parts.length; i++) {
                var n = parts[i].length ? parseInt(parts[i], 10) : 0;
                if (isNaN(n))
                    continue;
                if (n === 0)
                    attr = DEFAULT_ATTR;
                else if (n === 1)
                    attr |= 0x08;
                else if (n === 2 || n === 22)
                    attr &= ~0x08;
                else if (n === 5 || n === 6)
                    attr |= 0x80;
                else if (n === 25)
                    attr &= ~0x80;
                else if (n === 7)
                    attr = ((attr & 0x07) << 4) | ((attr >> 4) & 0x07) | (attr & 0x88);
                else if (n >= 30 && n <= 37)
                    attr = (attr & 0xf8) | SGR_TO_CGA[n - 30];
                else if (n === 39)
                    attr = (attr & 0xf8) | 0x07;
                else if (n >= 40 && n <= 47)
                    attr = (attr & 0x8f) | (SGR_TO_CGA[n - 40] << 4);
                else if (n === 49)
                    attr = attr & 0x8f;
            }
        }
        var i = 0;
        var n = art.length;
        while (i < n && y < MAX_ROWS) {
            var c = art.charCodeAt(i) & 0xff;
            if (c === 0x1b && i + 1 < n && art.charAt(i + 1) === "[") {
                var j = i + 2;
                var body = "";
                while (j < n) {
                    var cc = art.charAt(j);
                    if (cc >= "@" && cc <= "~")
                        break;
                    body += cc;
                    j++;
                }
                var fin = j < n ? art.charAt(j) : "";
                i = j + 1;
                var p1 = parseInt(body, 10);
                if (isNaN(p1))
                    p1 = 1;
                if (fin === "m")
                    sgr(body);
                else if (fin === "C")
                    x = Math.min(width - 1, x + Math.max(1, p1));
                else if (fin === "D")
                    x = Math.max(0, x - Math.max(1, p1));
                else if (fin === "A")
                    y = Math.max(0, y - Math.max(1, p1));
                else if (fin === "B")
                    y = Math.min(MAX_ROWS - 1, y + Math.max(1, p1));
                else if (fin === "G")
                    x = Math.max(0, Math.min(width - 1, p1 - 1));
                else if (fin === "H" || fin === "f") {
                    var seg = body.split(";");
                    var rr = parseInt(seg[0], 10);
                    var ccol = parseInt(seg[1], 10);
                    y = Math.max(0, (isNaN(rr) ? 1 : rr) - 1);
                    x = Math.max(0, Math.min(width - 1, (isNaN(ccol) ? 1 : ccol) - 1));
                }
                else if (fin === "J") {
                    if (body === "2") {
                        grid.rows = [];
                        grid.height = 0;
                        x = 0;
                        y = 0;
                    }
                }
                else if (fin === "K") {
                    var r = row(y);
                    for (var k = x; k < width; k++)
                        r[k] = (attr << 8) | 0x20;
                }
                else if (fin === "s") {
                    savedX = x;
                    savedY = y;
                }
                else if (fin === "u") {
                    x = savedX;
                    y = savedY;
                }
                // anything else: ignored
                continue;
            }
            i++;
            if (c === 0x0d) {
                x = 0;
                continue;
            }
            if (c === 0x0a) {
                x = 0;
                y++;
                continue;
            }
            if (c === 0x1a)
                break; // EOF marker
            if (c === 0x09) { // tab -> next 8-col stop
                x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8);
                continue;
            }
            if (c === 0x0c) { // FF -> clear
                grid.rows = [];
                grid.height = 0;
                x = 0;
                y = 0;
                continue;
            }
            put(c);
        }
        return grid;
    }
    FLAnsiGrid.render = render;
    // Horizontal mirror glyph pairs: directional CP437 characters that must
    // swap when art is flipped across the vertical axis (half-blocks matter
    // most for avatar art; slashes/brackets/box corners for the rest).
    var MIRROR_PAIRS = [
        [0x2f, 0x5c], // / \
        [0x28, 0x29], // ( )
        [0x5b, 0x5d], // [ ]
        [0x7b, 0x7d], // { }
        [0x3c, 0x3e], // < >
        [0x62, 0x64], // b d
        [0x70, 0x71], // p q
        [0x11, 0x10], // left/right triangles
        [0xae, 0xaf], // << >>
        [0xdd, 0xde], // left/right half blocks
        [0xda, 0xbf], // single box corners (top)
        [0xc0, 0xd9], // single box corners (bottom)
        [0xc3, 0xb4], // single box tees
        [0xc9, 0xbb], // double box corners (top)
        [0xc8, 0xbc], // double box corners (bottom)
        [0xcc, 0xb9], // double box tees
        [0xd5, 0xb8], [0xd4, 0xbe], [0xd6, 0xb7], [0xd3, 0xbd],
        [0xc6, 0xb5], [0xc7, 0xb6]
    ];
    var MIRROR_MAP = {};
    for (var mpi = 0; mpi < MIRROR_PAIRS.length; mpi++) {
        MIRROR_MAP[MIRROR_PAIRS[mpi][0]] = MIRROR_PAIRS[mpi][1];
        MIRROR_MAP[MIRROR_PAIRS[mpi][1]] = MIRROR_PAIRS[mpi][0];
    }
    /** Flip a grid across the vertical axis (cells reversed per row, and
     *  directional glyphs swapped for their mirror twins). */
    function mirror(grid) {
        var out = { width: grid.width, height: grid.height, rows: [] };
        for (var y = 0; y < grid.rows.length; y++) {
            var row = grid.rows[y];
            var rev = [];
            for (var x = row.length - 1; x >= 0; x--) {
                var cell = row[x];
                var ch = cell & 0xff;
                var mapped = MIRROR_MAP[ch];
                rev.push(mapped ? ((cell & 0xff00) | mapped) : cell);
            }
            out.rows.push(rev);
        }
        return out;
    }
    FLAnsiGrid.mirror = mirror;
    /** Decode a 10x6 BIN avatar (char+attr pairs) into a grid. */
    function renderBin(data, width, height) {
        if (data.length < width * height * 2)
            return null;
        var grid = { width: width, height: height, rows: [] };
        var p = 0;
        for (var y = 0; y < height; y++) {
            var row = [];
            for (var x = 0; x < width; x++) {
                var ch = data.charCodeAt(p++) & 0xff;
                var at = data.charCodeAt(p++) & 0xff;
                row.push((at << 8) | (ch === 0 ? 0x20 : ch));
            }
            grid.rows.push(row);
        }
        return grid;
    }
    FLAnsiGrid.renderBin = renderBin;
    function attrToSgr(attr, palIdx) {
        var pal = FLAnsiGrid.PALETTES[palIdx >= 0 && palIdx < FLAnsiGrid.PALETTES.length ? palIdx : 0];
        var fg = pal[attr & 0x07];
        var bg = pal[(attr >> 4) & 0x07];
        var out = "0";
        if (attr & 0x08)
            out += ";1";
        if (attr & 0x80)
            out += ";5";
        out += ";" + CGA_TO_SGR[fg] + ";" + (CGA_TO_SGR[bg] + 10);
        return out;
    }
    FLAnsiGrid.attrToSgr = attrToSgr;
    // Full 16-colour rotation with BLACK pinned. The PALETTES model only
    // permutes the 3-bit BASE colour (so DARKGRAY = base-0 + bright shares a
    // slot with BLACK and can't move independently, and LIGHTGRAY/WHITE stay
    // put in most maps). This rotates all 15 non-black foreground colours (and
    // the 7 non-black backgrounds) by `rot`, so grayscale strobes through
    // colour on a beat while BLACK stays black.
    function rotFg(full, rot) {
        return full === 0 ? 0 : (((full - 1 + rot) % 15) + 15) % 15 + 1;
    }
    function rotBg(base, rot) {
        return base === 0 ? 0 : (((base - 1 + rot) % 7) + 7) % 7 + 1;
    }
    function flashSgr(attr, rot) {
        var fgFull = (attr & 0x07) | ((attr & 0x08) ? 8 : 0);
        var nfg = rotFg(fgFull, rot);
        var nbg = rotBg((attr >> 4) & 0x07, rot);
        var out = "0";
        if (nfg & 0x08)
            out += ";1";
        if (attr & 0x80)
            out += ";5";
        out += ";" + CGA_TO_SGR[nfg & 0x07] + ";" + (CGA_TO_SGR[nbg] + 10);
        return out;
    }
    /** emit(), but colours are rotated by `rot` (BLACK pinned) -- the grayscale-
     *  inclusive palette strobe used for avatar flashes. */
    function emitFlash(grid, left, top, srcRow, nRows, srcCol, nCols, rot) {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            out += "\x1b[" + (top + r) + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = flashSgr(cell >> 8, rot);
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }
    FLAnsiGrid.emitFlash = emitFlash;
    /** emit(), but the palette index is chosen PER CELL by palFor(screenX,
     *  screenY) -- lets a caller sweep one palette in over another (a spatial
     *  "fill" transition) instead of recolouring the whole art at once. */
    function emitWipe(grid, left, top, srcRow, nRows, srcCol, nCols, palFor) {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            var sy = top + r;
            out += "\x1b[" + sy + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = attrToSgr(cell >> 8, palFor(left + cIdx, sy));
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }
    FLAnsiGrid.emitWipe = emitWipe;
    /**
     * Blit a window of the grid to the screen: source rows [srcRow, srcRow+nRows)
     * and cols [srcCol, srcCol+nCols) drawn with the top-left at screen
     * (top,left) (1-based). Emits minimal SGR runs; palIdx remaps colors.
     */
    function emit(grid, left, top, srcRow, nRows, srcCol, nCols, palIdx) {
        var out = "";
        var lastSgr = "";
        for (var r = 0; r < nRows; r++) {
            var gy = srcRow + r;
            if (gy < 0 || gy >= grid.rows.length)
                continue;
            var row = grid.rows[gy];
            out += "\x1b[" + (top + r) + ";" + left + "H";
            for (var cIdx = 0; cIdx < nCols; cIdx++) {
                var gx = srcCol + cIdx;
                var cell = gx >= 0 && gx < row.length ? row[gx] : ((DEFAULT_ATTR << 8) | 0x20);
                var code = attrToSgr(cell >> 8, palIdx);
                if (code !== lastSgr) {
                    out += "\x1b[" + code + "m";
                    lastSgr = code;
                }
                out += String.fromCharCode(cell & 0xff);
            }
        }
        return out + "\x1b[0m";
    }
    FLAnsiGrid.emit = emit;
})(FLAnsiGrid || (FLAnsiGrid = {}));
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
var FLPlayer;
(function (FLPlayer) {
    // Self-provide the sbbsdefs constants (K_NONE etc). Synchronet's load()
    // executes into the CALLER'S scope: the door's IIFE loading sbbsdefs does
    // not make the constants visible out here — that only appeared to work
    // when an outer shell had already loaded them globally (ssh sessions via
    // future_shell). Fresh contexts (webv4 fTelnet path) crashed with
    // "K_NONE is not defined".
    load("sbbsdefs.js");
    // ---- tuning -------------------------------------------------------
    var CHUNK_MS = 300; // clip length; also the pacing quantum
    var PREBUFFER = 3; // chunks queued ahead of realtime
    var CHANNEL = 2; // first APC-dedicated channel (0/1 are cterm's)
    var SLOTS = 8; // patch slots cycled for chunk clips
    var PCM_RATE = 22050; // transcode rate (client resamples to 44.1k)
    var PCM_CHANNELS = 2; // stereo; halve bandwidth with 1 if needed
    var UI_TICK_MS = 150; // overlay/visualizer repaint cadence
    var SEEK_SECONDS = 10;
    // Synchronet's console.inkey() COOKS recognized cursor keys into single
    // control bytes (see key_defs.js) rather than passing the raw ESC[ sequence,
    // so real arrow presses never reach the ESC-sequence decoder below. Map the
    // cooked codes to navigation here so every consumer sees arrows uniformly.
    // (KEY_DOWN is \x0a = '\n' — reading it as Enter is what made the song list's
    // Down arrow "play" the track.)
    var COOKED_NAV = {
        "\x1e": "up", "\x0a": "down", "\x1d": "left", "\x06": "right",
        "\x10": "pgup", "\x0e": "pgdn", "\x02": "home", "\x05": "end"
    };
    var ART_WIDTH = 80; // classic ANSI art wrap column
    var AVATAR_W = 10; // Synchronet avatar cell dimensions
    var AVATAR_H = 6;
    var detectedSink = null; // per-session cache
    // Track-shuffle toggle (S key). playInTerminal reads this when advancing:
    // on -> next track is random from the queue, off -> sequential. Shared here
    // so both the player (toggle/display) and the jukebox loop (advance) see it.
    FLPlayer.shuffle = false;
    // ---- small helpers --------------------------------------------------
    function shellQuote(s) {
        return "'" + s.replace(/'/g, "'\\''") + "'";
    }
    function nowMs() {
        return new Date().getTime();
    }
    function clamp(v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }
    function fmtTime(totalSeconds) {
        var s = Math.max(0, Math.floor(totalSeconds));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ":" + (r < 10 ? "0" : "") + r;
    }
    function apc(payload) {
        console.write("\x1b_SyncTERM:" + payload + "\x1b\\");
    }
    // ---- WAV plumbing ---------------------------------------------------
    // We always transcode to canonical PCM (pcm_s16le) with metadata
    // stripped, so the header is the fixed 44 bytes; the parser still walks
    // RIFF chunks and the reader grows its buffer, in case a pre-data chunk
    // ever appears anyway.
    function le16(v) {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
    }
    function le32(v) {
        return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    }
    function rd16(s, o) {
        return (s.charCodeAt(o) & 0xff) | ((s.charCodeAt(o + 1) & 0xff) << 8);
    }
    function rd32(s, o) {
        return ((s.charCodeAt(o) & 0xff)) +
            ((s.charCodeAt(o + 1) & 0xff) * 0x100) +
            ((s.charCodeAt(o + 2) & 0xff) * 0x10000) +
            ((s.charCodeAt(o + 3) & 0xff) * 0x1000000);
    }
    function wavHeader(dataBytes, rate, channels) {
        var blockAlign = channels * 2;
        var byteRate = rate * blockAlign;
        return "RIFF" + le32(36 + dataBytes) + "WAVE" +
            "fmt " + le32(16) + le16(1) + le16(channels) +
            le32(rate) + le32(byteRate) + le16(blockAlign) + le16(16) +
            "data" + le32(dataBytes);
    }
    FLPlayer.wavHeader = wavHeader;
    /** Parse the header, growing the read until the data chunk is in view
     *  (metadata LIST chunks can push it well past 512 bytes). */
    function readWavInfo(f) {
        var want = 512;
        for (;;) {
            f.position = 0;
            var head = f.read(want);
            if (!head || head.length < 44)
                return null;
            var info = parseWavHeader(head, f.length);
            if (info)
                return info;
            if (head.length < want || want >= 65536)
                return null; // whole file scanned (or cap hit): truly bad
            want *= 4;
        }
    }
    FLPlayer.readWavInfo = readWavInfo;
    function parseWavHeader(head, fileLength) {
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
            }
            else if (id === "data") {
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
    FLPlayer.parseWavHeader = parseWavHeader;
    // ---- transcode cache ------------------------------------------------
    function pcmDir() {
        return backslash(js.exec_dir) + "data/pcm";
    }
    function ffmpegAvailable() {
        var out = system.popen("which ffmpeg 2>/dev/null");
        return !!(out && out.length && out[0].length);
    }
    FLPlayer.ffmpegAvailable = ffmpegAvailable;
    /** Transcode (once) to the canonical low-rate WAV; returns its path or null. */
    function ensureTranscoded(track) {
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
    FLPlayer.ensureTranscoded = ensureTranscoded;
    function parseAudioBody(parts, res) {
        for (var i = 1; i + 1 < parts.length + 1; i += 2) {
            var id = parseInt(parts[i], 10);
            var st = parseInt(parts[i + 1], 10);
            if (!isNaN(id) && !isNaN(st))
                res.audio.push([id, st]);
        }
    }
    var InputPump = /** @class */ (function () {
        function InputPump() {
            this.buf = "";
            this.escAt = 0; // when a lone ESC started waiting
            this.bracketAt = 0; // when a possible orphaned tail started waiting
        }
        /** Poll for up to maxMs, decoding everything that arrives. */
        InputPump.prototype.pump = function (maxMs) {
            var res = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
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
        };
        InputPump.prototype.drain = function (res, idle) {
            for (;;) {
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
                        }
                        else if (nowMs() - this.escAt >= 250) {
                            res.esc = true;
                            this.buf = "";
                            this.escAt = 0;
                        }
                    }
                    return;
                }
                this.escAt = 0; // ESC got a continuation: a real sequence
                // SS3 / application-cursor arrows: ESC O A/B/C/D. Some SyncTERM
                // modes send these instead of CSI ESC[A; without this they fell
                // through as a bare Esc (= quit) plus a stray letter.
                if (this.buf.charAt(1) === "O") {
                    if (this.buf.length < 3)
                        return; // wait for the final byte (may be split)
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
                    res.esc = true; // ESC + non-CSI: treat as Esc, re-scan rest
                    this.buf = this.buf.substr(1);
                    continue;
                }
                var m = /^\x1b\[([0-9;=?]*)([@-~])/.exec(this.buf);
                if (!m) {
                    if (idle && this.buf.length > 24)
                        this.buf = ""; // malformed: don't wedge
                    return; // incomplete CSI: wait for more bytes
                }
                this.buf = this.buf.substr(m[0].length);
                var body = m[1];
                var fin = m[2];
                if (fin === "n" && body.substr(0, 2) === "=7") {
                    // "=7;a;b[;c;d...]n" -> leading empty from ";a" split
                    parseAudioBody(body.substr(2).split(";"), res);
                }
                else if (fin === "R") {
                    var rc = body.split(";");
                    var pr = parseInt(rc[0], 10);
                    var pc = parseInt(rc[1], 10);
                    if (!isNaN(pr) && !isNaN(pc))
                        res.cpr.push([pr, pc]);
                }
                else if (fin === "A") {
                    res.arrows.push("up");
                }
                else if (fin === "B") {
                    res.arrows.push("down");
                }
                else if (fin === "C") {
                    res.arrows.push("right");
                }
                else if (fin === "D") {
                    res.arrows.push("left");
                }
                else {
                    // Unhandled CSI: recorded so diagnostics can see what a
                    // terminal is REALLY sending (kitty-mode keys, mouse...).
                    res.other.push("[" + body + fin);
                }
            }
        };
        return InputPump;
    }());
    FLPlayer.InputPump = InputPump;
    // ---- flight recorder (armed by data/player-debug.on) -------------------
    var dbgChecked = false;
    var dbgOn = false;
    function dbg(line) {
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
        }
        catch (e) { }
    }
    FLPlayer.dbg = dbg;
    function fmtPump(ev) {
        var bits = [];
        if (ev.keys.length)
            bits.push("keys=" + ev.keys.join(""));
        if (ev.arrows.length)
            bits.push("arrows=" + ev.arrows.join(","));
        if (ev.esc)
            bits.push("ESC");
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
    function pumpShared(maxMs) {
        return sharedPump.pump(maxMs);
    }
    FLPlayer.pumpShared = pumpShared;
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
    function normalizeKey(k) {
        if (!k || !k.length)
            return "";
        if (k.charAt(0) === "\x1b" && k.length >= 2) {
            var seq = k.substr(1);
            if (seq === "[A" || seq === "OA")
                return "\x1e"; // up
            if (seq === "[B" || seq === "OB")
                return "\x0a"; // down
            if (seq === "[C" || seq === "OC")
                return "\x06"; // right
            if (seq === "[D" || seq === "OD")
                return "\x1d"; // left
            if (seq === "[H" || seq === "OH" || seq === "[1~" || seq === "[7~")
                return "\x02"; // home
            if (seq === "[F" || seq === "OF" || seq === "[4~" || seq === "[8~")
                return "\x05"; // end
            if (seq === "[5~")
                return "\x10"; // page up
            if (seq === "[6~")
                return "\x0e"; // page down
            return ""; // other escape sequence (e.g. an APC reply) -> ignore
        }
        return k.charAt(0); // cooked cursor code or a plain key
    }
    FLPlayer.normalizeKey = normalizeKey;
    function readKey(ms) {
        var k = console.inkey(K_NOECHO | K_NOSPIN, ms);
        if (typeof k !== "string" || !k.length)
            return "";
        if (k.length > 1) {
            dbg("readKey whole=" + JSON.stringify(k));
            return normalizeKey(k);
        }
        if (k !== "\x1b")
            return k; // cooked cursor code or a plain key
        // ESC: inkey here delivers the sequence byte-by-byte, so ASSEMBLE the
        // rest of a CSI ("[ ... final") or SS3 ("O <letter>") before deciding.
        // Without this the "[" and "B" of a down arrow leak in as typed text.
        var seq = "";
        for (var i = 0; i < 8; i += 1) {
            var c = console.inkey(K_NOECHO | K_NOSPIN, 60);
            if (typeof c !== "string" || !c.length)
                break; // nothing more -> lone Esc/partial
            seq += c;
            if (seq.charAt(0) !== "[" && seq.charAt(0) !== "O")
                break; // not an escape sequence
            if (seq.charAt(0) === "O") {
                if (seq.length >= 2)
                    break;
                else
                    continue;
            }
            if (seq.length >= 2) { // CSI: stop at the final byte
                var last = seq.charAt(seq.length - 1);
                if (last >= "@" && last <= "~" && !(last >= "0" && last <= "9") && last !== ";")
                    break;
            }
        }
        dbg("readKey ESC seq=" + JSON.stringify(seq));
        if (!seq.length)
            return "\x1b"; // a genuine lone Esc
        return normalizeKey("\x1b" + seq);
    }
    FLPlayer.readKey = readKey;
    // ---- sink detection ---------------------------------------------------
    /**
     * Two-stage probe:
     *  1. APC SyncTERM:Q;libsndfile -> CSI =7;100;1 n  => real SyncTERM.
     *  2. Store+Load+Queue a ~60ms silent clip with Update armed; a
     *     CSI =7;<ch>;0 n drain notify => any APC sink (BBSproxy).
     * Cached for the session; pass force=true to redetect.
     */
    function detectSink(force) {
        if (detectedSink !== null && !force)
            return detectedSink;
        var pumpr = sharedPump;
        var found = "none";
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
    FLPlayer.detectSink = detectSink;
    function repeatByte(ch, count) {
        var out = "";
        while (out.length < count)
            out += (out.length * 2 <= count && out.length) ? out : ch;
        return out.substr(0, count);
    }
    // ---- per-chunk audio features -----------------------------------------
    function chunkFeatures(slice, channels) {
        var frames = Math.floor(slice.length / (channels * 2));
        if (frames < 2)
            return { rms: 0, raw: 0, zcr: 0 };
        // RMS (loudness): strided samples across the whole chunk.
        var points = 256;
        var step = Math.max(1, Math.floor(frames / points));
        var sumSq = 0;
        var count = 0;
        for (var f = 0; f < frames; f += step) {
            var v = rd16(slice, f * channels * 2); // left channel
            if (v >= 0x8000)
                v -= 0x10000;
            sumSq += v * v;
            count++;
        }
        if (!count)
            return { rms: 0, raw: 0, zcr: 0 };
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
        for (var w = 0; w < winFrames; w++) {
            var s = rd16(slice, (start + w) * channels * 2);
            if (s >= 0x8000)
                s -= 0x10000;
            if (w > 0 && ((s >= 0) !== (prev >= 0)))
                crossings++;
            prev = s;
        }
        // crossings/frame *at the PCM rate*: ~0.02 = bassy, ~0.25+ = bright.
        var zcr = clamp((crossings / winFrames) * 5, 0, 1);
        return { rms: rms, raw: raw, zcr: zcr };
    }
    FLPlayer.chunkFeatures = chunkFeatures;
    // ---- synced lyrics -------------------------------------------------------
    /** Index of the lyric line active at `sec`, or -1. `fromIdx` makes the
     *  common forward walk O(1); it resets automatically after a back-seek. */
    function lyricIndexFor(lyrics, sec, fromIdx) {
        if (!lyrics || !lyrics.length || sec < lyrics[0].time)
            return -1;
        var i = fromIdx >= 0 && fromIdx < lyrics.length && lyrics[fromIdx].time <= sec
            ? fromIdx : 0;
        while (i + 1 < lyrics.length && lyrics[i + 1].time <= sec)
            i++;
        return i;
    }
    FLPlayer.lyricIndexFor = lyricIndexFor;
    /** Distribute untimed lyric text evenly across the song duration. */
    function distributeLyrics(flat, totalSec) {
        var lines = [];
        var parts = String(flat || "").split("\n");
        for (var i = 0; i < parts.length; i++) {
            var t = parts[i].replace(/^\s+|\s+$/g, "");
            if (t.length)
                lines.push(t);
        }
        var out = [];
        if (!lines.length || totalSec <= 0)
            return out;
        var span = totalSec / (lines.length + 1);
        for (var j = 0; j < lines.length; j++)
            out.push({ time: span * (j + 1), text: lines[j] });
        return out;
    }
    FLPlayer.distributeLyrics = distributeLyrics;
    // ---- playback screen ----------------------------------------------------
    var CLR = "\x1b[0m";
    function sgr(codes) {
        return "\x1b[" + codes + "m";
    }
    function gotoRC(row, col) {
        return "\x1b[" + row + ";" + col + "H";
    }
    // maxLyricLen (a track's longest line) lets the lyric strip grow past the
    // box on a wide terminal so long lines aren't ellipsized -- computed once
    // per track so the width is stable across lines, never shrinking the box.
    function layout(termCols, termRows, maxLyricLen) {
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
    function makeArtBlit(track, l) {
        var blit = {
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
        blit.srcRow = 0; // trim bottom overflow
        blit.srcCol = Math.max(0, Math.floor((grid.width - blit.nCols) / 2));
        blit.top = l.artTop + Math.max(0, Math.floor((availRows - blit.nRows) / 2));
        blit.left = Math.max(1, Math.floor((availCols - blit.nCols) / 2) + 1);
        return blit;
    }
    function drawArt(blit) {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emit(blit.grid, blit.left, blit.top, blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, blit.pal));
    }
    /** Recolour the whole art by a full 16-colour rotation (BLACK pinned) --
     *  quick all-at-once cycles, like the avatar flash. */
    function drawArtFlash(blit, rot) {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emitFlash(blit.grid, blit.left, blit.top, blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, rot));
    }
    /** Render the art with a per-cell palette (for a spatial fill transition). */
    function drawArtWipe(blit, palFor) {
        if (!blit.grid)
            return;
        console.write(FLAnsiGrid.emitWipe(blit.grid, blit.left, blit.top, blit.srcRow, blit.nRows, blit.srcCol, blit.nCols, palFor));
    }
    /** Restore the backdrop over a screen rect: art cells where the rect
     *  overlaps the art blit; elsewhere a "wake" — a colored shade (the
     *  sprite's trail) that the next background repaint dissolves. */
    function restoreRect(blit, l, x, y, w, h, trailSgr) {
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
        console.write(FLAnsiGrid.emit(blit.grid, ax0, ay0, blit.srcRow + (ay0 - blit.top), ay1 - ay0 + 1, blit.srcCol + (ax0 - blit.left), ax1 - ax0 + 1, blit.pal));
    }
    function drawBackdrop(track, l, blit) {
        console.write(CLR + "\x1b[2J\x1b[H");
        if (blit.grid) {
            drawArt(blit);
        }
        else {
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
    function drawBoxFrame(l, borderSgr) {
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
    function drawTitleLine(l, track) {
        var inner = l.boxWidth - 4;
        var label = "\x0e " + track.title + (track.artist.length ? " - " + track.artist : "");
        if (label.length > inner)
            label = label.substr(0, inner - 3) + "...";
        console.write(gotoRC(l.boxTop + 1, l.boxLeft + 2) +
            sgr("1;36") + label + repeatByte(" ", inner - label.length) + CLR);
    }
    function drawProgress(l, playedSec, totalSec, paused) {
        var inner = l.boxWidth - 4;
        var timeTxt = fmtTime(playedSec) + "/" + fmtTime(totalSec);
        var volTxt = paused ? " PAUSED " : (FLPlayer.shuffle ? " SHUF " : "");
        var barWidth = inner - timeTxt.length - volTxt.length - 2;
        if (barWidth < 8) {
            volTxt = "";
            barWidth = inner - timeTxt.length - 2;
        }
        var fill = totalSec > 0 ? clamp(Math.round(barWidth * playedSec / totalSec), 0, barWidth) : 0;
        var bar = sgr(paused ? "1;33" : "1;37") + repeatByte("\xDB", fill) +
            sgr("0;34") + repeatByte("\xB0", barWidth - fill) + CLR;
        console.write(gotoRC(l.boxTop + 2, l.boxLeft + 2) +
            bar + " " + sgr("0;37") + timeTxt + sgr(paused ? "1;33" : "0;36") + volTxt + CLR);
    }
    // Hint bar with three luminance tiers -- dim separators ("[" "]" "/"),
    // medium labels, bright hotkeys -- and a hue that cycles on the beat.
    // ASCII only (CP437 arrow glyphs sit at C0 control positions).
    var HINTS = [
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
        ["0;36", "0;1;36", "1;37"], // cyan
        ["0;35", "0;1;35", "1;37"], // magenta
        ["0;32", "0;1;32", "1;37"], // green
        ["0;33", "0;1;33", "1;37"], // amber
        ["0;34", "0;1;34", "1;36"], // blue / cyan hotkeys
        ["0;31", "0;1;31", "1;33"] // red / yellow hotkeys
    ];
    function buildHints(withLabels, tri) {
        var dim = sgr(tri[0]);
        var med = sgr(tri[1]);
        var brt = sgr(tri[2]);
        var out = "";
        var len = 0;
        var gap = withLabels ? "  " : " ";
        for (var i = 0; i < HINTS.length; i++) {
            if (i > 0) {
                out += gap;
                len += gap.length;
            }
            var h = HINTS[i];
            out += dim + "[";
            len += 1;
            for (var k = 0; k < h.keys.length; k++) {
                if (k > 0) {
                    out += dim + "/";
                    len += 1;
                }
                out += brt + h.keys[k];
                len += h.keys[k].length;
            }
            out += dim + "]";
            len += 1;
            if (withLabels) {
                out += med + h.label;
                len += h.label.length;
            }
        }
        return { text: out, len: len };
    }
    function drawHints(l, triadIdx) {
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
    function drawGlow(l, row, rms, zcr, on) {
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
                var d = i / Math.max(1, reach); // fade toward the edges
                line += d > 0.75 ? "\xB0" : d > 0.45 ? "\xB1" : d > 0.2 ? "\xB2" : "\xDB";
            }
            else {
                line += " ";
            }
        }
        var left = line.split("").reverse().join("");
        var half2 = l.boxWidth - half * 2;
        // Glow chars in the center; whatever it doesn't reach shows the
        // background effect instead of a black cutout.
        var gap = half - reach;
        console.write(gotoRC(row, l.boxLeft) + bgFillRun(l.boxLeft, row, gap) +
            sgr(color) + left.substr(gap) + line.substr(0, reach) + CLR +
            bgFillRun(l.boxLeft + half + reach, row, gap + half2));
    }
    // Each lyric line gets a random color pair (base, light) and sweeps in
    // with a moving wave: cells near the crest render white -> light -> base,
    // cells far away sit dark until the wave passes (the avatar_chat room
    // join/leave effect, retargeted). Beats re-trigger short mini-sweeps.
    var LYRIC_COLORS = [
        ["0;33", "1;33"], ["0;36", "1;36"], ["0;35", "1;35"],
        ["0;32", "1;32"], ["0;31", "1;31"], ["0;34", "1;36"]
    ];
    var LYRIC_SWEEP_MS = 1500;
    function drawLyric(l, text, colorIdx, progress) {
        var t = text.length > l.lyricWidth - 2 ? text.substr(0, l.lyricWidth - 5) + "..." : text;
        var pad = l.lyricWidth - t.length;
        var lead = Math.floor(pad / 2);
        var pair = LYRIC_COLORS[colorIdx % LYRIC_COLORS.length];
        var out = gotoRC(l.lyricRow, l.lyricLeft) + bgFillRun(l.lyricLeft, l.lyricRow, lead);
        if (progress >= 1 || !t.length) {
            out += sgr(pair[1]) + t;
        }
        else {
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
    var BG_MODES = ["auto", "checker", "plasma", "ripple", "tunnel", "starfield", "matrix", "fire", "strobe", "off"];
    function marginRects(l, blit) {
        var rects = [];
        var zoneTop = l.artTop;
        var zoneBottom = l.artBottom;
        if (!blit.grid || !blit.nRows) {
            // No art: the whole zone (the box already carries the title).
            rects.push({ x: 1, y: zoneTop, w: l.cols, h: zoneBottom - zoneTop + 1 });
        }
        else {
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
    var bgCellFn = null;
    function bgFillRun(x, y, count) {
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
    function glowColor(zcr) {
        return zcr > 0.66 ? "1;37" : zcr > 0.45 ? "1;36" : zcr > 0.28 ? "0;36"
            : zcr > 0.15 ? "1;35" : "0;31";
    }
    /** Checkerboard: 3-col blocks alternating shade/space; one SGR per row. */
    function drawChecker(rects, phase, rms, zcr) {
        var shade = rms > 0.7 ? "\xB2" : rms > 0.4 ? "\xB1" : "\xB0";
        var cc = glowColor(zcr);
        bgCellFn = function (x, y) {
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
    function fieldPaint(rects, zcr, valueAt) {
        var colors = zcr > 0.4 ? FIELD_COOL : FIELD_WARM;
        bgCellFn = function (x, y) {
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
    function drawPlasma(rects, t, zcr) {
        var scale = 0.12;
        fieldPaint(rects, zcr, function (x, y) {
            var nx = x * scale;
            var ny = y * scale * 2; // terminal cells are ~2x taller than wide
            var val = Math.sin(nx + t) +
                Math.sin((ny + t * 0.7) * 1.3) +
                Math.sin(Math.sqrt(nx * nx + ny * ny) + t * 0.4);
            return (val + 3) / 6;
        });
    }
    /** Ripples: beat-spawned expanding rings summed as an interference field. */
    function drawRipples(rects, rings, zcr) {
        fieldPaint(rects, zcr, function (x, y) {
            var value = 0;
            for (var i = 0; i < rings.length; i++) {
                var dx = (x - rings[i].cx) * 0.5; // squash for cell aspect
                var dy = y - rings[i].cy;
                var dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
                value += Math.sin(dist * 0.5 - rings[i].r * 0.7) / (1 + dist * 0.12);
            }
            return (value + 1.2) / 2.4;
        });
    }
    /** Strobe frame at decay level 3..1 (3 = brightest); 0 clears. */
    function drawStrobe(rects, level, zcr) {
        var ch = level >= 3 ? "\xB2" : level === 2 ? "\xB1" : level === 1 ? "\xB0" : " ";
        var sc = glowColor(zcr);
        bgCellFn = level > 0
            ? function (x, y) { return [sc, ch]; }
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
    // sparse effects (starfield, matrix) that place characters, not fill fields.
    function cellPaint(rects, fn) {
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
                    if (code !== last) {
                        out += sgr(code);
                        last = code;
                    }
                    out += ch;
                }
            }
        }
        console.write(out + CLR);
    }
    /** Tunnel: perspective depth rings + angular spokes receding to centre. */
    function drawTunnel(rects, t, zcr, cx, cy) {
        fieldPaint(rects, zcr, function (x, y) {
            var dx = (x - cx) * 0.5; // squash for cell aspect
            var dy = y - cy;
            var dist = Math.sqrt(dx * dx + dy * dy) + 0.6;
            var ang = Math.atan2(dy, dx);
            return Math.sin(9 / dist + t) * 0.5 + Math.sin(ang * 8 - t * 0.5) * 0.3 + 0.5;
        });
    }
    function spawnStar(cx, cy) {
        var a = Math.random() * Math.PI * 2;
        return { x: cx, y: cy, dx: Math.cos(a), dy: Math.sin(a) * 0.5 };
    }
    function stepStars(stars, want, cx, cy, cols, rows, top, rms) {
        while (stars.length < want)
            stars.push(spawnStar(cx, cy));
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
    function drawStars(rects, stars, cx, cy) {
        var map = {};
        for (var i = 0; i < stars.length; i++) {
            var sx = Math.round(stars[i].x), sy = Math.round(stars[i].y);
            var d = Math.abs(sx - cx) * 0.5 + Math.abs(sy - cy);
            map[sx + "," + sy] = d > 16 ? ["1;37", "*"] : d > 8 ? ["0;37", "+"] : ["1;30", "."];
        }
        cellPaint(rects, function (x, y) {
            return map[x + "," + y] || null;
        });
    }
    var MATRIX_CHARS = "0123456789ABCDEF<>|/\\=+*#%\xB1\xF4\xE0\xEA\xE7\x9E";
    function stepMatrix(drops, cols, rows, top, rms, beat) {
        if (drops.length < cols + 8 && (Math.random() < 0.15 + rms * 0.45 || beat))
            drops.push({
                col: 1 + Math.floor(Math.random() * cols), head: top,
                len: 4 + Math.floor(Math.random() * 9), speed: 0.4 + Math.random() * 0.9
            });
        for (var i = drops.length - 1; i >= 0; i--) {
            drops[i].head += drops[i].speed * (0.6 + rms * 1.3);
            if (drops[i].head - drops[i].len > rows)
                drops.splice(i, 1);
        }
    }
    function drawMatrix(rects, drops) {
        var map = {};
        for (var i = 0; i < drops.length; i++) {
            var d = drops[i];
            var h = Math.floor(d.head);
            for (var t = 0; t < d.len; t++) {
                var ch = MATRIX_CHARS.charAt(Math.floor(Math.random() * MATRIX_CHARS.length));
                map[d.col + "," + (h - t)] = [t === 0 ? "1;37" : t < 3 ? "1;32" : "0;32", ch];
            }
        }
        cellPaint(rects, function (x, y) {
            return map[x + "," + y] || null;
        });
    }
    // Fire: a heat field seeded along the bottom (fuel follows loudness/beats)
    // that rises and cools -- classic demoscene fire, warm ASCII gradient.
    var FIRE_CHARS = [" ", "\xB0", "\xB1", "\xB2", "\xB2", "\xDB"];
    var FIRE_COLORS = ["0", "0;31", "1;31", "1;33", "1;33", "1;37"];
    function drawFire(rects, heat, cols, rows, top, rms, beat) {
        // Seed the bottom rows with fuel.
        var base = rows;
        for (var x = 1; x <= cols; x++) {
            var fuel = 0.35 + Math.random() * (0.35 + rms * 0.9) + (beat ? 0.3 : 0);
            heat[x + "," + base] = Math.min(1, fuel);
            heat[x + "," + (base - 1)] = Math.min(1, fuel * 0.9);
        }
        // Propagate upward with cooling (average of the row below +/- a column).
        var next = {};
        for (var y = top; y < base - 1; y++) {
            for (var cx2 = 1; cx2 <= cols; cx2++) {
                var below = (heat[cx2 + "," + (y + 1)] || 0) +
                    (heat[(cx2 - 1) + "," + (y + 1)] || 0) +
                    (heat[(cx2 + 1) + "," + (y + 1)] || 0) +
                    (heat[cx2 + "," + (y + 2)] || 0);
                var v = below / 4 - 0.06;
                if (v > 0.02)
                    next[cx2 + "," + y] = v > 1 ? 1 : v;
            }
        }
        next[""] = 0;
        for (var bx = 1; bx <= cols; bx++) {
            next[bx + "," + base] = heat[bx + "," + base] || 0;
            next[bx + "," + (base - 1)] = heat[bx + "," + (base - 1)] || 0;
        }
        for (var kk in heat)
            if (heat.hasOwnProperty(kk))
                delete heat[kk];
        for (var k2 in next)
            if (next.hasOwnProperty(k2))
                heat[k2] = next[k2];
        cellPaint(rects, function (x, y) {
            var hv = heat[x + "," + y];
            if (!hv)
                return null;
            var b = Math.min(FIRE_CHARS.length - 1, Math.floor(hv * FIRE_CHARS.length));
            return b > 0 ? [FIRE_COLORS[b], FIRE_CHARS[b]] : null;
        });
    }
    var TRAIL_COLORS = ["0;35", "0;34", "0;36", "0;31", "0;32", "1;30"];
    function makeSprites(track, l) {
        var sprites = [];
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
    function stepSprites(sprites, l, rms, beat, hardBeat, mode) {
        var minX = 1;
        var maxX = l.cols - AVATAR_W + 1;
        var minY = l.artTop;
        var maxY = l.artBottom - AVATAR_H + 1;
        if (maxX <= minX || maxY <= minY)
            return;
        var speed = 0.6 + rms * 1.8; // loudness drives the drift
        var ccx = (minX + maxX) / 2;
        var ccy = (minY + maxY) / 2;
        var i;
        for (i = 0; i < sprites.length; i++) {
            var s = sprites[i];
            if (beat)
                s.flash = 3; // palette strobe
            if (hardBeat)
                s.glitch = 3; // glitch-out on hard accents
            else if (beat && s.wiggle === 0 && Math.random() < 0.35)
                s.wiggle = 4;
            var hit = false;
            if (mode === "gravity") {
                if (beat) {
                    s.vy = -(1.3 + rms * 1.7);
                    s.vx += (Math.random() - 0.5) * 1.7;
                } // jump
                s.vy += 0.14; // gravity
                s.vx = clamp(s.vx, -1.9, 1.9);
                s.x += s.vx * speed;
                s.y += s.vy;
                if (s.x < minX) {
                    s.x = minX;
                    s.vx = Math.abs(s.vx);
                    hit = true;
                }
                if (s.x > maxX) {
                    s.x = maxX;
                    s.vx = -Math.abs(s.vx);
                    hit = true;
                }
                if (s.y > maxY) {
                    s.y = maxY;
                    s.vy = -Math.abs(s.vy) * 0.55;
                    s.vx *= 0.92;
                    hit = true;
                } // floor
                if (s.y < minY) {
                    s.y = minY;
                    s.vy = Math.abs(s.vy) * 0.5;
                    hit = true;
                }
            }
            else if (mode === "mosh") {
                if (beat) { // explode outward from the centre
                    var ang = Math.atan2(s.y - ccy, s.x - ccx);
                    s.vx += Math.cos(ang) * (1.6 + rms * 2.2);
                    s.vy += Math.sin(ang) * (1.3 + rms * 1.7);
                }
                else { // otherwise get pulled back in
                    s.vx += (ccx - s.x) * 0.022;
                    s.vy += (ccy - s.y) * 0.022;
                }
                s.vx = clamp(s.vx, -2.1, 2.1);
                s.vy = clamp(s.vy, -1.7, 1.7);
                s.x += s.vx * speed;
                s.y += s.vy * speed;
                if (s.x < minX) {
                    s.x = minX;
                    s.vx = Math.abs(s.vx);
                    hit = true;
                }
                if (s.x > maxX) {
                    s.x = maxX;
                    s.vx = -Math.abs(s.vx);
                    hit = true;
                }
                if (s.y < minY) {
                    s.y = minY;
                    s.vy = Math.abs(s.vy);
                    hit = true;
                }
                if (s.y > maxY) {
                    s.y = maxY;
                    s.vy = -Math.abs(s.vy);
                    hit = true;
                }
            }
            else { // float (default)
                if (beat) {
                    s.vx += (Math.random() - 0.5) * 1.6;
                    s.vy += (Math.random() - 0.5) * 1.2;
                }
                s.vx = clamp(s.vx, -1.6, 1.6);
                s.vy = clamp(s.vy, -1.1, 1.1);
                s.x += s.vx * speed;
                s.y += s.vy * speed;
                if (s.x < minX) {
                    s.x = minX;
                    s.vx = Math.abs(s.vx);
                    hit = true;
                }
                if (s.x > maxX) {
                    s.x = maxX;
                    s.vx = -Math.abs(s.vx);
                    hit = true;
                }
                if (s.y < minY) {
                    s.y = minY;
                    s.vy = Math.abs(s.vy);
                    hit = true;
                }
                if (s.y > maxY) {
                    s.y = maxY;
                    s.vy = -Math.abs(s.vy);
                    hit = true;
                }
            }
            // Face the direction of travel.
            if (s.vx > 0.15)
                s.facing = 1;
            else if (s.vx < -0.15)
                s.facing = -1;
            if (hit || beat)
                s.trail = (s.trail + 1 + Math.floor(Math.random() * 2)) % TRAIL_COLORS.length;
        }
        // Pairwise collision (all pairs): overlap -> swap velocities and separate.
        for (i = 0; i < sprites.length; i++)
            for (var j = i + 1; j < sprites.length; j++) {
                var a = sprites[i];
                var b = sprites[j];
                if (Math.abs(a.x - b.x) < AVATAR_W && Math.abs(a.y - b.y) < AVATAR_H) {
                    var tvx = a.vx;
                    a.vx = b.vx;
                    b.vx = tvx;
                    var tvy = a.vy;
                    a.vy = b.vy;
                    b.vy = tvy;
                    var tt = a.trail;
                    a.trail = b.trail;
                    b.trail = tt;
                    var push = a.x <= b.x ? 1 : -1;
                    a.x = clamp(a.x - push, minX, maxX);
                    b.x = clamp(b.x + push, minX, maxX);
                }
            }
    }
    function drawSprites(sprites, l, blit, force) {
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
                restoreRect(blit, l, s.drawnX - s.pad, s.drawnY, AVATAR_W + s.pad * 2, AVATAR_H, moved ? TRAIL_COLORS[s.trail] : undefined);
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
                    console.write(FLAnsiGrid.emitFlash(face, Math.max(1, jx), ny + gr, gr, 1, 0, AVATAR_W, gr * 2 + s.glitch * 4 + 6));
                }
                s.pad = 2;
            }
            else {
                var wx = nx;
                if (s.wiggle > 0) {
                    wx = nx + (s.wiggle % 2 === 0 ? 1 : -1);
                    wx = Math.max(1, Math.min(l.cols - AVATAR_W + 1, wx));
                    s.wiggle--;
                    s.pad = 1; // the shake spills a column either side
                }
                if (s.flash > 0) {
                    // Palette strobe: rotate the whole colour wheel a few frames
                    // per beat -- grays and white included, BLACK pinned.
                    console.write(FLAnsiGrid.emitFlash(face, wx, ny, 0, AVATAR_H, 0, AVATAR_W, s.flash * 3 + i + 4));
                    s.flash--;
                }
                else {
                    console.write(FLAnsiGrid.emit(face, wx, ny, 0, AVATAR_H, 0, AVATAR_W, 0));
                }
            }
            s.drawnX = nx;
            s.drawnY = ny;
        }
    }
    // ---- the player -----------------------------------------------------------
    function playTrack(track, statusLine) {
        var say = statusLine || function (msg) {
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
        }
        finally {
            f.close();
        }
    }
    FLPlayer.playTrack = playTrack;
    function playLoop(track, f, info) {
        var bytesPerSec = info.rate * info.channels * 2;
        var chunkBytes = Math.floor(bytesPerSec * CHUNK_MS / 1000);
        // Frame-align so a chunk never splits a sample frame.
        chunkBytes -= chunkBytes % (info.channels * 2);
        var totalChunks = Math.ceil(info.dataBytes / chunkBytes);
        var totalSec = info.dataBytes / bytesPerSec;
        var termCols = 0; // 0 = trust console.screen_*
        var termRows = 0;
        var l = layout();
        var pump = sharedPump;
        var visMode = 0;
        var bgMode = 0; // BG_MODES index
        var borderPulse = 0; // decaying beat flash
        var hintTriad = 0; // HINT_TRIADS index; cycles on beats
        var hintFlashAt = 0; // rate-cap for the hint hue cycle
        var lastRms = 0;
        var artFlashAt = 0;
        var PALETTE_SEQ = []; // chosen once the art grid exists
        var palStep = 0;
        // Art-swap styles (rotate with the effect): pulse = step the palette on
        // beats; rotate = quick full-colour cycle bursts; wipe = fill the next
        // palette in symmetrically (centre-out / edge-in).
        var ART_SWAP_MODES = ["pulse", "rotate", "wipe"];
        var artSwapMode = 0;
        var artRot = 0; // rotate: colour-wheel phase
        var artRotFrames = 0; // rotate: rapid-cycle frames left after a beat
        var wipeActive = false;
        var wipeFront = 0;
        var wipeMaxR = 1;
        var wipeOld = 0;
        var wipeNew = 0;
        var wipeStyle = 0; // 0 = centre-out, 1 = edge-in
        var margins = [];
        var checkerPhase = 0;
        var checkerDirty = true;
        var strobeLevel = 0;
        var plasmaT = 0;
        var rings = [];
        var fieldTick = 0; // field effects repaint on alternate ticks
        var lastProbeAt = nowMs(); // no probe on the first iterations: the
        // previous track's drain notify is in
        // flight then, and the engine's reply
        // reader must not race it
        var lastConsoleCols = console.screen_columns || 0;
        var lastConsoleRows = console.screen_rows || 0;
        var cprSeen = 0; // resize diagnostics (corner readout)
        var relayouts = 0;
        // Onset + energy tracking (all on RAW rms, updated once per chunk):
        // emaFast (~1s) is the local level — a chunk jumping clearly above it
        // is a beat/accent, even mid-plateau. emaSlow (~6s) is the passage
        // energy — fast diverging from slow marks quiet<->loud transitions,
        // which drive the auto background rotation.
        var emaFast = -1;
        var emaSlow = -1;
        var lastFeatChunk = -1;
        var autoIdx = 0; // auto rotation through the field/ascii effects
        var spriteMode = 0; // avatar motion mode, rotates with the effect
        var AUTO_EFFECTS = ["checker", "plasma", "ripple", "tunnel", "starfield", "matrix", "fire"];
        var tunnelT = 0; // tunnel scroll phase
        var stars = []; // starfield warp points
        var matrixDrops = []; // matrix rain columns
        var fireHeat = {}; // fire heat field
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
        var lyrics = track.lyrics && track.lyrics.length
            ? track.lyrics
            : distributeLyrics(track.flatLyrics || "", totalSec);
        // Size the lyric strip to this track's longest line so a wide terminal
        // shows full lines instead of ellipsis. Per track (stable across lines),
        // never narrower than the box; the glow/viz bars keep the box width.
        var maxLyricLen = 0;
        for (var mli = 0; mli < lyrics.length; mli++) {
            var llen = lyrics[mli] && lyrics[mli].text ? lyrics[mli].text.length : 0;
            if (llen > maxLyricLen)
                maxLyricLen = llen;
        }
        l = layout(l.cols, l.rows, maxLyricLen);
        var lyricIdx = -1;
        var lyricColor = Math.floor(Math.random() * 6);
        var lyricSweepAt = 0; // 0 = steady (no sweep running)
        function redrawAll() {
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
        function relayout(cols, rows) {
            if (cols === l.cols && rows === l.rows)
                return;
            termCols = cols;
            termRows = rows;
            relayouts++;
            l = layout(termCols, termRows, maxLyricLen);
            blit = makeArtBlit(track, l);
            margins = marginRects(l, blit);
            lyricIdx = -1; // repaint the lyric row after the redraw
            rings = [];
            stars = [];
            matrixDrops = [];
            fireHeat = {}; // positions were screen-relative
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
        var chunk = 0; // next chunk to emit
        var t0 = nowMs(); // wall-clock anchor: chunk i plays at t0 + i*CHUNK_MS
        var paused = false;
        var pausedMs = 0; // frozen playhead while paused
        // Any intentional Flush (track start counts: the PREVIOUS track's fade
        // tail may still fire its armed notify) opens a grace window during
        // which drain notifies are stale echoes of our own Flush, NOT
        // underruns. Treating them as underruns re-Flushes, which fires the
        // next notify: a restart ping-pong that scrubs the song back and forth.
        var FLUSH_GRACE_MS = 1500;
        var lastFlushAt = nowMs();
        var lastUiAt = 0;
        var result = "ended";
        var features = { rms: 0, raw: 0, zcr: 0 };
        var featForChunk = [];
        function emitChunk(idx) {
            f.position = info.dataOffset + idx * chunkBytes;
            var want = Math.min(chunkBytes, info.dataBytes - idx * chunkBytes);
            var slice = f.read(want);
            if (!slice || !slice.length)
                return;
            featForChunk[idx] = chunkFeatures(slice, info.channels);
            var name = "flr" + (idx % SLOTS) + ".wav";
            var slot = idx % SLOTS;
            console.write("\x1b_SyncTERM:C;S;" + name + ";" +
                base64_encode(wavHeader(slice.length, info.rate, info.channels) + slice) +
                "\x1b\\" +
                "\x1b_SyncTERM:A;Load;S=" + slot + ";" + name + "\x1b\\" +
                "\x1b_SyncTERM:A;Queue;C=" + CHANNEL + ";S=" + slot + "\x1b\\");
        }
        function rePrime(fromChunk) {
            chunk = clamp(fromChunk, 0, totalChunks);
            t0 = nowMs() - chunk * CHUNK_MS + PREBUFFER * CHUNK_MS;
            lastFlushAt = nowMs();
            apc("A;Flush;C=" + CHANNEL);
            apc("A;Update;C=" + CHANNEL);
        }
        dbg("playLoop start: " + track.name + " chunks=" + totalChunks);
        console.write("\x1b[?25l"); // hide the cursor for the show
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
                result = "quit"; // Esc means leave, not "song ended"
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
                        pausedMs = playMs; // freeze the displayed clock
                        lastFlushAt = now; // our Flush, not an underrun
                        apc("A;Flush;C=" + CHANNEL);
                        chunk = playChunk; // resume point
                    }
                    else {
                        paused = false;
                        rePrime(chunk);
                    }
                }
                else if (k === "N") {
                    result = "next";
                    quitReq = true;
                }
                else if (k === "P") {
                    result = "prev";
                    quitReq = true;
                }
                else if (k === "B") {
                    result = "browse"; // open the typeahead song browser
                    quitReq = true;
                }
                else if (k === "C") {
                    result = "create"; // jump to the compose-a-song flow
                    quitReq = true;
                }
                else if (k === "A") {
                    result = "addplaylist"; // add the current track to a playlist
                    quitReq = true;
                }
                else if (k === "R") {
                    result = "removeplaylist"; // remove from the current playlist
                    quitReq = true;
                }
                else if (k === "S") {
                    FLPlayer.shuffle = !FLPlayer.shuffle; // toggle track shuffle (indicator on next tick)
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
                }
                else if (dir === "down" || dir === "right") {
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
                    }
                    else if (now - lastFlushAt < FLUSH_GRACE_MS) {
                        dbg("notify: stale (grace), re-armed");
                        // Stale echo of our own Flush (seek/pause/track start):
                        // the one-shot was consumed by it, so just re-arm and
                        // keep playing. Recovering here would re-Flush and
                        // trigger the next echo — the restart ping-pong.
                        apc("A;Update;C=" + CHANNEL);
                    }
                    else {
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
                }
                catch (probeErr) { }
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
                }
                if (beat)
                    borderPulse = 3;
                lastRms = features.rms;
                // Auto background rotation on musical transitions: the local
                // level diverging from the passage energy (quiet->loud or
                // loud->quiet) advances the effect, with a 30s variety
                // fallback so long steady passages still evolve. The switch
                // announces itself with a strobe flash.
                if (BG_MODES[bgMode] === "auto" && !paused && emaSlow > 0) {
                    var swAge = now - lastAutoSwitchAt;
                    var ratio = (emaFast - emaSlow) / Math.max(emaSlow, 0.01);
                    if ((swAge > 8000 && (ratio > 0.4 || ratio < -0.3)) || swAge > 30000) {
                        lastAutoSwitchAt = now;
                        autoIdx = (autoIdx + 1) % AUTO_EFFECTS.length;
                        spriteMode = (spriteMode + 1) % SPRITE_MODES.length; // vary avatar physics too
                        artSwapMode = (artSwapMode + 1) % ART_SWAP_MODES.length; // and the art-swap style
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
                    var swap = ART_SWAP_MODES[artSwapMode];
                    if (swap === "rotate") {
                        // Quick full-colour cycles: a short burst of rotation
                        // frames on each beat (all colours at once, grays too).
                        if (beat)
                            artRotFrames = 4;
                        if (artRotFrames > 0) {
                            artRot = (artRot + 4 + Math.floor(features.rms * 8)) % 15;
                            if (artRot === 0)
                                artRot = 1;
                            drawArtFlash(blit, artRot);
                            drawSprites(sprites, l, blit, true);
                            artRotFrames--;
                            if (artRotFrames === 0) {
                                drawArt(blit);
                                drawSprites(sprites, l, blit, true);
                            }
                        }
                    }
                    else if (swap === "wipe") {
                        // Timed symmetric fill: sweep the next palette in.
                        if (!wipeActive && beat && now - artFlashAt > 550) {
                            artFlashAt = now;
                            wipeActive = true;
                            wipeFront = 0;
                            wipeOld = blit.pal;
                            palStep = PALETTE_SEQ.length ? (palStep + 1) % PALETTE_SEQ.length : 0;
                            wipeNew = PALETTE_SEQ.length ? PALETTE_SEQ[palStep] : 0;
                            wipeStyle = (wipeStyle + 1) % 2;
                            var hw = blit.nCols * 0.25, hh = blit.nRows * 0.5;
                            wipeMaxR = Math.sqrt(hw * hw + hh * hh) * 2 + 3;
                        }
                        if (wipeActive) {
                            wipeFront += wipeMaxR / 9;
                            var acx = blit.left + blit.nCols / 2;
                            var acy = blit.top + blit.nRows / 2;
                            var frontR = wipeFront, oldP = wipeOld, newP = wipeNew;
                            var edgeIn = wipeStyle === 1, maxR = wipeMaxR;
                            drawArtWipe(blit, function (x, y) {
                                var dx = (x - acx) * 0.5, dy = y - acy;
                                var d = Math.sqrt(dx * dx + dy * dy) * 2;
                                var isNew = edgeIn ? (d >= maxR - frontR) : (d <= frontR);
                                return isNew ? newP : oldP;
                            });
                            drawSprites(sprites, l, blit, true);
                            if (wipeFront >= wipeMaxR + 2) {
                                wipeActive = false;
                                blit.pal = wipeNew;
                            }
                        }
                    }
                    else { // pulse: step the palette on beats (all at once)
                        if (beat && now - artFlashAt > 420) {
                            artFlashAt = now;
                            palStep = PALETTE_SEQ.length ? (palStep + 1) % PALETTE_SEQ.length : 0;
                            blit.pal = PALETTE_SEQ.length ? PALETTE_SEQ[palStep] : 0;
                            drawArt(blit);
                            drawSprites(sprites, l, blit, true);
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
                    bg = AUTO_EFFECTS[autoIdx]; // rotated by the music above
                var bgPainted = false;
                var fxCx = Math.floor(l.cols / 2); // effect centre (tunnel/starfield)
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
                            checkerDirty = true; // repaint pattern after decay
                    }
                    else if (bg === "checker") {
                        if (beat) {
                            checkerPhase++;
                            checkerDirty = true;
                        }
                        if (checkerDirty) {
                            drawChecker(margins, checkerPhase, features.rms, features.zcr);
                            bgPainted = true;
                            checkerDirty = false;
                        }
                    }
                    else if (bg === "plasma") {
                        plasmaT += 0.10 + features.rms * 0.35;
                        if (beat)
                            plasmaT += 1.2;
                        if (fieldTick % 2 === 0 || beat) {
                            drawPlasma(margins, plasmaT, features.zcr);
                            bgPainted = true;
                        }
                    }
                    else if (bg === "ripple") {
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
                    }
                    else if (bg === "tunnel") {
                        tunnelT += 0.15 + features.rms * 0.55;
                        if (beat)
                            tunnelT += 0.8;
                        if (fieldTick % 2 === 0 || beat) {
                            drawTunnel(margins, tunnelT, features.zcr, fxCx, fxCy);
                            bgPainted = true;
                        }
                    }
                    else if (bg === "starfield") {
                        stepStars(stars, STAR_COUNT, fxCx, fxCy, l.cols, l.rows, l.artTop, features.rms);
                        drawStars(margins, stars, fxCx, fxCy);
                        bgPainted = true;
                    }
                    else if (bg === "matrix") {
                        stepMatrix(matrixDrops, l.cols, l.rows, l.artTop, features.rms, beat);
                        drawMatrix(margins, matrixDrops);
                        bgPainted = true;
                    }
                    else if (bg === "fire") {
                        drawFire(margins, fireHeat, l.cols, l.rows, l.artTop, features.rms, beat);
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
                    }
                    else if (beat && li >= 0 && lyricSweepAt === 0) {
                        lyricSweepAt = now - Math.floor(LYRIC_SWEEP_MS * 0.55);
                    }
                    if (lyricSweepAt > 0) {
                        var prog = (now - lyricSweepAt) / LYRIC_SWEEP_MS;
                        drawLyric(l, lyricIdx >= 0 ? lyrics[lyricIdx].text : "", lyricColor, clamp(prog, 0, 1));
                        if (prog >= 1)
                            lyricSweepAt = 0;
                    }
                    else if (bgPainted && lyricIdx >= 0) {
                        // The effect just painted over the lyric row's padding
                        // AND its text; put the settled line back on top.
                        drawLyric(l, lyrics[lyricIdx].text, lyricColor, 1);
                    }
                }
                if (bgPainted)
                    drawHints(l, hintTriad);
                drawProgress(l, clamp(playMs / 1000, 0, totalSec), totalSec, paused);
                var diag = l.cols + "x" + l.rows + " c" + cprSeen + " r" + relayouts;
                console.write(gotoRC(l.rows, Math.max(1, l.cols - diag.length)) +
                    sgr("0;30;1") + diag + CLR);
                console.write(gotoRC(l.rows, l.cols) + CLR);
            }
        }
        apc("A;Flush;C=" + CHANNEL + ";O=250");
        console.write("\x1b[?25h"); // cursor back for the menus
        dbg("playLoop exit: result=" + result);
        return result;
    }
    // ---- self test (jsexec, headless) ----------------------------------------
    function selfTest() {
        // WAV round trip.
        var pcm = "";
        for (var i = 0; i < 2000; i++) {
            var v = Math.round(Math.sin(i / 8) * 12000);
            if (v < 0)
                v += 0x10000;
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
            pcm += String.fromCharCode(v & 0xff, (v >> 8) & 0xff);
        }
        var wav = wavHeader(pcm.length, 22050, 2) + pcm;
        var info = parseWavHeader(wav.substr(0, 256), wav.length);
        if (!info)
            throw new Error("parseWavHeader failed");
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
        if (fatInfo !== null)
            throw new Error("512-byte read should NOT see data yet");
        fatInfo = parseWavHeader(fat.substr(0, 2048), fat.length);
        if (!fatInfo)
            throw new Error("fat header did not parse");
        if (fatInfo.dataOffset !== 12 + 24 + 8 + 700 + 8)
            throw new Error("fat data offset wrong: " + fatInfo.dataOffset);
        if (fatInfo.dataBytes !== pcm.length)
            throw new Error("fat data bytes wrong");
        // Feature extraction: a loud sine has high RMS and some crossings;
        // silence has neither.
        var loud = chunkFeatures(pcm, 2);
        if (!(loud.rms > 0.4))
            throw new Error("sine rms too low: " + loud.rms);
        if (!(loud.zcr > 0))
            throw new Error("sine zcr zero");
        var quiet = chunkFeatures(repeatByte("\x00", 4000), 2);
        if (quiet.rms !== 0 || quiet.raw !== 0)
            throw new Error("silence rms nonzero");
        if (!(loud.raw > 0.15))
            throw new Error("sine raw rms too low: " + loud.raw);
        // ANSI grid: SAUCE strip, wrap-at-width, SGR attrs, cursor-forward.
        var sauced = "hello" + "\x1a" + repeatByte("\x00", 100) +
            "SAUCE00" + repeatByte("z", 121);
        if (FLAnsiGrid.stripSauce(sauced) !== "hello")
            throw new Error("SAUCE strip failed");
        var artSrc = "\x1b[1;31mAB\x1b[44m\x1b[3CC\r\nD";
        var g = FLAnsiGrid.render(artSrc, 4);
        if (g.height < 2)
            throw new Error("grid height: " + g.height);
        if ((g.rows[0][0] & 0xff) !== 65 || (g.rows[0][1] & 0xff) !== 66)
            throw new Error("grid chars wrong");
        var attrA = g.rows[0][0] >> 8;
        if ((attrA & 0x0f) !== (0x08 | 4)) // bright red (CGA red=4)
            throw new Error("grid attr wrong: " + attrA);
        var attrC = g.rows[0][3] >> 8;
        if (((attrC >> 4) & 0x07) !== 1) // blue bg (CGA blue=1)
            throw new Error("grid bg wrong: " + attrC);
        if ((g.rows[1][0] & 0xff) !== 68) // 'D' after CRLF
            throw new Error("grid newline wrong");
        // Wrap: 5 chars at width 4 flow onto row 1.
        var g2 = FLAnsiGrid.render("ABCDE", 4);
        if ((g2.rows[1][0] & 0xff) !== 69)
            throw new Error("wrap failed");
        // Emit: positions + chars + hue rotation changes output.
        var em0 = FLAnsiGrid.emit(g2, 5, 3, 0, 1, 0, 4, 0);
        if (em0.indexOf("\x1b[3;5H") !== 0)
            throw new Error("emit origin wrong");
        if (em0.indexOf("ABCD") < 0)
            throw new Error("emit chars wrong");
        var emRot = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 1);
        var emPlain = FLAnsiGrid.emit(g, 1, 1, 0, 1, 0, 4, 0);
        if (emRot === emPlain)
            throw new Error("hue rotation is a no-op");
        // BIN avatar decode: 10x6 cells, char+attr pairs.
        var bin = "";
        for (var bi = 0; bi < 60; bi++)
            bin += String.fromCharCode(65 + (bi % 26)) + String.fromCharCode(0x1f);
        var av = FLAnsiGrid.renderBin(bin, 10, 6);
        if (!av || av.height !== 6 || (av.rows[0][0] & 0xff) !== 65)
            throw new Error("renderBin failed");
        // Key normalization: every arrow representation -> the cursor code.
        var nk = [
            ["\x1b[A", "\x1e"], ["\x1bOA", "\x1e"], ["\x1e", "\x1e"], // up
            ["\x1b[B", "\x0a"], ["\x1bOB", "\x0a"], ["\x0a", "\x0a"], // down
            ["\x1b[5~", "\x10"], ["\x1b[6~", "\x0e"], // pgup/pgdn
            ["\x1b[H", "\x02"], ["\x1b[F", "\x05"], // home/end
            ["\x1b", "\x1b"], ["\r", "\r"], ["a", "a"], [" ", " "], // esc/enter/letter/space
            ["\x1b[=7;2;0n", ""] // APC reply -> ignored
        ];
        for (var nki = 0; nki < nk.length; nki++) {
            if (normalizeKey(nk[nki][0]) !== nk[nki][1])
                throw new Error("normalizeKey " + JSON.stringify(nk[nki][0]) + " -> " +
                    JSON.stringify(normalizeKey(nk[nki][0])) + " want " + JSON.stringify(nk[nki][1]));
        }
        // Avatar flash rotation: BLACK (fg 0) pinned, LIGHTGRAY (fg 7) moves.
        var fg = { width: 2, height: 1, rows: [[(0x00 << 8) | 0x41, (0x07 << 8) | 0x42]] };
        var fs = FLAnsiGrid.emitFlash(fg, 1, 1, 0, 1, 0, 2, 5);
        if (fs.indexOf(";30;") < 0)
            throw new Error("emitFlash moved BLACK");
        if (fs.indexOf(";37;") >= 0)
            throw new Error("emitFlash left LIGHTGRAY unchanged");
        // Horizontal mirror: cells reverse per row and directional glyphs swap.
        var mg = FLAnsiGrid.render("/(\xDD", 3);
        var mm = FLAnsiGrid.mirror(mg);
        if ((mm.rows[0][0] & 0xff) !== 0xde)
            throw new Error("half-block not mirrored");
        if ((mm.rows[0][1] & 0xff) !== 0x29)
            throw new Error("paren not mirrored");
        if ((mm.rows[0][2] & 0xff) !== 0x5c)
            throw new Error("slash not mirrored");
        if ((mm.rows[0][2] >> 8) !== (mg.rows[0][0] >> 8))
            throw new Error("mirror lost attrs");
        // Lyrics: timed lookup walks forward and resets after a back-seek;
        // distribution spaces untimed lines evenly.
        var ly = [{ time: 5, text: "one" }, { time: 10, text: "two" }, { time: 20, text: "three" }];
        if (lyricIndexFor(ly, 3, -1) !== -1)
            throw new Error("lyric before-first wrong");
        if (lyricIndexFor(ly, 12, 0) !== 1)
            throw new Error("lyric walk wrong");
        if (lyricIndexFor(ly, 6, 2) !== 0)
            throw new Error("lyric back-seek wrong");
        var dist = distributeLyrics("a\n\nb\nc", 40);
        if (dist.length !== 3 || Math.abs(dist[0].time - 10) > 0.01)
            throw new Error("lyric distribution wrong");
        // Base64 sanity over binary bytes.
        var rt = base64_decode(base64_encode(wav.substr(0, 200)));
        if (rt !== wav.substr(0, 200))
            throw new Error("base64 round trip failed");
        // Reply parser: feature reply, drain notify, arrows, keys, lone ESC.
        var p = new InputPump();
        var res = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        p.buf = "\x1b[=7;100;1nq\x1b[C\x1b[=7;2;0n\x1b";
        p.drain(res, true);
        if (res.audio.length !== 2)
            throw new Error("audio events: " + res.audio.length);
        if (res.audio[0][0] !== 100 || res.audio[0][1] !== 1)
            throw new Error("feature reply parse");
        if (res.audio[1][0] !== 2 || res.audio[1][1] !== 0)
            throw new Error("drain notify parse");
        if (res.keys.length !== 1 || res.keys[0] !== "Q")
            throw new Error("key parse");
        if (res.arrows.length !== 1 || res.arrows[0] !== "right")
            throw new Error("arrow parse");
        if (res.esc)
            throw new Error("lone ESC resolved too eagerly");
        p.escAt = nowMs() - 300; // aged past the patience window
        p.buf = "\x1b";
        p.drain(res, true);
        if (!res.esc)
            throw new Error("aged lone ESC did not resolve");
        // SS3 / application-cursor arrows (ESC O A..D): decode as arrows, never
        // as a bare Esc plus a stray letter. Also: a split SS3 must wait, not
        // mis-fire.
        var pSS3 = new InputPump();
        var rSS3 = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pSS3.buf = "\x1bOA\x1bOB\x1bOC\x1bOD";
        pSS3.drain(rSS3, true);
        if (rSS3.arrows.join(",") !== "up,down,right,left")
            throw new Error("SS3 arrow parse: " + rSS3.arrows.join(","));
        if (rSS3.esc || rSS3.keys.length)
            throw new Error("SS3 arrows leaked esc/keys");
        var pSS3s = new InputPump();
        var rSS3s = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pSS3s.buf = "\x1bO";
        pSS3s.drain(rSS3s, true);
        if (rSS3s.esc || rSS3s.arrows.length)
            throw new Error("partial SS3 resolved too eagerly");
        pSS3s.buf += "A";
        pSS3s.drain(rSS3s, true);
        if (rSS3s.arrows.length !== 1 || rSS3s.arrows[0] !== "up")
            throw new Error("split SS3 did not resolve to up");
        // Synchronet cooks cursor keys into single control bytes (console.inkey);
        // the pump must surface those as arrows. KEY_DOWN (\x0a) must NOT read as
        // Enter -- that made the song list's Down arrow play the track.
        var pNav = new InputPump();
        var rNav = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pNav.buf = "\x1e\x0a\x1d\x06\x10\x0e\x02\x05";
        pNav.drain(rNav, true);
        if (rNav.arrows.join(",") !== "up,down,left,right,pgup,pgdn,home,end")
            throw new Error("cooked nav parse: " + rNav.arrows.join(","));
        if (rNav.keys.length)
            throw new Error("cooked nav leaked keys: " + rNav.keys.join(","));
        // The killer case: an audio notify split right after its ESC byte
        // must NOT become Esc + plain chars (the phantom 'N' bug).
        var pSplit = new InputPump();
        var rSplit = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pSplit.buf = "\x1b";
        pSplit.drain(rSplit, true); // pump boundary hits mid-sequence
        pSplit.buf += "[=7;2;0n"; // the rest arrives next pump
        pSplit.drain(rSplit, true);
        if (rSplit.esc)
            throw new Error("split notify produced phantom Esc");
        if (rSplit.keys.length)
            throw new Error("split notify leaked keys: " + rSplit.keys.join(","));
        if (rSplit.audio.length !== 1 || rSplit.audio[0][0] !== 2 || rSplit.audio[0][1] !== 0)
            throw new Error("split notify not reassembled");
        var p3 = new InputPump();
        var r3 = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        p3.buf = "\x1b[74;162R";
        p3.drain(r3, true);
        if (r3.cpr.length !== 1 || r3.cpr[0][0] !== 74 || r3.cpr[0][1] !== 162)
            throw new Error("CPR parse failed");
        // Every palette map must be a permutation of 0..7 (no color loss).
        for (var pi = 0; pi < FLAnsiGrid.PALETTES.length; pi++) {
            var seenIdx = {};
            for (var pj = 0; pj < 8; pj++)
                seenIdx[FLAnsiGrid.PALETTES[pi][pj]] = true;
            for (var pk = 0; pk < 8; pk++)
                if (!seenIdx[pk])
                    throw new Error("palette " + pi + " not a permutation");
        }
        // Orphaned notify tail (the flight-recorder shred): the engine ate
        // the ESC; the bare tail must become an audio event, NOT keys ending
        // in a phantom 'N'.
        var pOrf = new InputPump();
        var rOrf = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pOrf.buf = "[=7;2;0n";
        pOrf.drain(rOrf, true);
        if (rOrf.keys.length)
            throw new Error("orphan tail leaked keys: " + rOrf.keys.join(""));
        if (rOrf.audio.length !== 1 || rOrf.audio[0][0] !== 2 || rOrf.audio[0][1] !== 0)
            throw new Error("orphan tail not recovered as audio");
        // Orphaned CPR tail likewise.
        var rOrf2 = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pOrf.buf = "[74;162R";
        pOrf.drain(rOrf2, true);
        if (rOrf2.keys.length || rOrf2.cpr.length !== 1 || rOrf2.cpr[0][0] !== 74)
            throw new Error("orphan CPR not recovered");
        // A real '[' keystroke still gets through once aged.
        var rOrf3 = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        pOrf.buf = "[";
        pOrf.bracketAt = nowMs() - 300;
        pOrf.drain(rOrf3, true);
        if (rOrf3.keys.length !== 1 || rOrf3.keys[0] !== "[")
            throw new Error("aged bracket keystroke lost");
        // Split CSI across feeds must not produce phantom keys.
        var p2 = new InputPump();
        var r2 = { keys: [], arrows: [], esc: false, audio: [], cpr: [], other: [] };
        p2.buf = "\x1b[=7;2";
        p2.drain(r2, false);
        if (r2.keys.length || r2.audio.length || r2.esc)
            throw new Error("partial CSI leaked");
        p2.buf += ";0n";
        p2.drain(r2, true);
        if (r2.audio.length !== 1)
            throw new Error("resumed CSI lost");
        // Margin rects: bottom flanks exist beside the box and never cover
        // the box span itself.
        var fakeL = {
            cols: 120, rows: 40, boxTop: 36, boxLeft: 23, boxWidth: 76,
            glowRow1: 33, lyricRow: 34, lyricLeft: 23, lyricWidth: 76,
            glowRow2: 35, artTop: 1, artBottom: 32
        };
        // Lyric strip grows past the box on a wide terminal with long lines,
        // but never below the box width, and stays capped at cols-2.
        if (layout(120, 40, 100).lyricWidth !== 102)
            throw new Error("lyric grow");
        if (layout(120, 40, 40).lyricWidth !== 76)
            throw new Error("lyric no-shrink");
        if (layout(80, 40, 200).lyricWidth !== 78)
            throw new Error("lyric cap to cols");
        var fakeBlit = {
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
        if (!stripRows)
            throw new Error("glow/lyric strip rects missing");
        if (!flankL || !flankR)
            throw new Error("box-row flanks missing");
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
            if (!ffmpegAvailable())
                throw new Error("ffmpeg not available");
            var t = {
                path: mp3,
                name: "selftest.mp3",
                size: file_size(mp3),
                mtime: file_date(mp3),
                title: "Self Test",
                artist: "",
                ansiArt: ""
            };
            var wp = ensureTranscoded(t);
            if (wp === null)
                throw new Error("transcode failed");
            var tf = new File(wp);
            if (!tf.open("rb"))
                throw new Error("cache open failed");
            var inf = readWavInfo(tf);
            if (!inf) {
                tf.close();
                throw new Error("ffmpeg WAV did not parse");
            }
            var bps = inf.rate * inf.channels * 2;
            var chunkB = Math.floor(bps * CHUNK_MS / 1000);
            chunkB -= chunkB % (inf.channels * 2);
            // Slice a mid-song chunk and make sure it yields features + b64.
            var midChunk = Math.floor((inf.dataBytes / chunkB) / 2);
            tf.position = inf.dataOffset + midChunk * chunkB;
            var slice = tf.read(chunkB);
            tf.close();
            if (!slice || slice.length !== chunkB)
                throw new Error("slice read failed");
            var feats = chunkFeatures(slice, inf.channels);
            var b64len = base64_encode(wavHeader(slice.length, inf.rate, inf.channels) + slice).length;
            writeln(format("FLPlayer transcode test: OK  rate=%d ch=%d duration=%ds chunks=%d chunkB64=%d rms=%s zcr=%s", inf.rate, inf.channels, Math.round(inf.dataBytes / bps), Math.ceil(inf.dataBytes / chunkB), b64len, feats.rms.toFixed(2), feats.zcr.toFixed(2)));
        }
    }
    FLPlayer.selfTest = selfTest;
})(FLPlayer || (FLPlayer = {}));
(function () {
    "use strict";
    var APP_TITLE = "Futureland Records";
    var DIR_CODE = "originalcontent_mp3s";
    var CHAT_CHANNEL = "main";
    var CACHE_VERSION = 2;
    // Sentinel returned by uifc.list when a caller-defined hotkey is pressed
    // (distinct from a row index >= 0 and from Esc's -1).
    var UI_ACTION_DETAIL = -2;
    // The single app state, so the in-player Browse/Create actions can reach the
    // catalog and compose flow without threading it through every call.
    var activeApp;
    var CACHE_FILE = "catalog-cache.json";
    var uiReady = false;
    load("sbbsdefs.js");
    load("uifcdefs.js");
    try {
        load("userdefs.js");
    }
    catch (_) { }
    try {
        load("utf8_cp437.js");
    }
    catch (_) { }
    try {
        load("utf8_utf16.js");
    }
    catch (_) { }
    try {
        load("json-db.js");
    }
    catch (_) { } // per-user playlist storage
    function createDefaultFilters() {
        return {
            search: "",
            artist: "",
            composer: "",
            genre: ""
        };
    }
    function createComposeState() {
        var sections = {};
        var i;
        for (i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
            sections[FLRecordsData.sectionDefs[i].key] = {
                notes: "",
                text: ""
            };
        }
        return {
            songTitle: "",
            brief: "",
            notes: "",
            genre: "",
            feel: "",
            tone: "",
            arrangement: "",
            instrumentation: "",
            groove: "",
            band: "",
            leadvocal: "",
            backingvocal: "",
            language: "",
            key: "",
            timesig: "",
            bpmMode: "",
            bpmValue: "",
            duration: "",
            lyricMode: "freeform",
            lyricsFreeform: "",
            sections: sections,
            cowriter: "",
            memoryActive: false,
            waitForResponse: false
        };
    }
    function createAppState() {
        return {
            catalog: [],
            filters: createDefaultFilters(),
            compose: createComposeState(),
            cowriters: [],
            mainMenuCtx: new uifc.list.CTX(),
            trackListCtx: new uifc.list.CTX(),
            filterMenuCtx: new uifc.list.CTX(),
            composeMenuCtx: new uifc.list.CTX()
        };
    }
    function initUi() {
        var mode = (argv && argv.length > 0) ? String(argv[0]) : undefined;
        if (uifc.init(APP_TITLE, mode)) {
            uiReady = true;
            return;
        }
        uiReady = false;
        console.clear();
        console.writeln(APP_TITLE);
        console.writeln("");
        console.writeln("UIFC is required for this door.");
        console.pause();
        exit();
    }
    function safeBailUi() {
        if (!uiReady)
            return;
        try {
            uifc.bail();
        }
        catch (_) {
        }
        uiReady = false;
    }
    function withConsoleScreen(body) {
        var hadUi = uiReady;
        if (hadUi)
            safeBailUi();
        console.clear();
        try {
            body();
        }
        finally {
            if (hadUi)
                initUi();
        }
    }
    function pathJoin(base, leaf) {
        var prefix = String(base || "");
        if (!prefix.length)
            return String(leaf || "");
        if (prefix.charAt(prefix.length - 1) === "/" || prefix.charAt(prefix.length - 1) === "\\") {
            return prefix + leaf;
        }
        return prefix + "/" + leaf;
    }
    function dataDirPath() {
        return pathJoin(fullpath(js.exec_dir), "data");
    }
    function cacheFilePath() {
        return pathJoin(dataDirPath(), CACHE_FILE);
    }
    function ensureDataDir() {
        var dir = dataDirPath();
        if (!file_exists(dir)) {
            try {
                mkpath(dir);
            }
            catch (_) {
            }
        }
    }
    function showLoadingStatus(title, detail) {
        console.clear();
        console.writeln(APP_TITLE);
        console.writeln(repeatChar("=", APP_TITLE.length));
        console.writeln("");
        console.writeln(title);
        if (detail) {
            console.writeln(detail);
        }
        console.writeln("");
        console.writeln("Please wait...");
    }
    function repeatChar(ch, count) {
        var out = "";
        var i;
        for (i = 0; i < count; i += 1)
            out += ch;
        return out;
    }
    function safeString(value) {
        if (value === null || value === undefined)
            return "";
        return String(value);
    }
    function trimValue(value) {
        return safeString(value).replace(/\r/g, "").replace(/^\s+|\s+$/g, "");
    }
    function lower(value) {
        return trimValue(value).toLowerCase();
    }
    function sentence(text) {
        var value = trimValue(text);
        if (!value.length)
            return "";
        return /[.!?]$/.test(value) ? value : (value + ".");
    }
    function byteAt(data, index) {
        if (index < 0 || index >= data.length)
            return 0;
        return data.charCodeAt(index) & 0xff;
    }
    function synchsafe32(data, offset) {
        return ((byteAt(data, offset) & 0x7f) << 21) |
            ((byteAt(data, offset + 1) & 0x7f) << 14) |
            ((byteAt(data, offset + 2) & 0x7f) << 7) |
            (byteAt(data, offset + 3) & 0x7f);
    }
    function be32(data, offset) {
        return ((byteAt(data, offset) << 24) >>> 0) |
            (byteAt(data, offset + 1) << 16) |
            (byteAt(data, offset + 2) << 8) |
            byteAt(data, offset + 3);
    }
    function be16(data, offset) {
        return (byteAt(data, offset) << 8) | byteAt(data, offset + 1);
    }
    function removeUnsync(data) {
        return data.replace(/\xff\0/g, "\xff");
    }
    function findNullTerminator(data, start, encoding) {
        var i;
        if (encoding === 1 || encoding === 2) {
            for (i = start; i < data.length - 1; i += 2) {
                if (byteAt(data, i) === 0 && byteAt(data, i + 1) === 0)
                    return i;
            }
            return data.length;
        }
        i = data.indexOf("\0", start);
        return i >= 0 ? i : data.length;
    }
    function decodeLatin1(data) {
        var nul = data.indexOf("\0");
        if (nul >= 0)
            data = data.substring(0, nul);
        return data;
    }
    function decodeUtf8(data) {
        var nul = data.indexOf("\0");
        if (nul >= 0)
            data = data.substring(0, nul);
        if (typeof utf8_utf16 === "function") {
            try {
                return utf8_utf16(data);
            }
            catch (_) {
            }
        }
        return data;
    }
    function decodeUtf16(data, bigEndianDefault) {
        var littleEndian = !bigEndianDefault;
        var offset = 0;
        var out = "";
        var i;
        var b1;
        var b2;
        var code;
        if (data.length >= 2) {
            b1 = byteAt(data, 0);
            b2 = byteAt(data, 1);
            if (b1 === 0xff && b2 === 0xfe) {
                littleEndian = true;
                offset = 2;
            }
            else if (b1 === 0xfe && b2 === 0xff) {
                littleEndian = false;
                offset = 2;
            }
        }
        for (i = offset; i + 1 < data.length; i += 2) {
            b1 = byteAt(data, i);
            b2 = byteAt(data, i + 1);
            if (b1 === 0 && b2 === 0)
                break;
            code = littleEndian ? ((b2 << 8) | b1) : ((b1 << 8) | b2);
            out += String.fromCharCode(code);
        }
        return out;
    }
    function decodeTextByEncoding(encoding, data) {
        if (encoding === 1)
            return decodeUtf16(data, false);
        if (encoding === 2)
            return decodeUtf16(data, true);
        if (encoding === 3)
            return decodeUtf8(data);
        return decodeLatin1(data);
    }
    function parseUserTextFrame(data) {
        var encoding = byteAt(data, 0);
        var descriptionEnd = findNullTerminator(data, 1, encoding);
        var description = decodeTextByEncoding(encoding, data.substring(1, descriptionEnd));
        var valueStart = descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
        var value = valueStart < data.length ? decodeTextByEncoding(encoding, data.substring(valueStart)) : "";
        return {
            description: trimValue(description),
            value: trimValue(value)
        };
    }
    function parseUnsyncedLyrics(data) {
        var encoding = byteAt(data, 0);
        var descriptorStart = 4;
        var descriptorEnd = findNullTerminator(data, descriptorStart, encoding);
        var lyricStart = descriptorEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
        if (lyricStart >= data.length)
            return "";
        return trimValue(decodeTextByEncoding(encoding, data.substring(lyricStart)));
    }
    function parseSyncedLyrics(data) {
        var encoding = byteAt(data, 0);
        var timestampFormat = byteAt(data, 4);
        var pos = 6;
        var lines = [];
        var textEnd;
        var text;
        var timestamp;
        var seconds;
        pos = findNullTerminator(data, pos, encoding) + ((encoding === 1 || encoding === 2) ? 2 : 1);
        while (pos + 4 <= data.length) {
            textEnd = findNullTerminator(data, pos, encoding);
            text = decodeTextByEncoding(encoding, data.substring(pos, textEnd));
            pos = textEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
            if (pos + 4 > data.length)
                break;
            timestamp = be32(data, pos);
            pos += 4;
            seconds = timestampFormat === 2 ? (timestamp / 1000) : (timestamp / 38.46);
            text = trimValue(text);
            if (text.length) {
                lines.push({ time: seconds, text: text });
            }
        }
        return lines;
    }
    function flattenSyncedLyrics(lines) {
        var out = [];
        var i;
        for (i = 0; i < lines.length; i += 1) {
            if (!lines[i].text.length)
                continue;
            if (!out.length || out[out.length - 1] !== lines[i].text) {
                out.push(lines[i].text);
            }
        }
        return out.join("\n");
    }
    function cleanGenre(value) {
        var genre = trimValue(value);
        var match = genre.match(/^\((\d+)\)/);
        var genres = [
            "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
            "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae",
            "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
            "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion",
            "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip",
            "Gospel", "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
            "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave",
            "Techno-Industrial", "Electronic"
        ];
        if (match) {
            var idx = parseInt(match[1], 10);
            if (!isNaN(idx) && idx >= 0 && idx < genres.length) {
                return genres[idx];
            }
        }
        return genre;
    }
    function emptyParsedTags() {
        return {
            title: "",
            artist: "",
            composer: "",
            genre: "",
            year: "",
            album: "",
            durationMs: "",
            trackNumber: "",
            lyricsText: "",
            syncedLyrics: [],
            ansiArtBase64: "",
            ansiBitmapBase64: ""
        };
    }
    function parseTrackTags(path, options) {
        var result = emptyParsedTags();
        var file = new File(path);
        var header;
        var version;
        var flags;
        var tagSize;
        var tagEnd;
        var hasUnsync;
        var extHeader;
        var extSize;
        var frameHeader;
        var frameId;
        var frameSize;
        var frameFlags;
        var frameData;
        var frameNeedsBody;
        var textFrames = {
            "TIT2": "title",
            "TPE1": "artist",
            "TCOM": "composer",
            "TCON": "genre",
            "TDRC": "year",
            "TYER": "year",
            "TALB": "album",
            "TLEN": "durationMs",
            "TRCK": "trackNumber"
        };
        var textKey;
        var parsedUserText;
        if (!file.open("rb"))
            return result;
        try {
            header = file.read(10);
            if (!header || header.length < 10 || header.substring(0, 3) !== "ID3") {
                return result;
            }
            version = byteAt(header, 3);
            flags = byteAt(header, 5);
            tagSize = synchsafe32(header, 6);
            tagEnd = 10 + tagSize;
            hasUnsync = (flags & 0x80) !== 0;
            if ((flags & 0x40) !== 0) {
                extHeader = file.read(4);
                if (extHeader && extHeader.length === 4) {
                    extSize = version >= 4 ? synchsafe32(extHeader, 0) : be32(extHeader, 0);
                    if (extSize > 4) {
                        file.position += extSize - 4;
                    }
                }
            }
            while (file.position + 10 <= tagEnd) {
                frameHeader = file.read(10);
                if (!frameHeader || frameHeader.length < 10)
                    break;
                frameId = frameHeader.substring(0, 4);
                if (!frameId.replace(/\0/g, "").length)
                    break;
                frameSize = version >= 4 ? synchsafe32(frameHeader, 4) : be32(frameHeader, 4);
                frameFlags = be16(frameHeader, 8);
                if (frameSize <= 0)
                    break;
                if (file.position + frameSize > tagEnd)
                    break;
                frameNeedsBody = false;
                if (textFrames[frameId])
                    frameNeedsBody = true;
                if (frameId === "TXXX" && options.includeAnsiArt)
                    frameNeedsBody = true;
                if ((frameId === "USLT" || frameId === "SYLT") && options.includeLyrics)
                    frameNeedsBody = true;
                if (!frameNeedsBody) {
                    file.position += frameSize;
                    continue;
                }
                frameData = file.read(frameSize);
                if (hasUnsync || ((version >= 4) && ((frameFlags & 0x02) !== 0))) {
                    frameData = removeUnsync(frameData);
                }
                textKey = textFrames[frameId];
                if (textKey) {
                    result[textKey] = trimValue(decodeTextByEncoding(byteAt(frameData, 0), frameData.substring(1)));
                    continue;
                }
                if (frameId === "TXXX") {
                    parsedUserText = parseUserTextFrame(frameData);
                    if (parsedUserText.description === "ANSI_ART") {
                        result.ansiArtBase64 = parsedUserText.value;
                    }
                    else if (parsedUserText.description === "ANSI_BITMAP") {
                        result.ansiBitmapBase64 = parsedUserText.value;
                    }
                    continue;
                }
                if (frameId === "USLT") {
                    result.lyricsText = parseUnsyncedLyrics(frameData);
                    continue;
                }
                if (frameId === "SYLT") {
                    result.syncedLyrics = parseSyncedLyrics(frameData);
                }
            }
        }
        finally {
            file.close();
        }
        result.genre = cleanGenre(result.genre);
        if (!result.lyricsText.length && result.syncedLyrics.length) {
            result.lyricsText = flattenSyncedLyrics(result.syncedLyrics);
        }
        return result;
    }
    function fileStem(name) {
        return safeString(name).replace(/\.[^.]+$/, "");
    }
    function displayTrackTitle(track) {
        return trimValue(track.title) || fileStem(track.name);
    }
    function displayTrackArtist(track) {
        return trimValue(track.artist) || trimValue(track.composer) || "Unknown Artist";
    }
    function trackSearchHaystack(track) {
        return lower(track.name + " " + displayTrackTitle(track) + " " + track.artist + " " + track.composer + " " + track.genre + " " + track.album);
    }
    function truncateText(text, width) {
        if (text.length <= width)
            return text;
        if (width <= 3)
            return text.substring(0, width);
        return text.substring(0, width - 3) + "...";
    }
    function padRight(text, width) {
        var value = text;
        while (value.length < width)
            value += " ";
        return value;
    }
    function trackRow(track) {
        var title = truncateText(toScreenText(displayTrackTitle(track)), 38);
        var artist = truncateText(toScreenText(displayTrackArtist(track)), 22);
        var genre = truncateText(toScreenText(trimValue(track.genre) || "-"), 14);
        return padRight(title, 40) + padRight(artist, 24) + genre;
    }
    function readJsonFile(path) {
        var file = new File(path);
        var raw;
        if (!file.open("r"))
            return null;
        try {
            raw = file.read();
        }
        finally {
            file.close();
        }
        if (!raw || !trimValue(raw).length)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch (_) {
            return null;
        }
    }
    function writeJsonFile(path, value) {
        var file = new File(path);
        if (!file.open("w+"))
            return;
        try {
            file.write(JSON.stringify(value, null, 2));
        }
        finally {
            file.close();
        }
    }
    function readCatalogCache() {
        var cached = readJsonFile(cacheFilePath());
        if (!cached || cached.version !== CACHE_VERSION || !cached.tracks) {
            return {
                version: CACHE_VERSION,
                generatedAt: 0,
                tracks: {}
            };
        }
        return cached;
    }
    function summaryFromCache(cached, path) {
        return {
            name: cached.name,
            path: path,
            description: cached.description || "",
            size: cached.size || 0,
            mtime: cached.mtime || 0,
            added: cached.added || 0,
            title: screenSafe(cached.title || ""),
            artist: screenSafe(cached.artist || ""),
            composer: screenSafe(cached.composer || ""),
            genre: screenSafe(cached.genre || ""),
            album: screenSafe(cached.album || ""),
            year: cached.year || "",
            durationMs: cached.durationMs || "",
            trackNumber: cached.trackNumber || ""
        };
    }
    function cacheFromSummary(track) {
        return {
            name: track.name,
            title: track.title,
            artist: track.artist,
            composer: track.composer,
            genre: track.genre,
            album: track.album,
            year: track.year,
            durationMs: track.durationMs,
            trackNumber: track.trackNumber,
            description: track.description,
            size: track.size,
            mtime: track.mtime,
            added: track.added
        };
    }
    function buildSummary(meta, path, size, mtime, parsed) {
        return {
            name: safeString(meta.name),
            path: path,
            description: trimValue(meta.desc || meta.description || ""),
            size: size,
            mtime: mtime,
            added: typeof meta.added === "number" ? meta.added : 0,
            title: screenSafe(parsed.title),
            artist: screenSafe(parsed.artist),
            composer: screenSafe(parsed.composer),
            genre: screenSafe(parsed.genre),
            album: screenSafe(parsed.album),
            year: trimValue(parsed.year),
            durationMs: trimValue(parsed.durationMs),
            trackNumber: trimValue(parsed.trackNumber)
        };
    }
    function sortTracks(tracks) {
        tracks.sort(function (a, b) {
            var aTitle = lower(displayTrackTitle(a));
            var bTitle = lower(displayTrackTitle(b));
            if (aTitle < bTitle)
                return -1;
            if (aTitle > bTitle)
                return 1;
            if (lower(a.artist) < lower(b.artist))
                return -1;
            if (lower(a.artist) > lower(b.artist))
                return 1;
            return lower(a.name) < lower(b.name) ? -1 : 1;
        });
    }
    // Per-track tag overrides shared with the web records page: the web tag
    // manager writes data/futureland-records/track-overrides.ini (section =
    // lowercase filename), layering artist/title/etc over the file's ID3.
    // Without this the door shows the raw engine tag ("Vektrax") while the
    // web shows the assigned persona ("CINDER") — and resolves wrong avatars.
    function loadTrackOverrides() {
        var map = {};
        var path = backslash(system.data_dir) + "futureland-records/track-overrides.ini";
        if (!file_exists(path))
            return map;
        var f = new File(path);
        if (!f.open("r"))
            return map;
        try {
            var sections = f.iniGetSections() || [];
            for (var i = 0; i < sections.length; i++) {
                var obj = f.iniGetObject(sections[i]);
                if (obj)
                    map[lower(sections[i])] = obj;
            }
        }
        catch (err) {
            log(LOG_WARNING, "fl_records track overrides load failed: " + safeString(err));
        }
        finally {
            f.close();
        }
        return map;
    }
    function applyTrackOverrides(tracks) {
        var overrides = loadTrackOverrides();
        var fields = ["title", "artist", "composer", "genre", "year", "album"];
        for (var i = 0; i < tracks.length; i++) {
            var ov = overrides[lower(tracks[i].name)];
            if (!ov)
                continue;
            for (var fIdx = 0; fIdx < fields.length; fIdx++) {
                var v = trimValue(ov[fields[fIdx]]);
                if (v.length)
                    tracks[i][fields[fIdx]] = v;
            }
        }
    }
    function loadCatalog(forceRefresh) {
        var tracks = loadCatalogInner(forceRefresh);
        applyTrackOverrides(tracks);
        return tracks;
    }
    function loadCatalogInner(forceRefresh) {
        var base = new FileBase(DIR_CODE);
        var list;
        var cache = forceRefresh ? {
            version: CACHE_VERSION,
            generatedAt: 0,
            tracks: {}
        } : readCatalogCache();
        var nextCache = {
            version: CACHE_VERSION,
            generatedAt: time(),
            tracks: {}
        };
        var tracks = [];
        var changed = forceRefresh;
        var i;
        var meta;
        var path;
        var size;
        var mtime;
        var cached;
        var parsed;
        var detail;
        ensureDataDir();
        if (!file_area.dir[DIR_CODE]) {
            throw new Error("File area '" + DIR_CODE + "' is not configured.");
        }
        if (!base.open()) {
            throw new Error("Could not open file base '" + DIR_CODE + "': " + safeString(base.error));
        }
        try {
            list = base.get_list("*.mp3", FileBase.DETAIL.NORM, 0, true, FileBase.SORT.NAME_AI) || [];
            for (i = 0; i < list.length; i += 1) {
                meta = list[i];
                path = base.get_path(meta);
                size = typeof meta.size === "number" ? meta.size : base.get_size(meta);
                mtime = base.get_time(meta);
                cached = cache.tracks[safeString(meta.name)];
                detail = format("%d / %d", i + 1, list.length) + "  " + safeString(meta.name);
                showLoadingStatus(forceRefresh ? "Refreshing track catalog..." : "Loading track catalog...", detail);
                if (cached && cached.size === size && cached.mtime === mtime) {
                    tracks.push(summaryFromCache(cached, path));
                    nextCache.tracks[cached.name] = cached;
                    continue;
                }
                parsed = parseTrackTags(path, {
                    includeLyrics: false,
                    includeAnsiArt: false
                });
                tracks.push(buildSummary(meta, path, size, mtime, parsed));
                nextCache.tracks[safeString(meta.name)] = cacheFromSummary(tracks[tracks.length - 1]);
                changed = true;
            }
        }
        finally {
            base.close();
        }
        if (Object.keys(cache.tracks).length !== Object.keys(nextCache.tracks).length) {
            changed = true;
        }
        if (changed)
            writeJsonFile(cacheFilePath(), nextCache);
        sortTracks(tracks);
        return tracks;
    }
    // --- decorative-Unicode transliteration ---------------------------------
    // AI-generated artist handles use small-caps, fullwidth, accented, and
    // emoji glyphs (e.g. "🗲ᴍʀᴏ1337" — a decorated
    // "mro1337"). Their codepoints are >0xFF; rendered on a CP437 terminal each
    // is truncated to 8 bits and some land on C0 controls (U+1D0D -> 0x0D CR)
    // that jump the cursor, smear the list, and corrupt the JSON cache. Fold
    // everything to plain ASCII so metadata is safe on every terminal.
    var SMALL_CAPS = {
        0x1D00: "a", 0x0299: "b", 0x1D04: "c", 0x1D05: "d", 0x1D07: "e", 0xA730: "f",
        0x0262: "g", 0x029C: "h", 0x026A: "i", 0x1D0A: "j", 0x1D0B: "k", 0x029F: "l",
        0x1D0D: "m", 0x0274: "n", 0x1D0F: "o", 0x1D18: "p", 0xA7AF: "q", 0x0280: "r",
        0xA731: "s", 0x1D1B: "t", 0x1D1C: "u", 0x1D20: "v", 0x1D21: "w", 0x028F: "y",
        0x1D22: "z", 0x1D01: "ae"
    };
    var GLYPH_ASCII = {
        0x2018: "'", 0x2019: "'", 0x201A: "'", 0x2032: "'",
        0x201C: "\"", 0x201D: "\"", 0x201E: "\"", 0x2033: "\"",
        0x2013: "-", 0x2014: "-", 0x2015: "-", 0x2212: "-",
        0x2026: "...", 0x2022: "*", 0x00B7: "*", 0x00D7: "x", 0x00F7: "/",
        0x2260: "!=", 0x2264: "<=", 0x2265: ">=", 0x00B1: "+/-",
        0x00A9: "(c)", 0x00AE: "(r)", 0x2122: "tm", 0x00B0: "deg",
        0x00C6: "AE", 0x00E6: "ae", 0x0152: "OE", 0x0153: "oe", 0x00DF: "ss",
        0x20AC: "EUR", 0x00A3: "GBP", 0x00A5: "JPY", 0x00A2: "c"
    };
    // Latin-1 accented letters 0xC0..0xFF -> base ASCII. A space means "handled
    // above / drop" (index by codepoint - 0xC0).
    var LATIN1_FOLD = "AAAAAAACEEEEIIIIDNOOOOO OUUUUYT aaaaaaaceeeeiiiidnooooo ouuuuyty";
    // Collapse decorative text to terminal-safe ASCII. Idempotent on clean text.
    function screenSafe(value) {
        var s = safeString(value);
        if (!s.length)
            return "";
        // Raw UTF-8 bytes (e.g. straight from an .ini) -> codepoints first, so
        // multibyte glyphs fold as a unit instead of being mangled byte-by-byte.
        if (typeof str_is_utf8 === "function" && typeof utf8_utf16 === "function") {
            try {
                if (str_is_utf8(s) && /[\x80-\xff]/.test(s))
                    s = utf8_utf16(s);
            }
            catch (_) {
            }
        }
        var out = "";
        for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c === 0x09) {
                out += " ";
                continue;
            } // tab -> space
            if (c < 0x20 || c === 0x7f)
                continue; // strip C0 controls + DEL
            if (c <= 0x7e) {
                out += s.charAt(i);
                continue;
            } // printable ASCII
            if (SMALL_CAPS[c] !== undefined) {
                out += SMALL_CAPS[c];
                continue;
            }
            if (GLYPH_ASCII[c] !== undefined) {
                out += GLYPH_ASCII[c];
                continue;
            }
            if (c >= 0xc0 && c <= 0xff) {
                var f = LATIN1_FOLD.charAt(c - 0xc0);
                if (f !== " ")
                    out += f;
                continue;
            }
            if (c >= 0xff01 && c <= 0xff5e) {
                out += String.fromCharCode(c - 0xfee0);
                continue;
            }
            // Unknown decorative / emoji / symbol: drop it.
        }
        return out.replace(/[ \t]{2,}/g, " ").replace(/^\s+|\s+$/g, "");
    }
    function toScreenText(value) {
        return screenSafe(value);
    }
    function getFilteredTracks(app) {
        var filtered = [];
        var i;
        var track;
        var search = lower(app.filters.search);
        for (i = 0; i < app.catalog.length; i += 1) {
            track = app.catalog[i];
            if (app.filters.artist.length && lower(track.artist) !== lower(app.filters.artist))
                continue;
            if (app.filters.composer.length && lower(track.composer) !== lower(app.filters.composer))
                continue;
            if (app.filters.genre.length && lower(track.genre) !== lower(app.filters.genre))
                continue;
            if (search.length && trackSearchHaystack(track).indexOf(search) < 0)
                continue;
            filtered.push(track);
        }
        return filtered;
    }
    function uniqueValues(tracks, key) {
        var map = {};
        var values = [];
        var i;
        var value;
        for (i = 0; i < tracks.length; i += 1) {
            value = trimValue(tracks[i][key]);
            if (!value.length || map[lower(value)])
                continue;
            map[lower(value)] = true;
            values.push(value);
        }
        values.sort(function (a, b) {
            return lower(a) < lower(b) ? -1 : 1;
        });
        return values;
    }
    function promptInput(title, current, maxLen, mode) {
        var value = uifc.input(WIN_MID | WIN_SAV, title, current, maxLen, mode);
        if (value === null || value === undefined)
            return null;
        return safeString(value);
    }
    function chooseValueMenu(title, current, values, allLabel) {
        var items = [allLabel].concat(values.map(function (entry) {
            return toScreenText(entry);
        }));
        var ctx = new uifc.list.CTX();
        var selection;
        var currentIndex = 0;
        var i;
        for (i = 0; i < values.length; i += 1) {
            if (lower(values[i]) === lower(current)) {
                currentIndex = i + 1;
                ctx.cur = currentIndex;
                ctx.bar = currentIndex;
                break;
            }
        }
        selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, ctx);
        if (selection < 0)
            return current;
        if (selection === 0)
            return "";
        return values[selection - 1];
    }
    function filterSummary(filters) {
        var parts = [];
        if (filters.search.length)
            parts.push("Search=" + filters.search);
        if (filters.artist.length)
            parts.push("Artist=" + filters.artist);
        if (filters.composer.length)
            parts.push("Composer=" + filters.composer);
        if (filters.genre.length)
            parts.push("Genre=" + filters.genre);
        return parts.length ? parts.join(" | ") : "No filters";
    }
    function editTrackFilters(app) {
        var options;
        var choice;
        var values;
        while (bbs.online && !js.terminated) {
            options = [
                "Search text         " + summarizeValue(app.filters.search, composeValueWidth()),
                "Artist              " + summarizeValue(app.filters.artist || "All artists", composeValueWidth()),
                "Composer            " + summarizeValue(app.filters.composer || "All composers", composeValueWidth()),
                "Genre               " + summarizeValue(app.filters.genre || "All genres", composeValueWidth()),
                "Clear all filters",
                "Back"
            ];
            uifc.help_text = "Filter the read/listen catalog by search text, artist, composer, or genre.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Track Filters", options, app.filterMenuCtx);
            if (choice < 0 || choice === 5)
                return;
            if (choice === 0) {
                var search = promptInput("Search text", app.filters.search, 120, K_EDIT);
                if (search !== null)
                    app.filters.search = trimValue(search);
            }
            else if (choice === 1) {
                values = uniqueValues(app.catalog, "artist");
                app.filters.artist = chooseValueMenu("Artist Filter", app.filters.artist, values, "All artists");
            }
            else if (choice === 2) {
                values = uniqueValues(app.catalog, "composer");
                app.filters.composer = chooseValueMenu("Composer Filter", app.filters.composer, values, "All composers");
            }
            else if (choice === 3) {
                values = uniqueValues(app.catalog, "genre");
                app.filters.genre = chooseValueMenu("Genre Filter", app.filters.genre, values, "All genres");
            }
            else if (choice === 4) {
                app.filters = createDefaultFilters();
            }
        }
    }
    function summarizeValue(value, maxLen) {
        return truncateText(toScreenText(trimValue(value)), maxLen);
    }
    // How much room a field's value gets in the compose menus, given the ~20-col
    // label. Grows with the terminal (80-col floor) so long briefs use the screen
    // instead of being clipped to a fixed width in the middle of a big display.
    function composeValueWidth() {
        var cols = console.screen_columns || 80;
        if (cols < 80)
            cols = 80;
        return Math.max(34, cols - 28);
    }
    function wrapText(text, width) {
        var lines = safeString(text).replace(/\r/g, "").split("\n");
        var wrapped = [];
        var i;
        var raw;
        var words;
        var current;
        var w;
        if (width < 10)
            width = 10;
        for (i = 0; i < lines.length; i += 1) {
            raw = lines[i];
            if (!raw.length) {
                wrapped.push("");
                continue;
            }
            words = raw.split(/\s+/);
            current = "";
            for (w = 0; w < words.length; w += 1) {
                if (!current.length) {
                    current = words[w];
                    continue;
                }
                if ((current + " " + words[w]).length <= width) {
                    current += " " + words[w];
                }
                else {
                    wrapped.push(current);
                    current = words[w];
                }
            }
            if (current.length)
                wrapped.push(current);
        }
        return wrapped;
    }
    function printConsoleHeader(title) {
        var cleanTitle = toScreenText(title);
        console.writeln(cleanTitle);
        console.writeln(repeatChar("=", cleanTitle.length));
        console.writeln("");
    }
    function waitForAnyKey() {
        console.writeln("");
        console.write("Press any key to continue...");
        console.getkey(K_NONE);
    }
    function showPagedText(title, text) {
        var lines = wrapText(toScreenText(text), Math.max(30, console.screen_columns - 2));
        var pageSize = Math.max(10, console.screen_rows - 5);
        var index = 0;
        var key;
        while (bbs.online && !js.terminated) {
            console.clear();
            printConsoleHeader(title);
            var shown = lines.slice(index, index + pageSize);
            var i;
            for (i = 0; i < shown.length; i += 1) {
                console.writeln(shown[i]);
            }
            console.writeln("");
            if (index + pageSize >= lines.length) {
                console.write("[Q] Back");
            }
            else {
                console.write("[Space/Enter] Next  [Q] Back");
            }
            key = safeString(console.getkey(K_NONE)).toUpperCase();
            if (key === "Q" || key === "\u001b")
                return;
            if (index + pageSize >= lines.length)
                return;
            index += pageSize;
        }
    }
    function formatFullMetadata(track, parsed) {
        var lines = [];
        lines.push("Title: " + toScreenText(displayTrackTitle(track)));
        lines.push("Artist: " + toScreenText(trimValue(parsed.artist) || track.artist || "Unknown"));
        lines.push("Composer: " + toScreenText(trimValue(parsed.composer) || track.composer || "-"));
        lines.push("Genre: " + toScreenText(trimValue(parsed.genre) || track.genre || "-"));
        lines.push("Album: " + toScreenText(trimValue(parsed.album) || track.album || "-"));
        lines.push("Year: " + toScreenText(trimValue(parsed.year) || track.year || "-"));
        lines.push("Track #: " + toScreenText(trimValue(parsed.trackNumber) || track.trackNumber || "-"));
        lines.push("Duration (ms): " + toScreenText(trimValue(parsed.durationMs) || track.durationMs || "-"));
        lines.push("Filename: " + track.name);
        lines.push("Path: " + track.path);
        lines.push("Size: " + track.size + " bytes");
        lines.push("Modified: " + (track.mtime ? system.datestr(track.mtime) : "-"));
        lines.push("Added: " + (track.added ? system.datestr(track.added) : "-"));
        lines.push("Description: " + toScreenText(track.description || "-"));
        lines.push("Embedded ANSI art: " + (parsed.ansiArtBase64.length ? "Yes" : "No"));
        lines.push("Embedded lyrics: " + ((parsed.lyricsText.length || parsed.syncedLyrics.length) ? "Yes" : "No"));
        return lines.join("\n");
    }
    function loadSidecarLyrics(track) {
        var lrcPath = track.path.replace(/\.mp3$/i, ".lrc");
        var file = new File(lrcPath);
        var raw;
        var lines = [];
        var i;
        var match;
        var content;
        if (!file_exists(lrcPath))
            return "";
        if (!file.open("r"))
            return "";
        try {
            raw = file.read();
        }
        finally {
            file.close();
        }
        raw = raw.replace(/\r/g, "");
        var parts = raw.split("\n");
        for (i = 0; i < parts.length; i += 1) {
            match = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/.exec(parts[i]);
            if (!match)
                continue;
            content = trimValue(parts[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, ""));
            if (content.length)
                lines.push(content);
        }
        return lines.join("\n");
    }
    function showTrackArt(track) {
        var parsed = parseTrackTags(track.path, {
            includeLyrics: false,
            includeAnsiArt: true
        });
        var art = parsed.ansiArtBase64.length ? base64_decode(parsed.ansiArtBase64) : "";
        console.clear();
        printConsoleHeader(displayTrackTitle(track) + " Artwork");
        if (!art.length) {
            console.writeln("No embedded ANSI artwork was found for this track.");
            waitForAnyKey();
            return;
        }
        console.write(art);
        console.writeln("");
        waitForAnyKey();
    }
    function showTrackLyrics(track) {
        var parsed = parseTrackTags(track.path, {
            includeLyrics: true,
            includeAnsiArt: false
        });
        var lyrics = trimValue(parsed.lyricsText || loadSidecarLyrics(track));
        if (!lyrics.length) {
            console.clear();
            printConsoleHeader(displayTrackTitle(track) + " Lyrics");
            console.writeln("No embedded or sidecar lyrics were found.");
            waitForAnyKey();
            return;
        }
        showPagedText(displayTrackTitle(track) + " Lyrics", lyrics);
    }
    function emitBrowserPlay(track) {
        var flweb = {};
        var relativeUrl = "/api/files.ssjs?call=stream-file&dir=" + encodeURIComponent(DIR_CODE) + "&file=" + encodeURIComponent(track.name);
        try {
            load(flweb, pathJoin(system.mods_dir, "load/flweb.js"));
            if (flweb && typeof flweb.openUrl === "function") {
                flweb.openUrl(relativeUrl, {
                    title: "Futureland Records",
                    text: "Opening " + displayTrackTitle(track),
                    target: "_blank"
                });
                return "Browser playback requested for:\n" + relativeUrl;
            }
            if (flweb && typeof flweb.toast === "function") {
                flweb.toast("Futureland Records", "Open " + relativeUrl + " in your browser.", {
                    duration: 9000,
                    hiddenOnly: false
                });
                return "FLWEB bridge is present but does not support direct URL launch yet.\n\nOpen this URL in the browser:\n" + relativeUrl;
            }
        }
        catch (err) {
            return "Browser bridge unavailable.\n\nOpen this URL in the browser:\n" + relativeUrl + "\n\n" + safeString(err);
        }
        return "Browser bridge unavailable.\n\nOpen this URL in the browser:\n" + relativeUrl;
    }
    function loadSidecarSyncedLyrics(track) {
        var out = [];
        var lrcPath = track.path.replace(/\.mp3$/i, ".lrc");
        if (!file_exists(lrcPath))
            return out;
        var file = new File(lrcPath);
        if (!file.open("r"))
            return out;
        var raw;
        try {
            raw = file.read();
        }
        finally {
            file.close();
        }
        raw = raw.replace(/\r/g, "");
        var parts = raw.split("\n");
        for (var i = 0; i < parts.length; i += 1) {
            // A line may carry several [mm:ss.xx] tags (repeated chorus).
            var text = trimValue(parts[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, ""));
            if (!text.length)
                continue;
            var rx = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
            var m;
            while ((m = rx.exec(parts[i])) !== null) {
                var frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
                out.push({ time: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: text });
            }
        }
        out.sort(function (a, b) {
            return a.time - b.time;
        });
        return out;
    }
    // AI co-writer avatars from the local-aidefinitions sub (same source the
    // web records page uses): base64 10x6 BIN between avatar_data markers in
    // each persona's thread-origin message body. Cached per session.
    var cowriterAvatarCache = null;
    function cowriterAvatars() {
        if (cowriterAvatarCache !== null)
            return cowriterAvatarCache;
        var map = {};
        var subCode = "local-aidefinitions";
        if (!msg_area.sub[subCode]) {
            cowriterAvatarCache = map;
            return map;
        }
        try {
            var msgBase = new MsgBase(subCode);
            if (msgBase.open()) {
                var headers = msgBase.get_all_msg_headers(true);
                var origins = {};
                for (var key in headers) {
                    if (!headers.hasOwnProperty(key))
                        continue;
                    var header = headers[key];
                    if (!header || (header.attr & MSG_DELETE))
                        continue;
                    if (!origins[safeString(header.thread_id)])
                        origins[safeString(header.thread_id)] = header;
                }
                for (var tid in origins) {
                    if (!origins.hasOwnProperty(tid))
                        continue;
                    var hdr = origins[tid];
                    var name = trimValue(safeString(hdr.subject).replace(/^re:\s*/i, ""));
                    if (!name.length)
                        continue;
                    try {
                        var body = safeString(msgBase.get_msg_body(hdr.number));
                        var m1 = body.indexOf("avatar_data_begin");
                        var m2 = body.indexOf("avatar_data_end");
                        if (m1 >= 0 && m2 > m1) {
                            var b64 = body.substring(m1 + 17, m2).replace(/[\r\n\s]/g, "");
                            if (b64.length)
                                map[lower(name)] = b64;
                        }
                    }
                    catch (ignored) { }
                }
                msgBase.close();
            }
        }
        catch (err) {
            log(LOG_WARNING, "fl_records cowriter avatar load failed: " + safeString(err));
        }
        cowriterAvatarCache = map;
        return map;
    }
    // Resolve up to two 10x6 avatar BIN blobs for a track: split the artist
    // on feat./separators, then try AI co-writers, then local BBS users.
    function trackAvatars(track) {
        var out = [];
        var names = [];
        var raw = trimValue(displayTrackArtist(track));
        var parts = raw.split(/\s+feat\.?\s+|\s+featuring\s+|\s*[,&+]\s*|\s+x\s+/i);
        for (var i = 0; i < parts.length; i++) {
            var n = trimValue(parts[i]);
            if (n.length)
                names.push(n);
        }
        var comp = trimValue(track.composer);
        if (comp.length)
            names.push(comp);
        var seen = {};
        var aiMap = cowriterAvatars();
        var avatarLib = null;
        for (var j = 0; j < names.length && out.length < 4; j++) {
            var keyName = lower(names[j]);
            if (seen[keyName])
                continue;
            seen[keyName] = true;
            var data = "";
            if (aiMap[keyName]) {
                data = aiMap[keyName];
            }
            else {
                try {
                    var un = system.matchuser(names[j]);
                    if (un > 0) {
                        if (avatarLib === null)
                            avatarLib = load({}, "avatar_lib.js");
                        var obj = avatarLib.read_localuser(un);
                        if (obj && obj.data && !obj.disabled)
                            data = safeString(obj.data);
                    }
                }
                catch (ignored2) { }
            }
            if (data.length) {
                var bin = base64_decode(data.replace(/[\r\n\s]/g, ""));
                if (bin.length >= 120)
                    out.push(bin);
            }
        }
        return out;
    }
    function playInTerminal(track, list, index, playlistName) {
        withConsoleScreen(function () {
            console.clear();
            printConsoleHeader("Play In Terminal");
            console.writeln("Probing terminal audio support...");
            var sink = FLPlayer.detectSink();
            if (sink === "none") {
                console.writeln("");
                console.writeln("No terminal audio sink detected.");
                console.writeln("");
                console.writeln("Terminal playback works in SyncTERM (a current build with");
                console.writeln("APC audio) or through the BBSproxy shim. You can still use");
                console.writeln("[P] Play In Browser from the song menu.");
                waitForAnyKey();
                return;
            }
            console.writeln("Audio sink: " + (sink === "syncterm" ? "SyncTERM (libsndfile)" : "APC bridge"));
            var curList = (list && list.length) ? list : [track];
            var idx = typeof index === "number" ? Math.max(0, Math.min(index, curList.length - 1)) : 0;
            var currentPlaylist = playlistName || ""; // set when the queue is a playlist (enables [R]emove)
            var history = []; // played indices, oldest-first: P returns to the REAL previous track
            var bag = []; // shuffle deck: every queue track plays once before any repeats
            seedBag(bag, curList.length, idx); // first cycle excludes the track already playing
            while (bbs.online && !js.terminated) {
                var cur = curList[idx];
                // Immediate feedback for the inter-track gap (tag parse +
                // possible transcode): a visible loading banner, so nobody
                // double-presses N thinking the first one was ignored.
                console.clear();
                console.writeln("");
                console.writeln("  Loading: " + toScreenText(displayTrackTitle(cur)));
                console.writeln("");
                var parsed = parseTrackTags(cur.path, {
                    includeLyrics: true,
                    includeAnsiArt: true
                });
                // Timed lyrics: embedded SYLT first, then a timestamped .lrc
                // sidecar; untimed text distributes evenly over the duration.
                var timed = [];
                if (parsed.syncedLyrics && parsed.syncedLyrics.length) {
                    for (var si = 0; si < parsed.syncedLyrics.length; si++) {
                        timed.push({
                            time: parsed.syncedLyrics[si].time,
                            text: toScreenText(parsed.syncedLyrics[si].text)
                        });
                    }
                }
                else {
                    timed = loadSidecarSyncedLyrics(cur);
                }
                var flat = timed.length ? "" :
                    toScreenText(trimValue(parsed.lyricsText || loadSidecarLyrics(cur)));
                var playable = {
                    path: cur.path,
                    name: cur.name,
                    size: cur.size,
                    mtime: cur.mtime,
                    title: toScreenText(displayTrackTitle(cur)),
                    artist: toScreenText(displayTrackArtist(cur)),
                    ansiArt: parsed.ansiArtBase64.length ? base64_decode(parsed.ansiArtBase64) : "",
                    lyrics: timed,
                    flatLyrics: flat,
                    avatars: trackAvatars(cur)
                };
                var outcome = FLPlayer.playTrack(playable);
                // Honor whatever was pressed while the player was tearing
                // down / the next track was loading: Q still quits, and
                // buffered N/P adjust how far we move — no more sailing past
                // the track you wanted.
                var buffered = FLPlayer.pumpShared(80);
                FLPlayer.dbg("transition: outcome=" + outcome + " idx=" + idx +
                    (buffered.keys.length ? " buffered=" + buffered.keys.join("") : "") +
                    (buffered.esc ? " bufferedESC" : ""));
                var extra = 0;
                var quitBuffered = buffered.esc;
                for (var bi = 0; bi < buffered.keys.length; bi++) {
                    if (buffered.keys[bi] === "Q")
                        quitBuffered = true;
                    else if (buffered.keys[bi] === "N")
                        extra++;
                    else if (buffered.keys[bi] === "P")
                        extra--;
                }
                if (quitBuffered)
                    return;
                if (outcome === "browse") {
                    // Typeahead browser: picking sets a new play queue (the
                    // filtered results, or a whole playlist via the Manager);
                    // cancelling replays the current track.
                    var pick = browseSongs(activeApp);
                    if (pick && pick.list.length) {
                        curList = pick.list;
                        idx = Math.max(0, Math.min(pick.index, curList.length - 1));
                        currentPlaylist = pick.playlist || "";
                        if (pick.playlist)
                            FLPlayer.shuffle = false; // play a playlist in its arranged order
                        history = [];
                        seedBag(bag, curList.length, idx); // fresh queue -> fresh history/shuffle cycle
                    }
                    console.clear();
                    continue;
                }
                if (outcome === "addplaylist") {
                    addToPlaylistFlow(curList[idx].name, displayTrackTitle(curList[idx]));
                    console.clear();
                    continue;
                }
                if (outcome === "removeplaylist") {
                    if (currentPlaylist && curList.length) {
                        plRemoveTrack(currentPlaylist, curList[idx].name);
                        curList.splice(idx, 1); // drop from the live queue too
                        if (!curList.length)
                            return; // playlist emptied -> leave
                        if (idx >= curList.length)
                            idx = 0;
                        history = [];
                        seedBag(bag, curList.length, idx); // indices shifted -> reset nav state
                    }
                    else {
                        console.clear();
                        console.writeln("");
                        console.writeln("  Not playing from a playlist -- nothing to remove.");
                        mswait(1200);
                    }
                    console.clear();
                    continue;
                }
                if (outcome === "create") {
                    // Compose is a uifc flow, and the shim reads via
                    // console.getkey which (unlike the pump) does NOT swallow
                    // APC replies. The player's exit flush fades ~250ms then
                    // emits a drain notify whose ESC would dismiss the menu the
                    // instant it opens -- so drain past it here before uifc.
                    console.clear();
                    console.writeln("");
                    console.writeln("  Opening composer...");
                    FLPlayer.pumpShared(450);
                    initUi();
                    composeMenu(activeApp);
                    safeBailUi();
                    console.clear();
                    continue;
                }
                // Radio flow: the station never stops. Shuffle uses a no-repeat
                // "bag" -- every track in the queue plays once before any repeats
                // (reshuffle at cycle end). `history` records the REAL play order
                // so P returns to the actual previous track, not idx-1. N/P
                // (and buffered presses via `extra`) step through this.
                if (outcome === "next" || outcome === "ended" || outcome === "prev") {
                    var moves = (outcome === "prev" ? -1 : 1) + extra;
                    if (moves === 0)
                        moves = (outcome === "prev" ? -1 : 1);
                    var goBack = moves < 0;
                    var steps = Math.abs(moves);
                    for (var mv = 0; mv < steps; mv += 1) {
                        if (goBack) {
                            if (history.length)
                                idx = history.pop();
                            else if (!FLPlayer.shuffle)
                                idx = (idx - 1 + curList.length) % curList.length;
                            // shuffle with no history yet: stay on the current track
                        }
                        else {
                            history.push(idx);
                            if (history.length > 500)
                                history.shift();
                            if (FLPlayer.shuffle && curList.length > 1) {
                                idx = shuffleNext(curList.length, idx, bag);
                            }
                            else {
                                idx = (idx + 1) % curList.length;
                            }
                        }
                    }
                    FLPlayer.dbg("nav -> idx=" + idx + (FLPlayer.shuffle ? " (shuffle bag=" + bag.length + ")" : ""));
                    continue;
                }
                return;
            }
        });
    }
    function showTrackDetail(track, list, index) {
        withConsoleScreen(function () {
            var key;
            var parsed;
            while (bbs.online && !js.terminated) {
                console.clear();
                printConsoleHeader(displayTrackTitle(track));
                console.writeln("Artist:      " + toScreenText(displayTrackArtist(track)));
                console.writeln("Composer:    " + toScreenText(trimValue(track.composer) || "-"));
                console.writeln("Genre:       " + toScreenText(trimValue(track.genre) || "-"));
                console.writeln("Album / Year:" + " " + toScreenText(trimValue(track.album) || "-") + " / " + toScreenText(trimValue(track.year) || "-"));
                console.writeln("Filename:    " + track.name);
                console.writeln("");
                console.writeln("[T] Play In Terminal");
                console.writeln("[A] Show Song Artwork");
                console.writeln("[L] Show Song Lyrics");
                console.writeln("[M] Show Full Metadata");
                console.writeln("[P] Play In Browser");
                console.writeln("[B] Back To Track List");
                console.writeln("");
                console.write("Selection: ");
                key = safeString(console.getkey(K_NONE)).toUpperCase();
                if (key === "T") {
                    playInTerminal(track, list, typeof index === "number" ? index : 0);
                }
                else if (key === "A") {
                    showTrackArt(track);
                }
                else if (key === "L") {
                    showTrackLyrics(track);
                }
                else if (key === "M") {
                    parsed = parseTrackTags(track.path, {
                        includeLyrics: true,
                        includeAnsiArt: true
                    });
                    showPagedText(displayTrackTitle(track) + " Metadata", formatFullMetadata(track, parsed));
                }
                else if (key === "P") {
                    showPagedText("Play In Browser", emitBrowserPlay(track));
                }
                else if (key === "B" || key === "Q" || key === "\u001b" || key === "\r") {
                    return;
                }
            }
        });
    }
    // --- playlist storage (per-user, JSONdb) -------------------------------
    // Playlists live BBS-side (this box is authoritative; the web can consume
    // data/playlists.json later). Per-user map: { [userKey]: { [name]:
    // {name, tracks:[filename], created} } }. Follows future_shell's shell_prefs
    // JSONdb pattern (new JSONdb -> load() -> masterData.data[key] -> save()).
    var PLAYLIST_SCOPE = "FLRECORDS_PLAYLISTS";
    function playlistDbPath() {
        return pathJoin(dataDirPath(), "playlists.json");
    }
    function playlistUserKey() {
        var raw = safeString(user && user.alias ? user.alias : ("user" + (user ? user.number : 0)));
        var k = raw.replace(/[^A-Za-z0-9_\-\.]/g, "_");
        return k.length ? k : "default";
    }
    function openPlaylistDb() {
        if (typeof JSONdb !== "function")
            return null;
        ensureDataDir();
        var db;
        try {
            db = new JSONdb(playlistDbPath(), PLAYLIST_SCOPE);
        }
        catch (_) {
            return null;
        }
        if (db && db.settings)
            db.settings.KEEP_READABLE = true;
        try {
            db.load();
        }
        catch (_e) { }
        if (!db.masterData || typeof db.masterData !== "object")
            db.masterData = { data: {} };
        if (!db.masterData.data || typeof db.masterData.data !== "object")
            db.masterData.data = {};
        return db;
    }
    // Read the current user's playlists (fresh from disk), sorted by name.
    function loadPlaylists() {
        var db = openPlaylistDb();
        if (!db)
            return [];
        var raw = db.masterData.data[playlistUserKey()];
        var out = [];
        if (raw && typeof raw === "object") {
            for (var name in raw) {
                if (!raw.hasOwnProperty(name))
                    continue;
                var p = raw[name];
                if (p && p.tracks && typeof p.tracks.length === "number")
                    out.push({ name: safeString(p.name || name), tracks: p.tracks.slice(), created: p.created || 0 });
            }
        }
        out.sort(function (a, b) {
            return lower(a.name) < lower(b.name) ? -1 : (lower(a.name) > lower(b.name) ? 1 : 0);
        });
        return out;
    }
    // Load -> mutate -> save the user's playlists atomically on one db handle.
    function mutatePlaylists(fn) {
        var db = openPlaylistDb();
        if (!db)
            return false;
        var key = playlistUserKey();
        var raw = db.masterData.data[key];
        var list = [];
        if (raw && typeof raw === "object") {
            for (var name in raw) {
                if (!raw.hasOwnProperty(name))
                    continue;
                var p = raw[name];
                if (p)
                    list.push({ name: safeString(p.name || name), tracks: (p.tracks || []).slice(), created: p.created || 0 });
            }
        }
        fn(list);
        var map = {};
        for (var i = 0; i < list.length; i += 1)
            map[list[i].name] = { name: list[i].name, tracks: list[i].tracks, created: list[i].created };
        db.masterData.data[key] = map;
        try {
            db.save();
            return true;
        }
        catch (_) {
            return false;
        }
    }
    function findPlaylist(list, name) {
        for (var i = 0; i < list.length; i += 1)
            if (lower(list[i].name) === lower(name))
                return list[i];
        return null;
    }
    function plNow() {
        return typeof time === "function" ? time() : 0;
    }
    // Create a playlist (optionally seeded with a track). Returns false if the
    // name is taken or blank.
    function plCreate(name, seedTrack) {
        var clean = trimValue(name);
        if (!clean.length)
            return false;
        return mutatePlaylists(function (list) {
            if (findPlaylist(list, clean))
                return;
            list.push({ name: clean, tracks: seedTrack ? [seedTrack] : [], created: plNow() });
        });
    }
    function plAddTrack(name, trackName) {
        return mutatePlaylists(function (list) {
            var pl = findPlaylist(list, name);
            if (!pl) {
                pl = { name: trimValue(name), tracks: [], created: plNow() };
                list.push(pl);
            }
            for (var i = 0; i < pl.tracks.length; i += 1)
                if (pl.tracks[i] === trackName)
                    return; // dedupe
            pl.tracks.push(trackName);
        });
    }
    function plRemoveTrack(name, trackName) {
        return mutatePlaylists(function (list) {
            var pl = findPlaylist(list, name);
            if (!pl)
                return;
            var kept = [];
            for (var i = 0; i < pl.tracks.length; i += 1)
                if (pl.tracks[i] !== trackName)
                    kept.push(pl.tracks[i]);
            pl.tracks = kept;
        });
    }
    function plDelete(name) {
        return mutatePlaylists(function (list) {
            for (var i = list.length - 1; i >= 0; i -= 1)
                if (lower(list[i].name) === lower(name))
                    list.splice(i, 1);
        });
    }
    function plRename(oldName, newName) {
        var clean = trimValue(newName);
        if (!clean.length)
            return false;
        return mutatePlaylists(function (list) {
            if (findPlaylist(list, clean) && lower(clean) !== lower(oldName))
                return; // name taken
            var pl = findPlaylist(list, oldName);
            if (pl)
                pl.name = clean;
        });
    }
    function plSetOrder(name, tracks) {
        return mutatePlaylists(function (list) {
            var pl = findPlaylist(list, name);
            if (pl)
                pl.tracks = tracks.slice();
        });
    }
    // --- console drawing helpers for the typeahead browser -----------------
    function csiAt(y, x) { return "\x1b[" + y + ";" + x + "H"; }
    function csiSgr(codes) { return "\x1b[" + codes + "m"; }
    var CSI_RESET = "\x1b[0m";
    function padClip(text, width) {
        if (width <= 0)
            return "";
        if (text.length >= width)
            return text.substring(0, width);
        return padRight(text, width);
    }
    // --- playlist UI flows -------------------------------------------------
    // Bring uifc up for a menu flow from a console-mode context (browse/player),
    // draining any APC reply tail first (the shim's getkey doesn't swallow it,
    // so a stray drain-notify would dismiss the menu). Restores prior UI state.
    function runUifcFlow(fn) {
        // 450ms: enough to swallow the player's exit-flush fade (O=250) + its
        // drain notify, whose ESC would otherwise dismiss the shim menu (the
        // uifc shim's getkey, unlike the pump, doesn't filter APC replies).
        FLPlayer.pumpShared(450);
        var hadUi = uiReady;
        if (!hadUi)
            initUi();
        try {
            fn();
        }
        finally {
            if (!hadUi)
                safeBailUi();
        }
    }
    function trackTitleForName(fname) {
        var cat = activeApp ? activeApp.catalog : [];
        for (var i = 0; i < cat.length; i += 1)
            if (cat[i].name === fname)
                return toScreenText(displayTrackTitle(cat[i]));
        return fname;
    }
    // Resolve a playlist's filenames to catalog tracks (skipping any missing).
    function playlistToTracks(pl) {
        var out = [];
        var cat = activeApp ? activeApp.catalog : [];
        for (var i = 0; i < pl.tracks.length; i += 1) {
            for (var j = 0; j < cat.length; j += 1) {
                if (cat[j].name === pl.tracks[i]) {
                    out.push(cat[j]);
                    break;
                }
            }
        }
        return out;
    }
    function playlistContains(pl, trackName) {
        for (var i = 0; i < pl.tracks.length; i += 1)
            if (pl.tracks[i] === trackName)
                return true;
        return false;
    }
    // Add one track to a playlist: pick an existing one or create a new one.
    // Intelligent: playlists that already hold the song are marked, and adding
    // again is a no-op with an "Already in" message (never a duplicate).
    function addToPlaylistFlow(trackName, trackTitle) {
        runUifcFlow(function () {
            var pls = loadPlaylists();
            var options = ["Back", "[+ Create New Playlist]"];
            for (var i = 0; i < pls.length; i += 1)
                options.push(pls[i].name + "   (" + pls[i].tracks.length + ")" +
                    (playlistContains(pls[i], trackName) ? "  - added" : ""));
            uifc.help_text = "Add \"" + toScreenText(trackTitle) + "\" to a playlist. '- added' marks playlists it's already in. Choose one, create a new playlist, or Back/Backspace/Esc to close.";
            var choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Add to Playlist", options, new uifc.list.CTX());
            if (choice <= 0)
                return; // Back (0) or Esc (<0)
            if (choice === 1) {
                var name = promptInput("New playlist name", "", 60, K_EDIT);
                if (name === null || !trimValue(name).length)
                    return;
                var existing = findPlaylist(loadPlaylists(), trimValue(name));
                if (existing && playlistContains(existing, trackName)) {
                    uifc.msg("Already in \"" + existing.name + "\".");
                    return;
                }
                plAddTrack(trimValue(name), trackName); // creates if new, dedupes
                uifc.msg("Added to \"" + trimValue(name) + "\".");
                return;
            }
            var target = pls[choice - 2];
            if (playlistContains(target, trackName)) {
                uifc.msg("Already in \"" + target.name + "\".");
                return;
            }
            plAddTrack(target.name, trackName);
            uifc.msg("Added to \"" + target.name + "\".");
        });
    }
    // Drag-to-reorder a playlist's songs (console-drawn). Enter grabs the
    // highlighted song, Up/Down move it, Enter drops; Esc saves and exits.
    function reorderPlaylistUi(name) {
        var hadUi = uiReady;
        if (hadUi)
            safeBailUi();
        try {
            var pl = findPlaylist(loadPlaylists(), name);
            if (!pl)
                return;
            var tracks = pl.tracks.slice();
            var sel = 0, grabbed = -1, top = 0;
            var full = true, dirty = true;
            while (bbs.online && !js.terminated) {
                var cols = Math.max(40, console.screen_columns || 80);
                var rows = Math.max(10, console.screen_rows || 24);
                var listTop = 4;
                var listH = Math.max(1, rows - listTop - 1);
                if (sel < top)
                    top = sel;
                if (sel >= top + listH)
                    top = sel - listH + 1;
                if (top < 0)
                    top = 0;
                if (full) {
                    console.write("\x1b[?25l\x1b[2J");
                    full = false;
                    dirty = true;
                }
                if (dirty) {
                    console.write(csiAt(1, 1) + csiSgr("0;1;36") + padClip(" REORDER: " + name, cols) + CSI_RESET);
                    console.write(csiAt(2, 1) + csiSgr("0;30;46") +
                        padClip("  ENTER grab/drop    UP/DN move    ESC save & back  ", cols) + CSI_RESET);
                    for (var r = 0; r < listH; r += 1) {
                        var idx = top + r, y = listTop + r;
                        var w = (y >= rows) ? cols - 1 : cols;
                        var txt = idx < tracks.length ? (idx === grabbed ? " <> " : "    ") +
                            trackTitleForName(tracks[idx]) : "";
                        var on = idx === sel;
                        var sgrc = idx === grabbed ? "0;1;33;44" : (on ? "0;37;44" : "0;37");
                        console.write(csiAt(y, 1) + csiSgr(sgrc) + padClip(txt, w) + CSI_RESET);
                    }
                    dirty = false;
                }
                var k = FLPlayer.readKey(120);
                if (!k.length)
                    continue;
                dirty = true;
                if (k === "\x1b")
                    break; // Esc: save & exit
                if (k === "\r") {
                    grabbed = (grabbed === sel) ? -1 : sel;
                    continue;
                } // grab/drop
                var dir = (k === "\x1e") ? -1 : (k === "\x0a") ? 1 : 0; // up / down
                if (!dir)
                    continue;
                if (grabbed >= 0) {
                    var ni = grabbed + dir;
                    if (ni >= 0 && ni < tracks.length) {
                        var tmp = tracks[grabbed];
                        tracks[grabbed] = tracks[ni];
                        tracks[ni] = tmp;
                        grabbed = ni;
                        sel = ni;
                    }
                }
                else {
                    sel = Math.max(0, Math.min(tracks.length - 1, sel + dir));
                }
            }
            console.write("\x1b[?25h" + CSI_RESET);
            plSetOrder(name, tracks);
        }
        finally {
            if (hadUi)
                initUi();
        }
    }
    // Playlist Manager: list playlists, then Play / Rename / Reorder / Delete.
    // Returns a queue to play (from "Play"), or null.
    function playlistManager() {
        var toPlay = null;
        runUifcFlow(function () {
            var mgrCtx = new uifc.list.CTX();
            while (bbs.online && !js.terminated) {
                var pls = loadPlaylists();
                var options = ["Back"];
                for (var i = 0; i < pls.length; i += 1)
                    options.push(pls[i].name + "   (" + pls[i].tracks.length + " tracks)");
                if (!pls.length)
                    options.push("(no playlists yet - add songs from Browse or the player)");
                uifc.help_text = "Your playlists. Select one to Play / Rename / Reorder / Delete. Add songs with ENTER in Browse or [A] in the player. Backspace/Esc go back.";
                var choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Playlist Manager", options, mgrCtx);
                if (choice <= 0)
                    return; // Back (0) or Esc (<0)
                if (!pls.length)
                    continue; // the "(no playlists)" row
                var pl = pls[choice - 1];
                var action = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, pl.name + " (" + pl.tracks.length + ")", ["Back", "Play", "Rename", "Reorder songs", "Delete"], new uifc.list.CTX());
                if (action <= 0) {
                    continue; // Back (0) or Esc -> playlist list
                }
                else if (action === 1) {
                    var built = playlistToTracks(pl);
                    if (!built.length) {
                        uifc.msg("That playlist has no playable songs.");
                        continue;
                    }
                    toPlay = { list: built, index: 0, playlist: pl.name };
                    return;
                }
                else if (action === 2) {
                    var nn = promptInput("Rename playlist", pl.name, 60, K_EDIT);
                    if (nn !== null && trimValue(nn).length)
                        plRename(pl.name, trimValue(nn));
                }
                else if (action === 3) {
                    reorderPlaylistUi(pl.name);
                }
                else if (action === 4) {
                    if (uifc.list(WIN_MID | WIN_SAV, "Delete \"" + pl.name + "\"?", ["No", "Yes"]) === 1)
                        plDelete(pl.name);
                }
            }
        });
        return toPlay;
    }
    // Typeahead song browser. Live-filters the catalog as you type; ALL printable
    // keys feed the search (so commands must be non-letters: Enter plays, Tab
    // shows details, Backspace deletes, Esc clears then backs out). Returns the
    // filtered list + chosen index (which becomes the new play queue) or null.
    // Console-drawn; input flows through the shared pump — never a raw inkey
    // read, which would bisect in-flight sequences (see the input lesson).
    function browseSongs(app) {
        var result = null;
        withConsoleScreen(function () {
            var search = "";
            var sel = 0;
            var top = 0;
            var lastCols = 0;
            var lastRows = 0;
            var filtered = [];
            var full = true;
            var dirty = true;
            var done = false;
            function recompute() {
                filtered = [];
                for (var i = 0; i < app.catalog.length; i += 1) {
                    if (!search.length || trackSearchHaystack(app.catalog[i]).indexOf(search) >= 0)
                        filtered.push(app.catalog[i]);
                }
                if (sel >= filtered.length)
                    sel = filtered.length - 1;
                if (sel < 0)
                    sel = 0;
                top = 0;
            }
            recompute();
            while (!done && bbs.online && !js.terminated) {
                var cols = Math.max(40, console.screen_columns || 80);
                var rows = Math.max(10, console.screen_rows || 24);
                if (cols !== lastCols || rows !== lastRows) {
                    full = true;
                    lastCols = cols;
                    lastRows = rows;
                }
                var listTop = 4;
                var listH = Math.max(1, rows - listTop);
                if (sel < top)
                    top = sel;
                if (sel >= top + listH)
                    top = sel - listH + 1;
                if (top < 0)
                    top = 0;
                if (full) {
                    console.write("\x1b[?25l\x1b[2J");
                    full = false;
                    dirty = true;
                }
                if (dirty) {
                    console.write(csiAt(1, 1) + csiSgr("0;1;36") +
                        padClip(" FUTURELAND RECORDS  --  Browse", cols) + CSI_RESET);
                    var count = " " + filtered.length + "/" + app.catalog.length + " ";
                    console.write(csiAt(2, 1) + csiSgr("0;1;37") +
                        padClip(" Search: " + search + "_", Math.max(0, cols - count.length)) +
                        csiSgr("0;1;36") + count + CSI_RESET);
                    console.write(csiAt(3, 1) + csiSgr("0;30;46") +
                        padClip("  SPACE play   ENTER +playlist   TAB manager   BKSP clear   ESC back  ", cols) + CSI_RESET);
                    for (var r = 0; r < listH; r += 1) {
                        var idx = top + r;
                        var y = listTop + r;
                        var w = (y >= rows) ? cols - 1 : cols; // never write the bottom-right cell
                        var txt = idx < filtered.length ? trackRow(filtered[idx]) :
                            (idx === 0 && !filtered.length ? "  (no matches - Backspace to widen)" : "");
                        var on = idx === sel && filtered.length > 0;
                        console.write(csiAt(y, 1) + csiSgr(on ? "0;37;44" : "0;37") + padClip(txt, w) + CSI_RESET);
                    }
                    dirty = false;
                }
                // One normalized key per read (arrows come back as cursor codes).
                var k = FLPlayer.readKey(120);
                if (k.length) {
                    dirty = true;
                    if (k === "\x1b") { // Esc: clear the search, else back out
                        if (search.length) {
                            search = "";
                            sel = 0;
                            recompute();
                        }
                        else
                            done = true;
                    }
                    else if (k === " ") { // SPACE plays the highlighted song
                        if (filtered.length) {
                            result = { list: filtered, index: sel };
                            done = true;
                        }
                    }
                    else if (k === "\r") { // ENTER adds it to a playlist
                        if (filtered.length) {
                            addToPlaylistFlow(filtered[sel].name, displayTrackTitle(filtered[sel]));
                            full = true;
                        }
                    }
                    else if (k === "\t") { // TAB opens the Playlist Manager
                        var pm = playlistManager();
                        if (pm) {
                            result = { list: pm.list, index: pm.index, playlist: pm.playlist };
                            done = true;
                        }
                        else
                            full = true;
                    }
                    else if (k === "\x08" || k === "\x7f") { // Backspace deletes a search char
                        if (search.length) {
                            search = search.substring(0, search.length - 1);
                            sel = 0;
                            recompute();
                        }
                    }
                    else if (k === "\x1e") { // up
                        sel = sel > 0 ? sel - 1 : Math.max(0, filtered.length - 1);
                    }
                    else if (k === "\x0a") { // down
                        sel = filtered.length ? (sel + 1) % filtered.length : 0;
                    }
                    else if (k === "\x10" || k === "\x1d") { // page up / left
                        sel = Math.max(0, sel - listH);
                    }
                    else if (k === "\x0e" || k === "\x06") { // page down / right
                        sel = Math.min(Math.max(0, filtered.length - 1), sel + listH);
                    }
                    else if (k === "\x02") { // home
                        sel = 0;
                    }
                    else if (k === "\x05") { // end
                        sel = Math.max(0, filtered.length - 1);
                    }
                    else if (k.length === 1 && k > " " && k <= "~") { // printable -> search (space is play)
                        search += k.toLowerCase();
                        sel = 0;
                        recompute();
                    }
                }
            }
            console.write("\x1b[?25h" + CSI_RESET);
        });
        return result;
    }
    function browseTracks(app) {
        var options;
        var filtered;
        var selection;
        while (bbs.online && !js.terminated) {
            filtered = getFilteredTracks(app);
            options = [
                "[Filters] " + truncateText(filterSummary(app.filters), 72),
                "[Refresh Catalog Cache]"
            ];
            if (!filtered.length) {
                options.push("No tracks match the current filters.");
            }
            else {
                options = options.concat(filtered.map(trackRow));
            }
            uifc.help_text = "Enter plays the song in the terminal.  T opens its details.  First row edits filters.";
            app.trackListCtx.actionKeys = { "T": UI_ACTION_DETAIL };
            selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "All Songs  (" + filtered.length + " of " + app.catalog.length + " tracks)", options, app.trackListCtx);
            if (selection === UI_ACTION_DETAIL) {
                var drow = app.trackListCtx.cur;
                if (filtered.length && drow >= 2 && drow - 2 < filtered.length)
                    showTrackDetail(filtered[drow - 2], filtered, drow - 2);
                continue;
            }
            if (selection < 0)
                return;
            if (selection === 0) {
                editTrackFilters(app);
                continue;
            }
            if (selection === 1) {
                app.catalog = loadCatalog(true);
                continue;
            }
            if (!filtered.length)
                continue;
            // Enter drops straight into the in-terminal player/visualizer; the
            // detail view is one T away for full metadata/art/lyrics.
            playInTerminal(filtered[selection - 2], filtered, selection - 2);
        }
    }
    function choosePresetValue(title, current, options, blankLabel) {
        var items = [blankLabel, "Custom..."].concat(options.map(function (entry) {
            return toScreenText(entry);
        }));
        var ctx = new uifc.list.CTX();
        var selection;
        selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, ctx);
        if (selection < 0)
            return current;
        if (selection === 0)
            return "";
        if (selection === 1) {
            var custom = promptInput(title + " (Custom)", current, 120, K_EDIT);
            return custom === null ? current : trimValue(custom);
        }
        return options[selection - 2];
    }
    function chooseLabelValue(title, current, options, blankLabel) {
        var items = [blankLabel].concat(options.map(function (entry) {
            return toScreenText(entry.label);
        }));
        var selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, title, items, new uifc.list.CTX());
        if (selection < 0)
            return current;
        if (selection === 0)
            return "";
        return options[selection - 1].value;
    }
    function pickRandom(items) {
        if (!items.length)
            return "";
        return items[Math.floor(Math.random() * items.length)];
    }
    function randomizeStyle(state) {
        state.genre = pickRandom(FLRecordsData.presetOptions.genre);
        state.feel = pickRandom(FLRecordsData.presetOptions.feel);
        state.tone = pickRandom(FLRecordsData.presetOptions.tone);
        state.arrangement = pickRandom(FLRecordsData.presetOptions.arrangement);
        state.instrumentation = pickRandom(FLRecordsData.presetOptions.instrumentation);
        state.groove = pickRandom(FLRecordsData.presetOptions.groove);
        state.band = pickRandom(FLRecordsData.presetOptions.band);
        state.leadvocal = pickRandom(FLRecordsData.presetOptions.leadvocal);
        state.backingvocal = pickRandom(FLRecordsData.presetOptions.backingvocal);
    }
    function editBlockText(title, current) {
        var saved = current;
        var lines = [];
        var input;
        withConsoleScreen(function () {
            console.clear();
            printConsoleHeader(title);
            if (trimValue(saved).length) {
                console.writeln("Current text:");
                console.writeln(repeatChar("-", 12));
                console.writeln(toScreenText(saved));
                console.writeln("");
            }
            else {
                console.writeln("Current text is empty.");
                console.writeln("");
            }
            console.writeln("Enter replacement lines one at a time.");
            console.writeln("Use /done to save, /cancel to keep the current text.");
            console.writeln("");
            while (bbs.online && !js.terminated) {
                console.write(format("%02d> ", lines.length + 1));
                input = safeString(console.getstr(240, K_EDIT));
                if (trimValue(input).toUpperCase() === "/CANCEL") {
                    lines = [];
                    break;
                }
                if (trimValue(input).toUpperCase() === "/DONE") {
                    break;
                }
                lines.push(input);
                if (lines.length >= 64)
                    break;
            }
            if (lines.length)
                saved = lines.join("\n");
        });
        return saved;
    }
    function buildStylePrompt(state) {
        var phrases = [];
        var prefix = state.genre.length ? (state.genre + ": ") : "";
        if (trimValue(state.brief).length)
            phrases.push(sentence(state.brief));
        if (trimValue(state.feel).length || trimValue(state.tone).length) {
            phrases.push(sentence("Mood and feel: " + [state.feel, state.tone].filter(Boolean).join(", ")));
        }
        if (trimValue(state.instrumentation).length)
            phrases.push(sentence("Built around " + state.instrumentation));
        if (trimValue(state.groove).length)
            phrases.push(sentence("Groove: " + state.groove));
        if (trimValue(state.band).length)
            phrases.push(sentence("Players: " + state.band));
        if (trimValue(state.leadvocal).length)
            phrases.push(sentence("Lead singer type: " + state.leadvocal));
        if (trimValue(state.backingvocal).length)
            phrases.push(sentence("Background singer type: " + state.backingvocal));
        if (trimValue(state.arrangement).length)
            phrases.push(sentence("Arrangement: " + state.arrangement));
        if (trimValue(state.notes).length)
            phrases.push(sentence("Extra direction: " + state.notes));
        if (!phrases.length)
            return state.genre;
        return prefix + phrases.join(" ");
    }
    function buildGuidedLyrics(state) {
        var blocks = [];
        var i;
        var section;
        var sectionState;
        var heading;
        for (i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
            section = FLRecordsData.sectionDefs[i];
            sectionState = state.sections[section.key];
            if (!sectionState)
                continue;
            if (!trimValue(sectionState.notes).length && !trimValue(sectionState.text).length)
                continue;
            heading = "[" + section.label;
            if (trimValue(sectionState.notes).length)
                heading += " - " + trimValue(sectionState.notes);
            heading += "]";
            blocks.push(heading);
            if (trimValue(sectionState.text).length)
                blocks.push(trimValue(sectionState.text));
            blocks.push("");
        }
        while (blocks.length && !trimValue(blocks[blocks.length - 1]).length)
            blocks.pop();
        return blocks.join("\n");
    }
    function buildLyricsPrompt(state) {
        if (state.lyricMode === "guided")
            return buildGuidedLyrics(state);
        return trimValue(state.lyricsFreeform);
    }
    function getTempoLabel(state) {
        if (state.bpmMode === "custom_numeric")
            return trimValue(state.bpmValue).length ? (trimValue(state.bpmValue) + " BPM") : "";
        if (state.bpmMode === "slow_genre")
            return "Slow for the chosen genre";
        if (state.bpmMode === "mid_genre")
            return "Midtempo for the chosen genre";
        if (state.bpmMode === "fast_genre")
            return "Fast for the chosen genre";
        if (state.bpmMode === "half_time")
            return "Half-time feel";
        if (state.bpmMode === "double_time")
            return "Double-time feel";
        if (state.bpmMode === "rubato")
            return "Rubato / free tempo";
        if (state.bpmMode === "accelerando")
            return "Gradual accelerando";
        if (state.bpmMode === "genre_default")
            return "Match the genre default";
        return "";
    }
    function buildPreview(state) {
        var lines = [];
        var stylePrompt = buildStylePrompt(state);
        var lyricsPrompt = buildLyricsPrompt(state);
        var explicitLines = [];
        var prefix = state.memoryActive ? "+++" : "++++";
        if (trimValue(state.cowriter).length)
            prefix += "^" + trimValue(state.cowriter);
        lines.push(prefix);
        lines.push("");
        if (trimValue(state.songTitle).length) {
            lines.push("Title: " + trimValue(state.songTitle));
            lines.push("");
        }
        if (stylePrompt.length) {
            lines.push("[Style Prompt]");
            lines.push(stylePrompt);
            lines.push("");
        }
        if (lyricsPrompt.length) {
            lines.push("[Lyrics Director]");
            lines.push(lyricsPrompt);
            lines.push("");
        }
        if (trimValue(state.language).length)
            explicitLines.push("Language: " + trimValue(state.language));
        if (getTempoLabel(state).length)
            explicitLines.push("BPM: " + getTempoLabel(state));
        if (trimValue(state.timesig).length)
            explicitLines.push("Time Signature: " + trimValue(state.timesig));
        if (trimValue(state.key).length)
            explicitLines.push("Key Signature: " + trimValue(state.key));
        if (trimValue(state.duration).length)
            explicitLines.push("Duration: " + trimValue(state.duration) + " seconds");
        if (explicitLines.length) {
            lines.push("[Musical Composition Director]");
            lines = lines.concat(explicitLines);
        }
        while (lines.length && !trimValue(lines[lines.length - 1]).length)
            lines.pop();
        if (!lines.length) {
            lines.push("Add a story seed, lyrics, notes, or randomize the style to build a minimal Vektrax prompt.");
        }
        return lines.join("\n");
    }
    function isPromptEmpty(state) {
        return !trimValue(state.songTitle).length &&
            !buildStylePrompt(state).length &&
            !buildLyricsPrompt(state).length &&
            !trimValue(state.language).length &&
            !getTempoLabel(state).length &&
            !trimValue(state.key).length &&
            !trimValue(state.timesig).length &&
            !trimValue(state.duration).length;
    }
    function loadCowriters() {
        var names = [];
        var seen = {};
        var subCode = "local-aidefinitions";
        var msgBase;
        var headers;
        var threadOrigins = {};
        var order = [];
        var key;
        var header;
        var subject;
        if (!msg_area.sub[subCode])
            return names;
        try {
            msgBase = new MsgBase(subCode);
            if (!msgBase.open())
                return names;
            headers = msgBase.get_all_msg_headers(true);
            for (key in headers) {
                if (!headers.hasOwnProperty(key))
                    continue;
                header = headers[key];
                if (!header)
                    continue;
                if (header.attr & MSG_DELETE)
                    continue;
                if (!threadOrigins[safeString(header.thread_id)]) {
                    threadOrigins[safeString(header.thread_id)] = header;
                    order.push(safeString(header.thread_id));
                }
            }
            for (var i = 0; i < order.length; i += 1) {
                header = threadOrigins[order[i]];
                subject = trimValue(safeString(header.subject).replace(/^re:\s*/i, ""));
                if (!subject.length || seen[lower(subject)])
                    continue;
                seen[lower(subject)] = true;
                names.push(subject);
            }
            msgBase.close();
        }
        catch (err) {
            log(LOG_WARNING, "fl_records cowriter load failed: " + safeString(err));
        }
        names.sort(function (a, b) {
            return lower(a) < lower(b) ? -1 : 1;
        });
        return names;
    }
    function editSongDna(state) {
        var options;
        var choice;
        var input;
        var vw = composeValueWidth();
        while (bbs.online && !js.terminated) {
            options = [
                "Song title          " + summarizeValue(state.songTitle, vw),
                "Brief               " + summarizeValue(state.brief, vw),
                "Genre               " + summarizeValue(state.genre, vw),
                "Feel                " + summarizeValue(state.feel, vw),
                "Tone                " + summarizeValue(state.tone, vw),
                "Arrangement         " + summarizeValue(state.arrangement, vw),
                "Extra notes         " + summarizeValue(state.notes, vw),
                "Back"
            ];
            uifc.help_text = "The song's core. Brief is a plain-language description (what it's about, language, mood); Genre/Feel/Tone/Arrangement pick from lists. Enter edits a field, Esc goes back.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Song DNA", options, new uifc.list.CTX());
            if (choice < 0 || choice === 7)
                return;
            if (choice === 0) {
                input = promptInput("Song title", state.songTitle, 120, K_EDIT);
                if (input !== null)
                    state.songTitle = trimValue(input);
            }
            else if (choice === 1) {
                input = promptInput("Brief", state.brief, 240, K_EDIT);
                if (input !== null)
                    state.brief = trimValue(input);
            }
            else if (choice === 2) {
                state.genre = choosePresetValue("Genre", state.genre, FLRecordsData.presetOptions.genre, "Unspecified");
            }
            else if (choice === 3) {
                state.feel = choosePresetValue("Feel", state.feel, FLRecordsData.presetOptions.feel, "Unspecified");
            }
            else if (choice === 4) {
                state.tone = choosePresetValue("Tone", state.tone, FLRecordsData.presetOptions.tone, "Unspecified");
            }
            else if (choice === 5) {
                state.arrangement = choosePresetValue("Arrangement", state.arrangement, FLRecordsData.presetOptions.arrangement, "Unspecified");
            }
            else if (choice === 6) {
                input = promptInput("Extra notes", state.notes, 240, K_EDIT);
                if (input !== null)
                    state.notes = trimValue(input);
            }
        }
    }
    function editGuidedSection(section, state) {
        var sectionState = state.sections[section.key];
        var choice;
        var input;
        while (bbs.online && !js.terminated) {
            uifc.help_text = "Guide one lyric section. Notes steer it (a line or two of intent); Section text is exact words to keep. Leave both blank to let the AI write it.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, section.label, [
                "Guidance notes      " + summarizeValue(sectionState.notes, composeValueWidth()),
                "Section text        " + summarizeValue(sectionState.text, composeValueWidth()),
                "Clear section",
                "Back"
            ], new uifc.list.CTX());
            if (choice < 0 || choice === 3)
                return;
            if (choice === 0) {
                input = promptInput(section.label + " notes", sectionState.notes, 120, K_EDIT);
                if (input !== null)
                    sectionState.notes = trimValue(input);
            }
            else if (choice === 1) {
                sectionState.text = editBlockText(section.label + " text", sectionState.text);
            }
            else if (choice === 2) {
                sectionState.notes = "";
                sectionState.text = "";
            }
        }
    }
    function editLyrics(state) {
        var options;
        var choice;
        var modeLabel;
        var section;
        var modeChoice;
        while (bbs.online && !js.terminated) {
            modeLabel = state.lyricMode === "guided" ? "Guided sections" : "Freeform";
            options = [
                "Mode                " + modeLabel
            ];
            if (state.lyricMode === "guided") {
                for (var i = 0; i < FLRecordsData.sectionDefs.length; i += 1) {
                    section = FLRecordsData.sectionDefs[i];
                    var summary = state.sections[section.key];
                    options.push(section.label + "          " + summarizeValue(summary.notes || summary.text, composeValueWidth()));
                }
                options.push("Clear all guided sections");
            }
            else {
                options.push("Edit freeform lyrics  " + summarizeValue(state.lyricsFreeform, composeValueWidth()));
                options.push("Clear freeform lyrics");
            }
            options.push("Back");
            uifc.help_text = "How the lyrics get written. Freeform = write/paste the whole lyric; Guided = fill sections (verse, chorus...) with intent or exact lines. Blank sections are AI-written.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Lyrics Director", options, new uifc.list.CTX());
            if (choice < 0 || choice === options.length - 1)
                return;
            if (choice === 0) {
                modeChoice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Lyric Mode", ["Freeform", "Guided sections"], new uifc.list.CTX());
                if (modeChoice === 1) {
                    state.lyricMode = "guided";
                }
                else if (modeChoice === 0) {
                    state.lyricMode = "freeform";
                }
            }
            else if (state.lyricMode === "guided") {
                if (choice <= FLRecordsData.sectionDefs.length) {
                    editGuidedSection(FLRecordsData.sectionDefs[choice - 1], state);
                }
                else {
                    for (var j = 0; j < FLRecordsData.sectionDefs.length; j += 1) {
                        state.sections[FLRecordsData.sectionDefs[j].key].notes = "";
                        state.sections[FLRecordsData.sectionDefs[j].key].text = "";
                    }
                }
            }
            else if (choice === 1) {
                state.lyricsFreeform = editBlockText("Freeform lyrics", state.lyricsFreeform);
            }
            else if (choice === 2) {
                state.lyricsFreeform = "";
            }
        }
    }
    function editMusicDirection(state) {
        var choice;
        var input;
        while (bbs.online && !js.terminated) {
            uifc.help_text = "The arrangement: instruments, groove, vocals, language, tempo, key, time signature and target length. All optional -- anything you leave blank the AI decides.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Music Direction", [
                "Instrumentation     " + summarizeValue(state.instrumentation, composeValueWidth()),
                "Groove              " + summarizeValue(state.groove, composeValueWidth()),
                "Band                " + summarizeValue(state.band, composeValueWidth()),
                "Lead vocal          " + summarizeValue(state.leadvocal, composeValueWidth()),
                "Backing vocals      " + summarizeValue(state.backingvocal, composeValueWidth()),
                "Language            " + summarizeValue(state.language, composeValueWidth()),
                "Tempo               " + summarizeValue(getTempoLabel(state), composeValueWidth()),
                "Key                 " + summarizeValue(state.key, composeValueWidth()),
                "Time signature      " + summarizeValue(state.timesig, composeValueWidth()),
                "Duration (seconds)  " + summarizeValue(state.duration, composeValueWidth()),
                "Back"
            ], new uifc.list.CTX());
            if (choice < 0 || choice === 10)
                return;
            if (choice === 0) {
                state.instrumentation = choosePresetValue("Instrumentation", state.instrumentation, FLRecordsData.presetOptions.instrumentation, "Unspecified");
            }
            else if (choice === 1) {
                state.groove = choosePresetValue("Groove", state.groove, FLRecordsData.presetOptions.groove, "Unspecified");
            }
            else if (choice === 2) {
                state.band = choosePresetValue("Band", state.band, FLRecordsData.presetOptions.band, "Unspecified");
            }
            else if (choice === 3) {
                state.leadvocal = choosePresetValue("Lead vocal", state.leadvocal, FLRecordsData.presetOptions.leadvocal, "Unspecified");
            }
            else if (choice === 4) {
                state.backingvocal = choosePresetValue("Backing vocals", state.backingvocal, FLRecordsData.presetOptions.backingvocal, "Unspecified");
            }
            else if (choice === 5) {
                state.language = choosePresetValue("Language", state.language, FLRecordsData.presetOptions.language, "Unspecified");
            }
            else if (choice === 6) {
                state.bpmMode = chooseLabelValue("Tempo mode", state.bpmMode, FLRecordsData.presetOptions.bpmMode, "Unspecified");
                if (state.bpmMode === "custom_numeric") {
                    input = promptInput("Custom BPM", state.bpmValue, 6, K_EDIT | K_NUMBER);
                    if (input !== null)
                        state.bpmValue = trimValue(input);
                }
            }
            else if (choice === 7) {
                state.key = choosePresetValue("Key", state.key, FLRecordsData.presetOptions.key, "Unspecified");
            }
            else if (choice === 8) {
                state.timesig = choosePresetValue("Time signature", state.timesig, FLRecordsData.presetOptions.timesig, "Unspecified");
            }
            else if (choice === 9) {
                input = promptInput("Duration (seconds)", state.duration, 6, K_EDIT | K_NUMBER);
                if (input !== null)
                    state.duration = trimValue(input);
            }
        }
    }
    function editSession(state, cowriters) {
        var choice;
        while (bbs.online && !js.terminated) {
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Session Options", [
                "Memory mode         " + (state.memoryActive ? "Memory" : "Blank Slate"),
                "AI co-writer        " + summarizeValue(state.cowriter || "None", composeValueWidth()),
                "Wait for response   " + (state.waitForResponse ? "Yes" : "No"),
                "Back"
            ], new uifc.list.CTX());
            if (choice < 0 || choice === 3)
                return;
            if (choice === 0) {
                state.memoryActive = !state.memoryActive;
            }
            else if (choice === 1) {
                state.cowriter = chooseValueMenu("AI Co-writer", state.cowriter, cowriters, "No co-writer");
            }
            else if (choice === 2) {
                state.waitForResponse = !state.waitForResponse;
            }
        }
    }
    function sendPromptToChat(prompt) {
        var chatOptions = load("modopts.js", "jsonchat") || {};
        var client;
        var chat;
        if (!chatOptions.host || isNaN(chatOptions.port)) {
            return "jsonchat modopts are missing host/port.";
        }
        try {
            load("json-client.js");
            load(pathJoin(system.mods_dir, "load/json-chat.js"));
            // JSONClient auto-connects in its constructor (and THROWS if the host
            // is unreachable). JSONChat.connect() would then re-connect that live
            // socket and return false -- so we must NOT call it. Instead set the
            // author nick ourselves (the only thing connect() does that submit()
            // needs) and go straight to join+submit. This mirrors future_shell's
            // working pattern; calling connect() was the "Could not connect" bug.
            client = new JSONClient(chatOptions.host, chatOptions.port);
            chat = new JSONChat(user.number, client, chatOptions.host, chatOptions.port);
            chat.nick = { name: user.alias, host: system.name, ip: user.ip_address };
            chat.join(CHAT_CHANNEL);
            chat.submit(CHAT_CHANNEL, prompt);
            chat.disconnect();
            try {
                client.disconnect();
            }
            catch (_) { }
            return "";
        }
        catch (err) {
            return safeString(err);
        }
    }
    function waitForVektrax() {
        withConsoleScreen(function () {
            var chatOptions = load("modopts.js", "jsonchat") || {};
            var client;
            var chat;
            var since = Date.now();
            var chan;
            var messages;
            var message;
            var key;
            if (!chatOptions.host || isNaN(chatOptions.port)) {
                console.writeln("JSON chat is not configured.");
                waitForAnyKey();
                return;
            }
            try {
                load("json-client.js");
                load(pathJoin(system.mods_dir, "load/json-chat.js"));
                client = new JSONClient(chatOptions.host, chatOptions.port);
                chat = new JSONChat(user.number, client, chatOptions.host, chatOptions.port);
                // No chat.connect(): the JSONClient constructor already connected
                // (and throws -> caught below if the host is unreachable). Set the
                // nick and join to start receiving. Calling connect() re-connects
                // the live socket and returns false -- the old bug.
                chat.nick = { name: user.alias, host: system.name, ip: user.ip_address };
                chat.join(CHAT_CHANNEL);
            }
            catch (err) {
                console.writeln("Chat monitor failed to start: " + safeString(err));
                waitForAnyKey();
                return;
            }
            console.clear();
            printConsoleHeader("Waiting For Vektrax");
            console.writeln("Watching main chat for new Vektrax messages.");
            console.writeln("Press Q or ESC to stop waiting.");
            console.writeln("");
            while (bbs.online && !js.terminated) {
                chat.cycle();
                chan = chat.channels[CHAT_CHANNEL.toUpperCase()];
                if (chan && chan.messages && chan.messages.length) {
                    messages = chan.messages.slice(0);
                    chan.messages = [];
                    for (var i = 0; i < messages.length; i += 1) {
                        message = messages[i];
                        if (!message || !message.nick || !message.nick.name)
                            continue;
                        if (safeString(message.nick.name) !== "Vektrax")
                            continue;
                        if (typeof message.time === "number" && message.time < since)
                            continue;
                        console.writeln("[" + safeString(message.nick.name) + "] " + toScreenText(message.str || ""));
                        console.writeln("");
                    }
                }
                key = safeString(console.inkey(K_NONE, 1)).toUpperCase();
                if (key === "Q" || key === "\u001b")
                    break;
            }
            try {
                chat.disconnect();
            }
            catch (_) { }
            try {
                client.disconnect();
            }
            catch (_) { }
        });
    }
    function resetComposeState(state) {
        return createComposeState();
    }
    function composeMenu(app) {
        var state = app.compose;
        var choice;
        var sendResult;
        while (bbs.online && !js.terminated) {
            uifc.help_text = "Build a song request for Vektrax (the AI). Fill in as much or as little as you like across DNA / Lyrics / Music, Preview to see the prompt, then Send. Everything is optional.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Create / Compose", [
                "Song DNA           " + summarizeValue(state.songTitle || state.genre || "Start here", composeValueWidth()),
                "Lyrics Director    " + summarizeValue(state.lyricMode === "guided" ? "Guided sections" : state.lyricsFreeform || "Freeform", composeValueWidth()),
                "Music Direction    " + summarizeValue(state.instrumentation || state.language || "Set arrangement", composeValueWidth()),
                "Session Options    " + summarizeValue(state.cowriter || (state.memoryActive ? "Memory" : "Blank Slate"), composeValueWidth()),
                "Randomize style",
                "Preview prompt",
                "Send to Vektrax",
                "Reset builder",
                "Back"
            ], app.composeMenuCtx);
            if (choice < 0 || choice === 8)
                return;
            if (choice === 0) {
                editSongDna(state);
            }
            else if (choice === 1) {
                editLyrics(state);
            }
            else if (choice === 2) {
                editMusicDirection(state);
            }
            else if (choice === 3) {
                editSession(state, app.cowriters);
            }
            else if (choice === 4) {
                randomizeStyle(state);
            }
            else if (choice === 5) {
                showPagedText("Prompt Preview", buildPreview(state));
            }
            else if (choice === 6) {
                if (isPromptEmpty(state)) {
                    uifc.msg("The prompt is empty. Fill in at least one field before sending.");
                    continue;
                }
                showPagedText("Prompt Preview", buildPreview(state));
                if (uifc.list(WIN_MID | WIN_SAV, "Send prompt to Vektrax?", ["No", "Yes"]) !== 1) {
                    continue;
                }
                sendResult = sendPromptToChat(buildPreview(state));
                if (sendResult.length) {
                    uifc.msg("Send failed: " + sendResult);
                }
                else {
                    uifc.msg("Prompt sent to Vektrax.");
                    if (state.waitForResponse)
                        waitForVektrax();
                }
            }
            else if (choice === 7) {
                app.compose = resetComposeState(state);
                state = app.compose;
            }
        }
    }
    function shuffledCatalog(app) {
        var a = app.catalog.slice();
        for (var i = a.length - 1; i > 0; i -= 1) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }
    // No-repeat shuffle. `bag` = the tracks not yet played this cycle. Refill it
    // with `seedBag`; on a fresh cycle it holds ALL tracks (each plays exactly
    // once before any repeat). At session start we seed it EXCEPT the track
    // already playing, so that first cycle is clean too.
    function seedBag(bag, len, except) {
        bag.length = 0;
        for (var i = 0; i < len; i += 1)
            if (i !== except)
                bag.push(i);
        for (var j = bag.length - 1; j > 0; j -= 1) {
            var k = Math.floor(Math.random() * (j + 1));
            var t = bag[j];
            bag[j] = bag[k];
            bag[k] = t;
        }
    }
    function shuffleNext(len, cur, bag) {
        if (!bag.length)
            seedBag(bag, len, -1); // new cycle: every track
        var next = bag.pop();
        if (next === cur && bag.length) { // avoid a back-to-back repeat at a cycle edge
            var alt = bag.pop();
            bag.push(next);
            next = alt;
        }
        return next;
    }
    // No terminal audio sink: the radio can't play, so let the caller browse the
    // catalog and open details / play-in-browser. Esc from the browser leaves.
    function noAudioFallback(app) {
        withConsoleScreen(function () {
            console.clear();
            printConsoleHeader(APP_TITLE);
            console.writeln("");
            console.writeln("  No terminal audio sink was detected.");
            console.writeln("");
            console.writeln("  In-terminal playback needs a current SyncTERM (APC audio)");
            console.writeln("  or the BBSproxy shim. You can still browse the catalog and");
            console.writeln("  use [P] Play In Browser from a song's details.");
            console.writeln("");
            console.writeln("  Press any key to browse...");
            waitForAnyKey();
        });
        for (;;) {
            if (!bbs.online || js.terminated)
                return;
            var pick = browseSongs(app);
            if (!pick)
                return;
            showTrackDetail(pick.list[pick.index], pick.list, pick.index);
        }
    }
    // "Tune In": the door opens straight into the visualizer with music playing
    // (a shuffle of the whole catalog). Browse (B) and Create (C) are reachable
    // from inside the player; with no audio sink we drop to browse-only.
    function tuneIn(app) {
        var sink = "none";
        withConsoleScreen(function () {
            console.clear();
            console.writeln("");
            console.writeln("  Tuning in to Futureland Records...");
            sink = FLPlayer.detectSink();
        });
        if (sink === "none" || !app.catalog.length) {
            noAudioFallback(app);
            return;
        }
        // The all-songs radio shuffles by default; S toggles to sequential.
        FLPlayer.shuffle = true;
        var list = shuffledCatalog(app);
        playInTerminal(list[0], list, 0);
    }
    // Regression guard for the CP437 artist-name corruption: the real tag
    // "Vektrax feat. 🗲ᴍʀᴏ1337" decoded to small-caps + astral codepoints, and
    // naive rendering turned U+1D0D into 0x0D (CR) that smeared the track list.
    function sanitizerSelfTest() {
        function must(got, want, label) {
            if (got !== want)
                throw new Error("sanitizer " + label + ": got " + JSON.stringify(got) +
                    " want " + JSON.stringify(want));
            for (var i = 0; i < got.length; i += 1) {
                var c = got.charCodeAt(i);
                if (c < 0x20 || c > 0x7e)
                    throw new Error("sanitizer " + label + ": unsafe byte 0x" + c.toString(16));
            }
        }
        // small-caps "mro" + astral lightning + embedded controls
        var smallcaps = String.fromCharCode(0x1D0D, 0x0280, 0x1D0F);
        must(screenSafe("Vektrax feat. " + String.fromCharCode(0xD83D, 0xDDF2) +
            smallcaps + "1337" + String.fromCharCode(0xD83D, 0xDDF2)), "Vektrax feat. mro1337", "decorated-handle-surrogate");
        // the form the door actually sees: utf8_utf16() truncates the astral
        // U+1F5F2 to a single BMP code 0xF5F2 before screenSafe runs.
        must(screenSafe("Vektrax feat. " + String.fromCharCode(0xF5F2) +
            smallcaps + "1337" + String.fromCharCode(0xF5F2)), "Vektrax feat. mro1337", "decorated-handle-decoded");
        must(screenSafe("A" + String.fromCharCode(0x0D, 0x0F, 0x1B) + "B"), "AB", "controls");
        must(screenSafe("darksix"), "darksix", "clean-passthrough");
        must(screenSafe(String.fromCharCode(0x201C) + "hi" + String.fromCharCode(0x201D)), "\"hi\"", "smart-quotes");
        writeln("sanitizer self-test: OK");
    }
    function playlistSelfTest() {
        if (typeof JSONdb !== "function") {
            writeln("playlist self-test: SKIP (no JSONdb)");
            return;
        }
        var TP = "__fltest__";
        plDelete(TP);
        plDelete(TP + "2");
        if (!plCreate(TP, "a.mp3"))
            throw new Error("plCreate failed");
        plAddTrack(TP, "b.mp3");
        plAddTrack(TP, "b.mp3"); // dedupe
        var pl = findPlaylist(loadPlaylists(), TP);
        if (!pl)
            throw new Error("playlist not persisted");
        if (pl.tracks.join(",") !== "a.mp3,b.mp3")
            throw new Error("tracks: " + pl.tracks.join(","));
        plSetOrder(TP, ["b.mp3", "a.mp3"]);
        if (findPlaylist(loadPlaylists(), TP).tracks.join(",") !== "b.mp3,a.mp3")
            throw new Error("reorder");
        plRemoveTrack(TP, "b.mp3");
        if (findPlaylist(loadPlaylists(), TP).tracks.join(",") !== "a.mp3")
            throw new Error("remove");
        plRename(TP, TP + "2");
        if (findPlaylist(loadPlaylists(), TP))
            throw new Error("rename left old");
        if (!findPlaylist(loadPlaylists(), TP + "2"))
            throw new Error("rename lost new");
        plDelete(TP + "2");
        if (findPlaylist(loadPlaylists(), TP + "2"))
            throw new Error("delete failed");
        writeln("playlist self-test: OK");
    }
    // No-repeat shuffle: every queue track must play before any repeats, and a
    // track never lands twice in a row.
    function shuffleSelfTest() {
        var len = 7;
        var bag = [];
        var cur = 0;
        seedBag(bag, len, cur); // first cycle excludes the starting track
        var seen = {};
        seen[cur] = true;
        var seenCount = 1;
        for (var s = 0; s < len * 5; s += 1) {
            var nxt = shuffleNext(len, cur, bag);
            if (nxt === cur)
                throw new Error("shuffle immediate repeat");
            if (seen[nxt]) {
                if (seenCount !== len)
                    throw new Error("shuffle repeated after " + seenCount + "/" + len + " (not exhausted)");
                seen = {};
                seenCount = 0;
            }
            if (!seen[nxt]) {
                seen[nxt] = true;
                seenCount += 1;
            }
            cur = nxt;
        }
        writeln("shuffle self-test: OK");
    }
    function main() {
        if (typeof argv !== "undefined" && argv && argv.indexOf("--selftest") >= 0) {
            sanitizerSelfTest();
            playlistSelfTest();
            shuffleSelfTest();
            FLPlayer.selfTest();
            return;
        }
        var app = createAppState();
        activeApp = app;
        try {
            app.catalog = loadCatalog(false);
            app.cowriters = loadCowriters();
            // Tune In: straight into the radio (console-mode player). uifc is
            // only brought up on demand for Create / no-audio browse.
            tuneIn(app);
        }
        catch (err) {
            safeBailUi();
            console.clear();
            console.writeln(APP_TITLE);
            console.writeln("");
            console.writeln("Startup failed:");
            console.writeln(safeString(err));
            console.pause();
        }
        finally {
            safeBailUi();
        }
    }
    main();
})();
