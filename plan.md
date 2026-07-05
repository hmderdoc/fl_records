TODO: For this project use typescript and target the file /sbbs/xtrn/fl_records/fl_records.js for build output, this will be our synchronet runtime copy, we can keep our typescript stuff in /sbbs/xtrn/fl_records/src

 In our webv4_custom implementation we have a page `011-futureland.records.xjs` and an embedded record label widget.  On that page you could say there is (1) a "READ / listen" view where the Records are displayed with art and metadata and you can launch the player and (2) A "CREATE/COMPOSE" view where there is a form that helps guide the user to create a song prompt, just a string really, using controls that guide them to populate the prompt with descriptive labels from a list.

What we want to do is create an equivalent version for our BBS terminal mode.  For a read view, we'll want to be able to pick from a list and maybe use filters similar to how our music player on the web is able to filter results by title, genre, artist, composer, etc.  So the first entry point of the READ view is a list of songs, hopefully using a lightbar menu format, which can be filtered, and from the list we can get into a "Song detail mode".  Perhaps in song detail mode by default we show some song metadata and then 2-4 menu options, the menu options would be "Show Song Artwork", "Show Song Lyrics", "Show full metadata", "Play In Browser" (using our browser bridge - v2+ feature). 

For the artwork, we are actually embedding ANSI art into mp3s, like so: 

```
To extract from a door game:

1. ANSI_ART — Read the TXXX frame with description "ANSI_ART", base64-decode the value → raw .ans bytes you can pipe straight to a terminal
2. ANSI_BITMAP — Read the TXXX frame with description "ANSI_BITMAP", zlib-inflate → the BITMAP chat-encoded payload (the format from your ANSI bitmap encoder)
APIC — Standard ID3 attached picture frame, type "Front Cover" — PNG image (useful if you want to convert/display but not raw ANSI)
For a door game, ANSI_ART is probably what you want — base64-decode and write it to the terminal. It's an 80-column CP437 ANSI file with the album art.
```

That should cover the read view for now.  For the song composition view, really all we are doing is presenting the same form in a different environment to build a string to ultimately send to our chat room, optionally waiting for a response.  We pretty much should use the existing web form as a reference.



The "Play on Web" functionality doesn't work, not surprised, I think we may need to extend the associated web library as well as our pseudo-escape-sequence payload to behave different.  Essentially we are creating a bridge to our radio player on webv4_custom to tell it to play a song matching the title or other ID we emit.

As we investigate extending the web bridge, I think we should also add the ability to detect its presence from the terminal, essentially a call and response hook where the terminal sends a pseudo escape code for purpose of "Do you understand this message, respond with secret if so?" and then the web-listener would get that code and respond and say in essence "Yes, audio and web-bridge stuff is supported in this terminal"
