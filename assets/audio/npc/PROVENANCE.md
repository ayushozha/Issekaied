# NPC introduction audio

These four AI-generated voice clips are fixed fictional introductions for Bellgrave. They do not describe real player history or demonstrate reactive ghost memory. They were generated with the OpenAI Speech API at `POST /v1/audio/speech`; all four requests returned HTTP 200 with `audio/mpeg` content.

| NPC | Voice | File | Duration | Bytes |
| --- | --- | --- | --- | --- |
| Morrow | `ash` | `morrow-intro.mp3` | 7.608 s | 121728 |
| Nix | `onyx` | `nix-intro.mp3` | 6.960 s | 111360 |
| Vesper | `sage` | `vesper-intro.mp3` | 10.008 s | 160128 |
| Raksha | `echo` | `raksha-intro.mp3` | 9.048 s | 144768 |

`ffprobe` recognized every file as MP3 audio, 24000 Hz, mono. No audio editing or transcoding was applied.

## Exact spoken text

- **Morrow:** I am Morrow, once the bell-ringer of this chapel. Walk softly; even the echoes are listening.
- **Nix:** The name is Nix. Welcome to the west crypt; do try not to make yourself comfortable.
- **Vesper:** I am Vesper, and this chapel is my stage. Take your place, hunter; the performance begins at midnight.
- **Raksha:** I am Raksha, keeper of the eastern ruin. Enter with courage, hunter; Bellgrave tests all who cross its stones.

## Configuration and provenance

Voice assignments were read from `server/config/npcs.json` without editing that file. Generation used `OPENAI_API_KEY` and `OPENAI_TTS_MODEL` from the ignored root `.env`; the available speech model selected for this prototype was `gpt-4o-mini-tts`. `OPENAI_TTS_VOICE=ash` is the default; the four clips use their distinct NPC voice assignments above. Application model selection remains environment-driven.

The ignored `.audio-orchestration/intro-generation.json` contains the exact delivery instructions, generation time, response metadata, and the current Speech API deprecation notice. No credentials are recorded in this document or that report.

These assets have been generated and inspected; browser playback and reactive NPC integration are separate runtime checks. Disclose AI-generated voices in the game interface when they are enabled.

Official reference: [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech).
