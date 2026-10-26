# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.27,<1"]
# ///
"""Clone the blind-test reference voices into Cartesia, ElevenLabs and Inworld.

Each of the nine reference recordings becomes an instant (zero-shot) clone in
every competitor account, named ``blindtest-<slug>``. The resulting voice ids are
written into ``study/voice-ids.json`` one at a time, so an interrupted run loses
nothing and a rerun only does what is still blank.

    uv run scripts/clone_voices.py --clips <dir> --dry-run
    uv run scripts/clone_voices.py --clips <dir>
    uv run scripts/clone_voices.py --clips <dir> --only inworld --voice aai-kyla
    uv run scripts/clone_voices.py --verify            # writes voice-checks/*.wav

Keys come from the environment or the repo's ``.env``: CARTESIA_API_KEY,
ELEVENLABS_API_KEY, INWORLD_API_KEY (and optionally INWORLD_WORKSPACE). See
scripts/README.md for the API details and doc links.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IDS = REPO_ROOT / "study" / "voice-ids.json"
DEFAULT_ENV = REPO_ROOT / ".env"

PROVIDERS = ("cartesia", "elevenlabs", "inworld")

# The models the study pins (voices.ts SYSTEM_MODEL). All three are listed in
# the providers' model docs as of 2026-10 (see scripts/README.md).
MODELS = {
    "cartesia": "sonic-3.6-2026-08-27",
    "elevenlabs": "eleven_v4_turbo",
    "inworld": "inworld-tts-2-flash",
}

KEY_VARS = {
    "cartesia": "CARTESIA_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "inworld": "INWORLD_API_KEY",
}

VERIFY_TEXT = "Hello, thanks for calling the Harborlight Hotel."
VERIFY_SAMPLE_RATE = 24_000

CARTESIA_BASE = "https://api.cartesia.ai"
CARTESIA_VERSION = "2026-08-14"
ELEVENLABS_BASE = "https://api.elevenlabs.io"
INWORLD_BASE = "https://api.inworld.ai"


# --------------------------------------------------------------------------
# voice-ids.json


def load_ids(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    voices = data.get("voices")
    if not isinstance(voices, list):
        raise ValueError(f"{path}: expected an object with a 'voices' list")
    seen: set[str] = set()
    for i, v in enumerate(voices):
        for k in ("slug", "name", "language", "ours", *PROVIDERS):
            if not isinstance(v.get(k), str):
                raise ValueError(f"{path}: voices[{i}] is missing string field '{k}'")
        if v["slug"] in seen:
            raise ValueError(f"{path}: duplicate slug '{v['slug']}'")
        seen.add(v["slug"])
    return data


def dump_ids(data: dict[str, Any]) -> str:
    """One voice per line, matching the committed file so diffs stay one line per clone."""
    lines = []
    for v in data["voices"]:
        inner = json.dumps(v, ensure_ascii=False, separators=(", ", ": "))[1:-1]
        lines.append("    { " + inner + " }")
    extra = {k: v for k, v in data.items() if k != "voices"}
    head = "".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n" for k, v in extra.items())
    return "{\n" + head + '  "voices": [\n' + ",\n".join(lines) + "\n  ]\n}\n"


def save_ids(path: Path, data: dict[str, Any]) -> None:
    """Atomic write: a crash mid-write never leaves a truncated file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(dump_ids(data), encoding="utf-8")
    os.replace(tmp, path)


def clone_name(slug: str) -> str:
    return f"blindtest-{slug}"


# --------------------------------------------------------------------------
# keys


