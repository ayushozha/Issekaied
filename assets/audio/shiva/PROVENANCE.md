# Shiva Tandava Stotram - generated spoken audio

This spoken recitation uses speech synthesized with artificial intelligence. It is not a human or commercial recording and does not imitate a named artist.

## Traditional text and attribution

Traditional Sanskrit hymn conventionally attributed to Ravana; historical authorship is not established. Public-domain original traditional verses only. No modern translation, commentary, musical arrangement or third-party recording is included.

- Primary reference: https://sbm.org.uk/?page_id=191
- Unicode extraction reference: https://www.thesanskritchannel.org/shiva-tandava-stotram
- Edition and normalization: Complete traditional 15-stanza temple recension, with Sanskrit publisher readings: publisher stanzas 1-14 and concluding phalashruti (18). The expanded publisher edition includes three extra verses, not used here. Line-wrap hyphens/stanza numbers removed; southern-script lla normalized to la.
- Exact text: [source-text.txt](source-text.txt), 15 blocks, 2149 characters; SHA256 `6f4b52a822464996f7252bc3638d7c3bea3b445064df4ba8ef59852adbd88527`.

The public-domain assessment applies to the original traditional verses. Modern website layouts, translations, explanations, illustrations and recordings are not redistributed or licensed by this document. The new audio was generated for Issekaied through the project OpenAI account; this document does not grant rights to any third-party performance or voice.

## Generation and use

- Provider: OpenAI Speech API; model read from `OPENAI_TTS_MODEL`, observed `gpt-4o-mini-tts`; configured herald voice `cedar`. No credentials are present here.
- Endpoint: `POST /v1/audio/speech`; all 4 requests returned HTTP200 and audio/mpeg.
- Detailed speech instructions, input hashes and raw chunks are preserved in the ignored local generation records. The exact traditional source is linked above; the complete receipts are retained locally.
- Final files: `tandava-full.mp3`, `tandava-cue.mp3`.
- Raw source chunks and original short cue (when present) are preserved in `raw-chunks/`. Full recitations concatenate complete verse-boundary chunks; short cues are complete excerpts and are never cut mid-word.

## Verification and limitation

Both final files passed ffprobe and a complete ffmpeg decode: MP3, 24kHz, mono. Hindi/Sanskrit pronunciation, textual fidelity of the generated voice, musical quality and Vedic intonation have not been reviewed by a fluent human. These are spoken recitations, not authenticated Vedic chanting. No claim of medical effects is made; healing refers only to the proposed game ability. Playback wiring and gameplay behavior are owned by the application workers and are not established by this asset generation.

Suggested player-facing disclosure: **Spoken recitations synthesized with artificial intelligence of traditional public-domain texts.**
