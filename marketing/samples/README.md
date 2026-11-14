# Marketing sample sources

The DRY recordings behind the before / after players on the effect marketing
pages (`/plugins/<slug>/`). One folder per page, named by its URL slug:

    marketing/samples/la-vintage-2a/narration.wav
    marketing/samples/voxpressor/podcast.wav

Each file name is a sample `id` from `src/content/marketing/<window-id>.js`,
whose `brief` says what to record for that slot. WAV, FLAC, AIFF, MP3 or M4A,
mono or stereo, any rate (rendered at 44.1 kHz). Unprocessed: no compressor,
limiter, de-esser or noise reduction — the page is showing what the effect does.

Then:

    npm run marketing:render                 # every page
    npm run marketing:render -- opto-smooth  # one page (window id)

which renders each clip through the effect exactly as Apply would and writes
the pair the page plays (`public/plugins/<slug>/audio/<id>-off.mp3` / `-on.mp3`)
plus `src/content/marketing/audio/<window-id>.json`. Commit those. These source
files are not committed (the repo ignores audio files): a sample with no source
keeps its last render.

A file named `PLACEHOLDER` in a folder marks its clips as stand-ins, and the
page labels them so. The clips shipped first were synthetic text-to-speech
placeholders, rendered that way; replacing them with real recordings clears the
label.