def parse_env_file(path: Path) -> dict[str, str]:
    """Minimal .env reader: KEY=VALUE, optional `export`, quotes, # comments."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif value.startswith("#"):
            value = ""
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        out[key] = value
    return out


def load_keys(env_file: Path, environ: dict[str, str] | None = None) -> dict[str, str]:
    """Process env wins; the .env file fills anything unset or blank."""
    environ = dict(os.environ) if environ is None else environ
    file_vals = parse_env_file(env_file)
    names = [*KEY_VARS.values(), "INWORLD_WORKSPACE"]
    keys = {}
    for name in names:
        val = (environ.get(name) or "").strip() or (file_vals.get(name) or "").strip()
        if val:
            keys[name] = val
    return keys


class Redactor:
    def __init__(self, secrets: list[str]):
        self.secrets = [s for s in secrets if len(s) >= 6]

    def __call__(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, "***")
        return text


# --------------------------------------------------------------------------
# planning


@dataclass(frozen=True)
class Task:
    slug: str
    provider: str
    language: str
    clip: Path


def select_voices(data: dict[str, Any], voices: list[str] | None) -> list[dict[str, Any]]:
    all_voices = data["voices"]
    if not voices:
        return all_voices
    known = {v["slug"] for v in all_voices}
    unknown = [s for s in voices if s not in known]
    if unknown:
        raise SystemExit(f"unknown --voice {', '.join(unknown)}; known: {', '.join(sorted(known))}")
    return [v for v in all_voices if v["slug"] in voices]


def plan_clones(
    data: dict[str, Any],
    clips: Path,
    providers: list[str] | None = None,
    voices: list[str] | None = None,
) -> tuple[list[Task], list[tuple[str, str, str]]]:
    """Return (tasks to run, cells already filled as (slug, provider, id))."""
    providers = providers or list(PROVIDERS)
    todo: list[Task] = []
    done: list[tuple[str, str, str]] = []
    for v in select_voices(data, voices):
        for p in providers:
            if v[p].strip():
                done.append((v["slug"], p, v[p]))
            else:
                todo.append(Task(v["slug"], p, v["language"], clips / f"{v['slug']}.wav"))
    return todo, done


def plan_verify(
    data: dict[str, Any], providers: list[str] | None = None, voices: list[str] | None = None
) -> list[tuple[str, str, str]]:
    providers = providers or list(PROVIDERS)
    return [
        (v["slug"], p, v[p])
        for v in select_voices(data, voices)
        for p in providers
        if v[p].strip()
    ]


# --------------------------------------------------------------------------
# providers


class ProviderError(Exception):
    def __init__(self, provider: str, what: str, status: int | None, message: str):
        self.provider, self.what, self.status, self.message = provider, what, status, message
        code = f"HTTP {status}" if status is not None else "error"
        super().__init__(f"{provider} {what}: {code}: {message}")


def api_message(resp: httpx.Response) -> str:
    """Pull the human-readable message out of each provider's error body."""
    try:
        body = resp.json()
    except ValueError:
        return (resp.text or resp.reason_phrase or "").strip()[:500]
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, dict):  # ElevenLabs: {"detail": {"status", "message"}}
            return str(detail.get("message") or detail.get("status") or detail)
        if isinstance(detail, list):  # ElevenLabs / FastAPI 422 validation list
            return "; ".join(
                f"{'.'.join(map(str, d.get('loc', [])))}: {d.get('msg')}" if isinstance(d, dict) else str(d)
                for d in detail
            )
        if detail:
            return str(detail)
        for k in ("message", "error", "title"):  # Inworld {code,message,details}; Cartesia {error|message}
            val = body.get(k)
            if isinstance(val, dict):
                val = val.get("message") or val
            if val:
                return str(val)
    return json.dumps(body)[:500]


def check(resp: httpx.Response, provider: str, what: str) -> httpx.Response:
    if resp.status_code >= 400:
        raise ProviderError(provider, what, resp.status_code, api_message(resp))
    return resp


def pcm16_to_wav(pcm: bytes, sample_rate: int = VERIFY_SAMPLE_RATE, channels: int = 1) -> bytes:
    byte_rate = sample_rate * channels * 2
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, channels * 2, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


@dataclass
class Provider:
    name: str
    key: str
    http: httpx.Client
    options: dict[str, Any] = field(default_factory=dict)

    def find_existing(self, name: str) -> list[str]:  # pragma: no cover - abstract
        raise NotImplementedError

    def clone(self, name: str, clip: bytes, filename: str, language: str, description: str) -> str:
        raise NotImplementedError  # pragma: no cover

    def synthesize(self, voice_id: str, text: str) -> bytes:
        raise NotImplementedError  # pragma: no cover


class Cartesia(Provider):
    """https://docs.cartesia.ai/api-reference/voices/clone"""

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}", "Cartesia-Version": CARTESIA_VERSION}

    def find_existing(self, name: str) -> list[str]:
        found: list[str] = []
        params: dict[str, Any] = {"q": name, "is_owner": "true", "limit": 100}
        for _ in range(50):
            r = check(self.http.get(f"{CARTESIA_BASE}/voices", params=params, headers=self.headers()),
                      self.name, "list voices")
            body = r.json()
            found += [v["id"] for v in body.get("data", []) if v.get("name") == name]
            if not body.get("has_more") or not body.get("next_page"):
                break
            params["starting_after"] = body["next_page"]
        return found

    def clone(self, name, clip, filename, language, description):
        r = self.http.post(
            f"{CARTESIA_BASE}/voices/clone",
            headers=self.headers(),
            data={"name": name, "language": language, "description": description},
            files={"clip": (filename, clip, "audio/wav")},
        )
        return check(r, self.name, "clone").json()["id"]

    def synthesize(self, voice_id, text):
        r = self.http.post(
            f"{CARTESIA_BASE}/tts/bytes",
            headers=self.headers(),
            json={
                "model_id": MODELS["cartesia"],
                "transcript": text,
                "voice": {"id": voice_id},
                "language": "en",
                "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": VERIFY_SAMPLE_RATE},
            },
        )
        return check(r, self.name, "tts").content


