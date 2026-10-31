# Hanuman Chalisa - generated spoken audio

This spoken recitation uses speech synthesized with artificial intelligence. It is not a human or commercial recording and does not imitate a named artist.

## Traditional text and attribution

Traditional Awadhi original attributed to Tulsidas (16th-17th century). Public-domain original traditional verses only. No modern translation, commentary, musical arrangement or third-party recording is included.

- Primary reference: https://share.chinmayamission.com/docs/CMM15-Anniversary-Puja-Chanting.pdf
- Unicode extraction reference: https://sri-hanuman-chalisa.com/wp-content/uploads/2026/02/Hanuman-Chalisa-Lyrics-in-Hindi-PDF.pdf
- Edition and normalization: Two opening dohas, 40 chaupais, closing doha. Unicode extraction cross-checked with Chinmaya temple reference; one embedded Roman word normalized to verified Devanagari. Headings, numbers and unrelated following prayers removed.
- Exact text: [source-text.txt](source-text.txt), 43 blocks, 2363 characters; SHA256 `3bc699e844c1a77859762d24f4b62e3c87937d8f0a5d9296679a37323c611442`.

The public-domain assessment applies to the original traditional verses. Modern website layouts, translations, explanations, illustrations and recordings are not redistributed or licensed by this document. The new audio was generated for Issekaied through the project OpenAI account; this document does not grant rights to any third-party performance or voice.

## Generation and use

- Provider: OpenAI Speech API; model read from `OPENAI_TTS_MODEL`, observed `gpt-4o-mini-tts`; configured herald voice `verse`. No credentials are present here.
- Endpoint: `POST /v1/audio/speech`; all 4 requests returned HTTP200 and audio/mpeg.
- Detailed speech instructions, input hashes and raw chunks are preserved in the ignored local generation records. The exact traditional source is linked above; the complete receipts are retained locally.
- Final files: `chalisa-full.mp3`, `chalisa-cue.mp3`.
- Raw source chunks and original short cue (when present) are preserved in `raw-chunks/`. Full recitations concatenate complete verse-boundary chunks; short cues are complete excerpts and are never cut mid-word.

## Verification and limitation

Both final files passed ffprobe and a complete ffmpeg decode: MP3, 24kHz, mono. Hindi/Sanskrit pronunciation, textual fidelity of the generated voice, musical quality and Vedic intonation have not been reviewed by a fluent human. These are spoken recitations, not authenticated Vedic chanting. No claim of medical effects is made; healing refers only to the proposed game ability. Playback wiring and gameplay behavior are owned by the application workers and are not established by this asset generation.

Suggested player-facing disclosure: **Spoken recitations synthesized with artificial intelligence of traditional public-domain texts.**
