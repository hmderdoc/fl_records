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
    function waitKey() {
        return String(console.getkey(K_NONE) || "");
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
            var hint = helpText.length > scrCols() - 4 ? helpText.substr(0, scrCols() - 4) : helpText;
            console.write(gotoRC(scrRows(), Math.max(1, Math.floor((scrCols() - hint.length) / 2))) +
                sgr("0;30;1") + hint + sgr("0"));
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
            else if (k === "\x03") { // end
                cur = options.length - 1;
            }
            else if (k === "\r" || k === "\n") {
                if (ctx)
                    ctx.cur = cur;
                return cur;
            }
            else if (k === ESC || k === "q" || k === "Q") {
                if (ctx)
                    ctx.cur = cur;
                return -1;
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
    if (typeof uifc === "undefined") {
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
 * FLPlayer — in-terminal MP3 playback for Futureland Records over the
 * SyncTERM APC audio protocol (APC SyncTERM:... ST), with album-art
 * backdrop, a counting-up progress overlay, and an audio-reactive
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
 */
var FLPlayer;
(function (FLPlayer) {
    // ---- tuning -------------------------------------------------------
    var CHUNK_MS = 300; // clip length; also the pacing quantum
    var PREBUFFER = 3; // chunks queued ahead of realtime
    var CHANNEL = 2; // first APC-dedicated channel (0/1 are cterm's)
    var SLOTS = 8; // patch slots cycled for chunk clips
    var PCM_RATE = 22050; // transcode rate (client resamples to 44.1k)
    var PCM_CHANNELS = 2; // stereo; halve bandwidth with 1 if needed
    var UI_TICK_MS = 150; // overlay/visualizer repaint cadence
    var SEEK_SECONDS = 10;
    var VOLUME_STEP = 10; // percent per Up/Down press
    var detectedSink = null; // per-session cache
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
    // We always transcode to canonical PCM (pcm_s16le), so a fixed-layout
    // header writer/parser is sufficient; parse still walks RIFF chunks in
    // case ffmpeg adds a LIST before data.
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
            ":" + PCM_RATE + "x" + PCM_CHANNELS, true);
        var out = pcmDir() + "/" + key + ".wav";
        if (file_exists(out) && file_size(out) > 44)
            return out;
        if (!mkpath(pcmDir()))
            return null;
        var cmd = "ffmpeg -v quiet -y -i " + shellQuote(track.path) +
            " -ar " + PCM_RATE + " -ac " + PCM_CHANNELS +
            " -c:a pcm_s16le -f wav " + shellQuote(out) + " </dev/null";
        system.exec(cmd);
        if (file_exists(out) && file_size(out) > 44)
            return out;
        return null;
    }
    FLPlayer.ensureTranscoded = ensureTranscoded;
    var InputPump = /** @class */ (function () {
        function InputPump() {
            this.buf = "";
        }
        /** Poll for up to maxMs, decoding everything that arrives. */
        InputPump.prototype.pump = function (maxMs) {
            var res = { keys: [], arrows: [], esc: false, audio: [] };
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
                    res.keys.push(c.toUpperCase());
                    this.buf = this.buf.substr(1);
                    continue;
                }
                // ESC ...: need at least ESC [ + final byte to decode a CSI.
                if (this.buf.length === 1) {
                    if (idle) { // nothing followed: it's the Esc key
                        res.esc = true;
                        this.buf = "";
                    }
                    return;
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
                    var parts = body.substr(2).split(";");
                    // "=7;a;b[;c;d...]n" -> leading empty from ";a" split
                    for (var i = 1; i + 1 < parts.length + 1; i += 2) {
                        var id = parseInt(parts[i], 10);
                        var st = parseInt(parts[i + 1], 10);
                        if (!isNaN(id) && !isNaN(st))
                            res.audio.push([id, st]);
                    }
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
                // other CSI (mouse, reports): ignored
            }
        };
        return InputPump;
    }());
    FLPlayer.InputPump = InputPump;
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
        var pumpr = new InputPump();
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
    // Stride-sampled from the slice we already hold for base64 encoding:
    // ~256 sample points per chunk give a stable RMS (loudness) and zero
    // crossing rate (brightness proxy) without measurable CPU cost.
    function chunkFeatures(slice, channels) {
        var frames = Math.floor(slice.length / (channels * 2));
        if (frames < 2)
            return { rms: 0, zcr: 0 };
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
            return { rms: 0, zcr: 0 };
        var rms = Math.sqrt(sumSq / count) / 32768;
        // Perceptual-ish lift: quiet music still moves the meter.
        rms = Math.sqrt(clamp(rms * 3.2, 0, 1));
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
        return { rms: rms, zcr: zcr };
    }
    FLPlayer.chunkFeatures = chunkFeatures;
    // ---- playback screen ----------------------------------------------------
    var CLR = "\x1b[0m";
    function sgr(codes) {
        return "\x1b[" + codes + "m";
    }
    function gotoRC(row, col) {
        return "\x1b[" + row + ";" + col + "H";
    }
    function layout() {
        var cols = Math.max(40, console.screen_columns || 80);
        var rows = Math.max(12, console.screen_rows || 24);
        var width = Math.min(cols - 2, 76);
        return {
            cols: cols,
            rows: rows,
            boxTop: rows - 4,
            boxLeft: Math.max(1, Math.floor((cols - width) / 2) + 1),
            boxWidth: width,
            glowRow: rows - 5
        };
    }
    function drawBackdrop(track, l) {
        console.write(CLR + "\x1b[2J\x1b[H");
        if (track.ansiArt.length) {
            console.write(track.ansiArt);
            console.write(CLR);
        }
        else {
            // No embedded art: a dim generated backdrop so the box isn't lonely.
            var mid = Math.max(2, Math.floor(l.rows / 2) - 3);
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
    function drawProgress(l, playedSec, totalSec, paused, volumePct) {
        var inner = l.boxWidth - 4;
        var timeTxt = fmtTime(playedSec) + "/" + fmtTime(totalSec);
        var volTxt = paused ? " PAUSED " : (" vol" + volumePct + " ");
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
    function drawHints(l) {
        var hints = "[Space]Pause  [\x1b/\x1a]Seek  [\x18/\x19]Vol  [N]ext [P]rev  [V]iz  [Q]uit";
        if (hints.length > l.boxWidth)
            hints = "[Spc]Pause [N/P]Trk [Q]uit";
        var col = Math.max(1, l.boxLeft + Math.floor((l.boxWidth - hints.length) / 2));
        console.write(gotoRC(Math.min(l.rows, l.boxTop + 4), col) + sgr("0;30;1") + hints + CLR);
    }
    // Audio-reactive glow strip: a mirrored bar of shade blocks whose reach
    // follows loudness and whose color follows brightness (ZCR): bass-heavy
    // reads red/magenta, bright reads cyan/white. Border pulses on beats.
    var VIS_MODES = ["glow", "glow+art", "border", "off"];
    function drawGlow(l, rms, zcr, mode) {
        if (mode === "off") {
            console.write(gotoRC(l.glowRow, l.boxLeft) + repeatByte(" ", l.boxWidth));
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
        var strip = left + line + (l.boxWidth % 2 ? " " : "");
        console.write(gotoRC(l.glowRow, l.boxLeft) + sgr(color) + strip.substr(0, l.boxWidth) + CLR);
    }
    // ---- art color-pulse variants -----------------------------------------
    // "Alpha color swap": rotate the chromatic SGR colors of the .ans art
    // (30/37/38/39 and the grays stay put so structure survives), giving 2-3
    // palette-shifted variants we can flash on beats. Built once per track.
    var HUE_ROT = {
        "31": "33", "33": "32", "32": "36", "36": "34", "34": "35", "35": "31",
        "41": "43", "43": "42", "42": "46", "46": "44", "44": "45", "45": "41"
    };
    function rotateSgr(art) {
        return art.replace(/\x1b\[([0-9;]*)m/g, function (whole, body) {
            var parts = body.split(";");
            for (var i = 0; i < parts.length; i++) {
                var mapped = HUE_ROT[parts[i]];
                if (mapped)
                    parts[i] = mapped;
            }
            return "\x1b[" + parts.join(";") + "m";
        });
    }
    function buildArtVariants(art) {
        if (!art.length)
            return [];
        var v1 = rotateSgr(art);
        var v2 = rotateSgr(v1);
        return [art, v1, v2];
    }
    FLPlayer.buildArtVariants = buildArtVariants;
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
            var head = f.read(512);
            var info = parseWavHeader(head, f.length);
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
        var l = layout();
        var pump = new InputPump();
        var visMode = 0;
        var volumePct = 80;
        var borderPulse = 0; // decaying beat flash
        var lastRms = 0;
        var artVariants = buildArtVariants(track.ansiArt);
        var artFlashIdx = 0;
        var lastArtFlashAt = 0;
        drawBackdrop(track, l);
        drawBoxFrame(l, "0;34");
        drawTitleLine(l, track);
        drawHints(l);
        apc("A;Volume;C=" + CHANNEL + ";V=" + volumePct);
        apc("A;Update;C=" + CHANNEL);
        var chunk = 0; // next chunk to emit
        var t0 = nowMs(); // wall-clock anchor: chunk i plays at t0 + i*CHUNK_MS
        var paused = false;
        var lastUiAt = 0;
        var result = "ended";
        var features = { rms: 0, zcr: 0 };
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
            apc("A;Flush;C=" + CHANNEL);
            apc("A;Update;C=" + CHANNEL);
        }
        while (bbs.online && !js.terminated) {
            var now = nowMs();
            var playMs = now - t0;
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
            var quitReq = ev.esc;
            for (var i = 0; i < ev.keys.length; i++) {
                var k = ev.keys[i];
                if (k === "Q")
                    quitReq = true;
                else if (k === " ") {
                    if (!paused) {
                        paused = true;
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
                else if (k === "V") {
                    visMode = (visMode + 1) % VIS_MODES.length;
                    drawGlow(l, 0, 0, "off");
                    if (artVariants.length && artFlashIdx !== 0) {
                        artFlashIdx = 0;
                        console.write(CLR + "\x1b[H" + artVariants[0] + CLR);
                        drawBoxFrame(l, "0;34");
                        drawTitleLine(l, track);
                        drawHints(l);
                    }
                }
            }
            for (var a = 0; a < ev.arrows.length; a++) {
                var dir = ev.arrows[a];
                if (dir === "left" || dir === "right") {
                    var delta = (dir === "left" ? -SEEK_SECONDS : SEEK_SECONDS) * 1000;
                    var target = clamp(playMs + delta, 0, Math.max(0, (totalChunks - 1) * CHUNK_MS));
                    if (!paused)
                        rePrime(Math.floor(target / CHUNK_MS));
                    else
                        chunk = clamp(Math.floor(target / CHUNK_MS), 0, totalChunks);
                }
                else if (dir === "up" || dir === "down") {
                    volumePct = clamp(volumePct + (dir === "up" ? VOLUME_STEP : -VOLUME_STEP), 0, 100);
                    apc("A;Volume;C=" + CHANNEL + ";V=" + volumePct + ";T=120");
                }
            }
            for (var e = 0; e < ev.audio.length; e++) {
                if (ev.audio[e][0] === CHANNEL && ev.audio[e][1] === 0 && !paused) {
                    if (chunk >= totalChunks) {
                        // Armed notify after the last chunk: the song finished.
                        result = "ended";
                        quitReq = true;
                    }
                    else {
                        // Underrun: the cushion ran dry (slow link / stall).
                        // Re-anchor and re-prime, exactly like lameboy does.
                        rePrime(playChunk);
                    }
                }
            }
            if (quitReq)
                break;
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
                var beat = !paused && features.rms > lastRms + 0.22;
                if (beat)
                    borderPulse = 3; // beat: flash the border
                lastRms = features.rms;
                // Art color-pulse: on beats, redraw the art with a rotated
                // palette (rate-capped so slow links keep breathing room).
                if (mode === "glow+art" && beat && artVariants.length > 1 &&
                    now - lastArtFlashAt > 450) {
                    lastArtFlashAt = now;
                    artFlashIdx = (artFlashIdx + 1) % artVariants.length;
                    console.write(CLR + "\x1b[H" + artVariants[artFlashIdx] + CLR);
                    drawBoxFrame(l, "0;34");
                    drawTitleLine(l, track);
                    drawHints(l);
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
                drawGlow(l, paused ? 0 : features.rms, features.zcr, (mode === "glow" || mode === "glow+art") ? "glow" : "off");
                drawProgress(l, clamp(playMs / 1000, 0, totalSec), totalSec, paused, volumePct);
                console.write(gotoRC(l.rows, l.cols) + CLR);
            }
        }
        apc("A;Flush;C=" + CHANNEL + ";O=250");
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
        // Feature extraction: a loud sine has high RMS and some crossings;
        // silence has neither.
        var loud = chunkFeatures(pcm, 2);
        if (!(loud.rms > 0.4))
            throw new Error("sine rms too low: " + loud.rms);
        if (!(loud.zcr > 0))
            throw new Error("sine zcr zero");
        var quiet = chunkFeatures(repeatByte("\x00", 4000), 2);
        if (quiet.rms !== 0)
            throw new Error("silence rms nonzero");
        // Art hue rotation: chromatic codes rotate, structure survives.
        var art = "\x1b[1;31mRED\x1b[0;44;33mYB\x1b[37mW\x1b[m.";
        var vars2 = buildArtVariants(art);
        if (vars2.length !== 3)
            throw new Error("variant count");
        if (vars2[1] !== "\x1b[1;33mRED\x1b[0;45;32mYB\x1b[37mW\x1b[m.")
            throw new Error("hue rotation wrong: " + vars2[1].replace(/\x1b/g, "^["));
        if (vars2[1] === vars2[0] || vars2[2] === vars2[1] || vars2[2] === vars2[0])
            throw new Error("variants not distinct");
        // Base64 sanity over binary bytes.
        var rt = base64_decode(base64_encode(wav.substr(0, 200)));
        if (rt !== wav.substr(0, 200))
            throw new Error("base64 round trip failed");
        // Reply parser: feature reply, drain notify, arrows, keys, lone ESC.
        var p = new InputPump();
        var res = { keys: [], arrows: [], esc: false, audio: [] };
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
        if (!res.esc)
            throw new Error("lone ESC parse");
        // Split CSI across feeds must not produce phantom keys.
        var p2 = new InputPump();
        var r2 = { keys: [], arrows: [], esc: false, audio: [] };
        p2.buf = "\x1b[=7;2";
        p2.drain(r2, false);
        if (r2.keys.length || r2.audio.length || r2.esc)
            throw new Error("partial CSI leaked");
        p2.buf += ";0n";
        p2.drain(r2, true);
        if (r2.audio.length !== 1)
            throw new Error("resumed CSI lost");
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
            var inf = parseWavHeader(tf.read(512), tf.length);
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
    var CACHE_VERSION = 1;
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
            title: cached.title || "",
            artist: cached.artist || "",
            composer: cached.composer || "",
            genre: cached.genre || "",
            album: cached.album || "",
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
            title: trimValue(parsed.title),
            artist: trimValue(parsed.artist),
            composer: trimValue(parsed.composer),
            genre: trimValue(parsed.genre),
            album: trimValue(parsed.album),
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
    function loadCatalog(forceRefresh) {
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
    function toScreenText(value) {
        var text = safeString(value);
        if (!text.length)
            return "";
        if (typeof str_is_utf8 === "function" && typeof utf8_cp437 === "function" && console.term_supports && !console.term_supports(USER_UTF8)) {
            try {
                if (str_is_utf8(text))
                    return utf8_cp437(text);
            }
            catch (_) {
            }
        }
        return text;
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
                "Search text         " + summarizeValue(app.filters.search, 34),
                "Artist              " + summarizeValue(app.filters.artist || "All artists", 34),
                "Composer            " + summarizeValue(app.filters.composer || "All composers", 34),
                "Genre               " + summarizeValue(app.filters.genre || "All genres", 34),
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
    function playInTerminal(track, list, index) {
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
            var idx = typeof index === "number" ? index : 0;
            while (bbs.online && !js.terminated) {
                var cur = (list && list.length) ? list[idx] : track;
                var parsed = parseTrackTags(cur.path, {
                    includeLyrics: false,
                    includeAnsiArt: true
                });
                var playable = {
                    path: cur.path,
                    name: cur.name,
                    size: cur.size,
                    mtime: cur.mtime,
                    title: toScreenText(displayTrackTitle(cur)),
                    artist: toScreenText(displayTrackArtist(cur)),
                    ansiArt: parsed.ansiArtBase64.length ? base64_decode(parsed.ansiArtBase64) : ""
                };
                var outcome = FLPlayer.playTrack(playable);
                // Jukebox flow: a song ending naturally advances to the next
                // track in the filtered list; N/P move manually; Q/Esc exits.
                if (outcome === "next" || outcome === "ended") {
                    if (!list || !list.length || idx + 1 >= list.length)
                        return;
                    idx++;
                    continue;
                }
                if (outcome === "prev") {
                    if (!list || !list.length)
                        return;
                    idx = idx > 0 ? idx - 1 : 0;
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
            uifc.help_text = "The first row edits filters. Select any song row to open its detail view.";
            selection = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Read / Listen  (" + filtered.length + " of " + app.catalog.length + " tracks)", options, app.trackListCtx);
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
            showTrackDetail(filtered[selection - 2], filtered, selection - 2);
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
        while (bbs.online && !js.terminated) {
            options = [
                "Song title          " + summarizeValue(state.songTitle, 34),
                "Brief               " + summarizeValue(state.brief, 34),
                "Genre               " + summarizeValue(state.genre, 34),
                "Feel                " + summarizeValue(state.feel, 34),
                "Tone                " + summarizeValue(state.tone, 34),
                "Arrangement         " + summarizeValue(state.arrangement, 34),
                "Extra notes         " + summarizeValue(state.notes, 34),
                "Back"
            ];
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
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, section.label, [
                "Guidance notes      " + summarizeValue(sectionState.notes, 34),
                "Section text        " + summarizeValue(sectionState.text, 34),
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
                    options.push(section.label + "          " + summarizeValue(summary.notes || summary.text, 34));
                }
                options.push("Clear all guided sections");
            }
            else {
                options.push("Edit freeform lyrics  " + summarizeValue(state.lyricsFreeform, 30));
                options.push("Clear freeform lyrics");
            }
            options.push("Back");
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
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Music Direction", [
                "Instrumentation     " + summarizeValue(state.instrumentation, 34),
                "Groove              " + summarizeValue(state.groove, 34),
                "Band                " + summarizeValue(state.band, 34),
                "Lead vocal          " + summarizeValue(state.leadvocal, 34),
                "Backing vocals      " + summarizeValue(state.backingvocal, 34),
                "Language            " + summarizeValue(state.language, 34),
                "Tempo               " + summarizeValue(getTempoLabel(state), 34),
                "Key                 " + summarizeValue(state.key, 34),
                "Time signature      " + summarizeValue(state.timesig, 34),
                "Duration (seconds)  " + summarizeValue(state.duration, 34),
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
                "AI co-writer        " + summarizeValue(state.cowriter || "None", 34),
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
            client = new JSONClient(chatOptions.host, chatOptions.port);
            chat = new JSONChat(user.number, client);
            if (!chat.connect())
                return "Could not connect to JSON chat service.";
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
                chat = new JSONChat(user.number, client);
                if (!chat.connect()) {
                    console.writeln("Could not connect to JSON chat.");
                    waitForAnyKey();
                    return;
                }
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
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, "Create / Compose", [
                "Song DNA           " + summarizeValue(state.songTitle || state.genre || "Start here", 34),
                "Lyrics Director    " + summarizeValue(state.lyricMode === "guided" ? "Guided sections" : state.lyricsFreeform || "Freeform", 34),
                "Music Direction    " + summarizeValue(state.instrumentation || state.language || "Set arrangement", 34),
                "Session Options    " + summarizeValue(state.cowriter || (state.memoryActive ? "Memory" : "Blank Slate"), 34),
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
    function mainMenu(app) {
        var choice;
        while (bbs.online && !js.terminated) {
            uifc.help_text = "Read / Listen opens the filterable song list. Create / Compose builds a Vektrax prompt in a grouped terminal workflow.";
            choice = uifc.list(WIN_ESC | WIN_SAV | WIN_ACT, APP_TITLE, [
                "Read / Listen      " + app.catalog.length + " tracks",
                "Create / Compose",
                "Refresh Catalog Cache",
                "Quit"
            ], app.mainMenuCtx);
            if (choice < 0 || choice === 3)
                return;
            if (choice === 0) {
                browseTracks(app);
            }
            else if (choice === 1) {
                composeMenu(app);
            }
            else if (choice === 2) {
                app.catalog = loadCatalog(true);
            }
        }
    }
    function main() {
        if (typeof argv !== "undefined" && argv && argv.indexOf("--selftest") >= 0) {
            FLPlayer.selfTest();
            return;
        }
        var app = createAppState();
        try {
            app.catalog = loadCatalog(false);
            app.cowriters = loadCowriters();
            initUi();
            mainMenu(app);
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