class ElevenLabs(Provider):
    """https://elevenlabs.io/docs/api-reference/voices/ivc/create"""

    def headers(self) -> dict[str, str]:
        return {"xi-api-key": self.key}

    def find_existing(self, name: str) -> list[str]:
        found: list[str] = []
        params: dict[str, Any] = {"search": name, "page_size": 100, "include_total_count": "false"}
        for _ in range(50):
            r = check(self.http.get(f"{ELEVENLABS_BASE}/v2/voices", params=params, headers=self.headers()),
                      self.name, "list voices")
            body = r.json()
            found += [v["voice_id"] for v in body.get("voices", []) if v.get("name") == name]
            if not body.get("has_more") or not body.get("next_page_token"):
                break
            params["next_page_token"] = body["next_page_token"]
        return found

    def clone(self, name, clip, filename, language, description):
        r = self.http.post(
            f"{ELEVENLABS_BASE}/v1/voices/add",
            headers=self.headers(),
            data={
                "name": name,
                "description": description,
                # IVC takes no language field; `labels` is the documented place for it.
                "labels": json.dumps({"language": language}),
                "remove_background_noise": "true" if self.options.get("remove_background_noise") else "false",
            },
            files=[("files", (filename, clip, "audio/wav"))],
        )
        body = check(r, self.name, "clone").json()
        if body.get("requires_verification"):
            print(f"  ! elevenlabs says {name} requires verification before it can be used", file=sys.stderr)
        return body["voice_id"]

    def synthesize(self, voice_id, text):
        r = self.http.post(
            f"{ELEVENLABS_BASE}/v1/text-to-speech/{voice_id}",
            params={"output_format": f"pcm_{VERIFY_SAMPLE_RATE}"},
            headers=self.headers(),
            json={"text": text, "model_id": MODELS["elevenlabs"]},
        )
        return pcm16_to_wav(check(r, self.name, "tts").content)


class Inworld(Provider):
    """https://docs.inworld.ai/api-reference/voiceAPI/voiceservice/clone-voice"""

    def headers(self) -> dict[str, str]:
        # The portal hands out the already-base64 "Basic" credential; tolerate a pasted prefix.
        key = self.key.strip()
        if key.lower().startswith("basic "):
            key = key[6:].strip()
        return {"Authorization": f"Basic {key}"}

    def find_existing(self, name: str) -> list[str]:
        found: list[str] = []
        params: dict[str, Any] = {"filter": 'owned = "true"', "pageSize": 2000}
        for _ in range(50):
            r = check(self.http.get(f"{INWORLD_BASE}/voices/v1/voices", params=params, headers=self.headers()),
                      self.name, "list voices")
            body = r.json()
            found += [v["voiceId"] for v in body.get("voices", []) if v.get("displayName") == name]
            token = body.get("nextPageToken")
            if not token:
                break
            params["pageToken"] = token
        return found

    def clone_url(self) -> str:
        ws = self.options.get("workspace")
        if ws:
            return f"{INWORLD_BASE}/voices/v1/workspaces/{ws}/voices:clone"
        return f"{INWORLD_BASE}/voices/v1/voices:clone"  # workspace inferred from the key

    def clone(self, name, clip, filename, language, description):
        body: dict[str, Any] = {
            "displayName": name,
            "languageCode": language,
            "description": description,
            "tags": ["blindtest"],
            # No transcription: Inworld generates one when omitted.
            "voiceSamples": [{"audioData": base64.b64encode(clip).decode("ascii")}],
        }
        if self.options.get("remove_background_noise"):
            body["audioProcessingConfig"] = {"removeBackgroundNoise": True}
        r = self.http.post(self.clone_url(), headers=self.headers(), json=body)
        out = check(r, self.name, "clone").json()
        for s in out.get("audioSamplesValidated", []) or []:
            for w in s.get("warnings", []) or []:
                print(f"  ! inworld warning for {name}: {w.get('text')}", file=sys.stderr)
            errs = [e.get("text") for e in s.get("errors", []) or []]
            if errs:
                raise ProviderError(self.name, "clone", r.status_code, "; ".join(map(str, errs)))
        return out["voice"]["voiceId"]

    def synthesize(self, voice_id, text):
        r = self.http.post(
            f"{INWORLD_BASE}/tts/v1/voice",
            headers=self.headers(),
            json={
                "text": text,
                "voiceId": voice_id,
                "modelId": MODELS["inworld"],
                "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": VERIFY_SAMPLE_RATE},
            },
        )
        audio = base64.b64decode(check(r, self.name, "tts").json()["audioContent"])
        # Non-streaming LINEAR16 already carries a WAV header; wrap only if it does not.
        return audio if audio[:4] == b"RIFF" else pcm16_to_wav(audio)


