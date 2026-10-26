# scripts

## `clone_voices.py`: make the blind-test clones

The listening test plays the same nine reference voices through four TTS
systems. Our column (AssemblyAI) uses the existing library voices. The other
three need a clone of each reference recording. This script makes those 27
instant clones and writes their ids into `study/voice-ids.json`.

```sh
CLIPS=/path/to/clips-pcm16          # holds <slug>.wav for every voice

uv run scripts/clone_voices.py --clips "$CLIPS" --dry-run    # plan only, no network, no keys needed
uv run scripts/clone_voices.py --clips "$CLIPS"              # clone every blank cell
uv run scripts/clone_voices.py --clips "$CLIPS" --only elevenlabs --voice aai-kyla
uv run scripts/clone_voices.py --verify                      # one test line per clone -> voice-checks/
```

- **Resumable.** The script only clones a cell whose id is blank, and it writes
  each new id to the JSON as soon as it gets it. If a run fails partway, rerun
  it and it picks up the cells that are still blank.
- **No duplicates.** Each clone is named `blindtest-<slug>`. Before creating a
  clone, the script lists the account's voices. If one with that exact name
  already exists, the script reuses its id. Search the dashboards for
  `blindtest-` to find the clones and delete them later.
- **Filters.** `--only <provider>` and `--voice <slug>` can both be repeated.
- **`--verify`** runs each filled id through that provider's pinned TTS model
  with the line "Hello, thanks for calling the Harborlight Hotel." It saves the
  result as `<out>/<provider>-<slug>.wav` (default out dir `voice-checks/`) so
  you can listen to every clone. The line is English for every voice, so for
  the German and Spanish voices it also checks cross-lingual cloning.
- **`--remove-background-noise`** asks ElevenLabs and Inworld to denoise the
  clip. It's off by default because the clips are clean, and Inworld warns
  that denoising can degrade clean samples.
- The exit code is 1 if any cell failed. Each failure prints the provider, the
  HTTP status and the API's own message.

### Keys

Keys are read from the environment first, then from the repo's `.env` (or the
file given with `--env-file`). The script prints whether each key is set and
never prints its value. API error text is also scrubbed of key values.

| Variable | Notes |
| --- | --- |
| `CARTESIA_API_KEY` | `sk_car_…` |
| `ELEVENLABS_API_KEY` | Instant voice cloning needs a paid plan (Starter or higher), and the account needs free custom-voice slots for 9 clones. |
| `INWORLD_API_KEY` | The Base64 "Basic" credential from the Inworld portal, used as is. It must have **write** access, or cloning fails with `insufficientAccessLevel`. |
| `INWORLD_WORKSPACE` | Optional. Inworld infers the workspace from the key. Set this only to force the `/workspaces/{ws}/voices:clone` path. |

Every clone lives in the account that made it. Use the same keys here as the
study server runs with.

### Testing

```sh
uv run --with pytest --with httpx pytest scripts/test_clone_voices.py
```

The tests are offline. All HTTP goes to an `httpx.MockTransport`.

### API details (checked 2026-10-26)

**Cartesia**

| | |
| --- | --- |
| Clone | `POST https://api.cartesia.ai/voices/clone`, multipart: `clip` (file), `name`, `language` (`en`/`de`/`es`), `description`. Returns `{"id": …}`. ([docs](https://docs.cartesia.ai/api-reference/voices/clone)) |
| List | `GET /voices?q=<name>&is_owner=true&limit=100`, paginated with `starting_after=<next_page>`. ([docs](https://docs.cartesia.ai/api-reference/voices/list)) |
| TTS | `POST /tts/bytes` `{model_id, transcript, voice: {id}, language, output_format: {container: "wav", encoding: "pcm_s16le", sample_rate: 24000}}`. ([docs](https://docs.cartesia.ai/api-reference/tts/bytes)) |
| Auth | `Authorization: Bearer <key>` plus `Cartesia-Version: 2026-08-14`, the only version the spec allows. |
| Model | `sonic-3.6-2026-08-27` is listed as a stable dated snapshot. ([models](https://docs.cartesia.ai/build-with-cartesia/tts-models)) |

Cartesia's clone endpoint has no mode or enhance field. It does one kind of
clone.

**ElevenLabs** (Instant Voice Cloning)

| | |
| --- | --- |
| Clone | `POST https://api.elevenlabs.io/v1/voices/add`, multipart: `name`, `files` (file), `description`, `labels`, `remove_background_noise`. Returns `{"voice_id", "requires_verification"}`. ([docs](https://elevenlabs.io/docs/api-reference/voices/ivc/create)) |
| List | `GET /v2/voices?search=<name>&page_size=100&include_total_count=false`, paginated with `next_page_token`. ([docs](https://elevenlabs.io/docs/api-reference/voices/search)) |
| TTS | `POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000` `{text, model_id}`. The script wraps the raw PCM in a WAV header. ([docs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)) |
| Auth | `xi-api-key: <key>` |
| Model | `eleven_v4_turbo` is listed. ([models](https://elevenlabs.io/docs/overview/models)) |

IVC has no language field. The docs say `labels` keys "can be language, accent,
gender, or age", so the script sends `labels={"language": "<code>"}` as a JSON
string. **This is ambiguous:** the reference doesn't say whether `labels` is a
JSON-encoded string or something else in multipart. If a clone fails with a 422
on `labels`, this is the place to look. The docs ask for at least 10 s of audio
in total, and each clip meets that. They recommend 1 to 2 minutes, so expect
some quality loss from ~12 s clips.
([IVC guide](https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning))

**Inworld** (instant clone, `source: "IVC"`)

| | |
| --- | --- |
| Clone | `POST https://api.inworld.ai/voices/v1/voices:clone`, JSON: `displayName`, `languageCode` (`en`/`de`/`es`), `description`, `tags`, `voiceSamples: [{audioData: <base64 WAV>}]`. Returns `voice.voiceId` (`{workspace}__{voice}`) plus per-sample `warnings`/`errors`, which the script prints or fails on. ([docs](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice)) |
| List | `GET /voices/v1/voices?filter=owned = "true"&pageSize=2000`, matched on `displayName`, paginated with `nextPageToken`. ([docs](https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/list-voices)) |
| TTS | `POST /tts/v1/voice` `{text, voiceId, modelId, audioConfig: {audioEncoding: "LINEAR16", sampleRateHertz: 24000}}`. Returns base64 `audioContent` with a WAV header. ([docs](https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech)) |
| Auth | `Authorization: Basic <key>` |
| Model | `inworld-tts-2-flash` is listed, and both TTS-2 models support instant clones. ([models](https://docs.inworld.ai/tts/tts-models)) |

No transcription is sent, so Inworld generates one. Inworld recommends 10 to
30 s of audio and keeps at most 15 s of the processed sample.