PROVIDER_CLASSES: dict[str, type[Provider]] = {
    "cartesia": Cartesia,
    "elevenlabs": ElevenLabs,
    "inworld": Inworld,
}


def make_provider(name: str, keys: dict[str, str], http: httpx.Client, **options: Any) -> Provider:
    if name == "inworld" and keys.get("INWORLD_WORKSPACE"):
        options["workspace"] = keys["INWORLD_WORKSPACE"]
    return PROVIDER_CLASSES[name](name, keys[KEY_VARS[name]], http, options)


# --------------------------------------------------------------------------
# runs


@dataclass
class Summary:
    created: list[str] = field(default_factory=list)
    reused: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    written: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def print(self, verify: bool) -> None:
        print("\nSummary")
        rows = [("already filled", self.skipped)]
        rows += [("wav written", self.written)] if verify else [("created", self.created), ("reused", self.reused)]
        rows += [("failed", self.failed)]
        for label, items in rows:
            print(f"  {label:15} {len(items)}")
        for f in self.failed:
            print(f"    - {f}")


def run_clone(args, data, keys, redact, http_factory=None) -> Summary:
    summary = Summary()
    tasks, done = plan_clones(data, args.clips, args.only, args.voice)
    summary.skipped = [f"{p}:{s}" for s, p, _ in done]
    for s, p, vid in done:
        print(f"skip   {p:10} {s:16} already {vid}")
    if not tasks:
        print("Nothing to clone.")
        return summary

    if args.dry_run:
        for t in tasks:
            notes = []
            if not t.clip.is_file():
                notes.append("MISSING CLIP")
            if KEY_VARS[t.provider] not in keys:
                notes.append(f"{KEY_VARS[t.provider]} not set")
            note = f"  [{', '.join(notes)}]" if notes else ""
            print(f"would  {t.provider:10} {t.slug:16} clone {t.clip.name} as {clone_name(t.slug)} "
                  f"(language={t.language}){note}")
        print(f"\nDry run: {len(tasks)} clone(s) planned, no network calls made.")
        return summary

    http = (http_factory or (lambda: httpx.Client(timeout=httpx.Timeout(180.0, connect=15.0))))()
    providers: dict[str, Provider] = {}
    by_slug = {v["slug"]: v for v in data["voices"]}
    try:
        for t in tasks:
            cell = f"{t.provider}:{t.slug}"
            if KEY_VARS[t.provider] not in keys:
                summary.failed.append(f"{cell}: {KEY_VARS[t.provider]} is not set")
                continue
            if not t.clip.is_file():
                summary.failed.append(f"{cell}: clip not found at {t.clip}")
                continue
            prov = providers.get(t.provider)
            if prov is None:
                prov = providers[t.provider] = make_provider(
                    t.provider, keys, http, remove_background_noise=args.remove_background_noise)
            name = clone_name(t.slug)
            v = by_slug[t.slug]
            try:
                existing = prov.find_existing(name)
                if existing:
                    vid = existing[0]
                    extra = f" ({len(existing)} found; using the first)" if len(existing) > 1 else ""
                    print(f"reuse  {t.provider:10} {t.slug:16} {vid}{extra}")
                    summary.reused.append(cell)
                else:
                    desc = f"Blind TTS listening test clone of {v['name']} ({t.slug}, {t.language})."
                    vid = prov.clone(name, t.clip.read_bytes(), t.clip.name, t.language, desc)
                    print(f"clone  {t.provider:10} {t.slug:16} {vid}")
                    summary.created.append(cell)
            except ProviderError as e:
                msg = redact(str(e))
                print(f"FAIL   {t.provider:10} {t.slug:16} {msg}", file=sys.stderr)
                summary.failed.append(f"{cell}: {msg}")
                continue
            except (httpx.HTTPError, KeyError, ValueError) as e:
                msg = redact(f"{t.provider}: {type(e).__name__}: {e}")
                print(f"FAIL   {t.provider:10} {t.slug:16} {msg}", file=sys.stderr)
                summary.failed.append(f"{cell}: {msg}")
                continue
            v[t.provider] = vid
            save_ids(args.ids, data)  # persist immediately
    finally:
        http.close()
    return summary


def run_verify(args, data, keys, redact, http_factory=None) -> Summary:
    summary = Summary()
    cells = plan_verify(data, args.only, args.voice)
    if not cells:
        print("No filled ids to verify.")
        return summary
    out: Path = args.out
    if args.dry_run:
        for s, p, vid in cells:
            note = "" if KEY_VARS[p] in keys else f"  [{KEY_VARS[p]} not set]"
            print(f"would  {p:10} {s:16} say {VERIFY_TEXT!r} with {MODELS[p]} -> {out / f'{p}-{s}.wav'}{note}")
        print(f"\nDry run: {len(cells)} check(s) planned, no network calls made.")
        return summary
    out.mkdir(parents=True, exist_ok=True)
    http = (http_factory or (lambda: httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0))))()
    providers: dict[str, Provider] = {}
    try:
        for s, p, vid in cells:
            cell = f"{p}:{s}"
            if KEY_VARS[p] not in keys:
                summary.failed.append(f"{cell}: {KEY_VARS[p]} is not set")
                continue
            prov = providers.get(p) or providers.setdefault(p, make_provider(p, keys, http))
            try:
                wav = prov.synthesize(vid, VERIFY_TEXT)
            except (ProviderError, httpx.HTTPError, KeyError, ValueError) as e:
                msg = redact(str(e) if isinstance(e, ProviderError) else f"{p}: {type(e).__name__}: {e}")
                print(f"FAIL   {p:10} {s:16} {msg}", file=sys.stderr)
                summary.failed.append(f"{cell}: {msg}")
                continue
            path = out / f"{p}-{s}.wav"
            path.write_bytes(wav)
            print(f"wrote  {p:10} {s:16} {path}")
            summary.written.append(cell)
    finally:
        http.close()
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--clips", type=Path, help="folder holding <slug>.wav reference clips (required to clone)")
    ap.add_argument("--ids", type=Path, default=DEFAULT_IDS, help="voice-ids.json (default: study/voice-ids.json)")
    ap.add_argument("--env-file", type=Path, default=DEFAULT_ENV, help="fallback .env for keys (default: repo .env)")
    ap.add_argument("--only", action="append", choices=PROVIDERS, metavar="PROVIDER",
                    help=f"limit to a provider ({', '.join(PROVIDERS)}); repeatable")
    ap.add_argument("--voice", action="append", metavar="SLUG", help="limit to a voice slug; repeatable")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; no network calls")
    ap.add_argument("--verify", action="store_true",
                    help="synthesize a test line with every filled id instead of cloning")
    ap.add_argument("--out", type=Path, default=Path("voice-checks"), help="--verify output dir (default: voice-checks/)")
    ap.add_argument("--remove-background-noise", action="store_true",
                    help="ask ElevenLabs/Inworld to denoise the clip (off: the clips are clean, and Inworld "
                         "warns it can degrade clean samples)")
    args = ap.parse_args(argv)
    if not args.verify and args.clips is None:
        ap.error("--clips is required unless --verify")
    return args


def main(argv: list[str] | None = None, environ: dict[str, str] | None = None, http_factory=None) -> int:
    args = parse_args(argv)
    data = load_ids(args.ids)
    keys = load_keys(args.env_file, environ)
    redact = Redactor(list(keys.values()))
    present = ", ".join(f"{v}={'set' if v in keys else 'missing'}" for v in KEY_VARS.values())
    print(f"keys: {present}")
    if args.verify:
        summary = run_verify(args, data, keys, redact, http_factory)
    else:
        if not args.clips.is_dir():
            print(f"warning: clips folder {args.clips} does not exist", file=sys.stderr)
        summary = run_clone(args, data, keys, redact, http_factory)
    summary.print(args.verify)
    return 1 if summary.failed else 0


if __name__ == "__main__":
    sys.exit(main())
