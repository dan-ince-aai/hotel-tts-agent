"""Offline tests for clone_voices.py. No network: every HTTP call goes to an httpx.MockTransport.

    uv run --with pytest --with httpx pytest scripts/test_clone_voices.py
"""

from __future__ import annotations

import base64
import json
import shutil
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clone_voices as cv  # noqa: E402

REAL_IDS = Path(__file__).resolve().parent.parent / "study" / "voice-ids.json"
NO_KEYS: dict[str, str] = {}
ALL_KEYS = {"CARTESIA_API_KEY": "sk_car_secret123", "ELEVENLABS_API_KEY": "el_secret456", "INWORLD_API_KEY": "aW53b3JsZDpzZWNyZXQ="}


@pytest.fixture
def ids(tmp_path: Path) -> Path:
    p = tmp_path / "voice-ids.json"
    shutil.copy(REAL_IDS, p)
    return p


@pytest.fixture
def clips(tmp_path: Path) -> Path:
    d = tmp_path / "clips"
    d.mkdir()
    for v in json.loads(REAL_IDS.read_text())["voices"]:
        (d / f"{v['slug']}.wav").write_bytes(cv.pcm16_to_wav(b"\x00\x00" * 100) + v["slug"].encode())
    return d


def no_network():
    raise AssertionError("network client created")


def mock_factory(handler):
    calls: list[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return handler(req)

    return (lambda: httpx.Client(transport=httpx.MockTransport(wrapped))), calls


def multipart_fields(req: httpx.Request) -> dict[str, bytes]:
    """Crude multipart parse: field name -> raw value."""
    ctype = req.headers["content-type"]
    boundary = ctype.split("boundary=")[1].encode()
    out: dict[str, bytes] = {}
    for part in req.content.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        head, body = part.split(b"\r\n\r\n", 1)
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        out[name] = body.rstrip(b"\r\n")
    return out


# --- voice-ids.json -------------------------------------------------------


def test_committed_file_shape_and_roundtrip():
    data = cv.load_ids(REAL_IDS)
    assert [v["slug"] for v in data["voices"]][:2] == ["aai-audrey", "aai-ewald"]
    assert len(data["voices"]) == 9
    assert all(v[p] == "" for v in data["voices"] for p in cv.PROVIDERS)
    assert {v["language"] for v in data["voices"]} == {"en", "de", "es"}
    assert cv.dump_ids(data) == REAL_IDS.read_text()


def test_save_ids_writes_atomically(ids: Path):
    data = cv.load_ids(ids)
    data["voices"][0]["cartesia"] = "abc"
    cv.save_ids(ids, data)
    assert cv.load_ids(ids)["voices"][0]["cartesia"] == "abc"
    assert not ids.with_suffix(".json.tmp").exists()


def test_load_ids_rejects_bad_files(tmp_path: Path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({"voices": [{"slug": "a", "name": "A", "language": "en", "ours": "1"}]}))
    with pytest.raises(ValueError, match="cartesia"):
        cv.load_ids(p)
    row = {"slug": "a", "name": "A", "language": "en", "ours": "1", "cartesia": "", "elevenlabs": "", "inworld": ""}
    p.write_text(json.dumps({"voices": [row, row]}))
    with pytest.raises(ValueError, match="duplicate"):
        cv.load_ids(p)


# --- planning -------------------------------------------------------------


def test_plan_skips_filled_and_filters(ids: Path, clips: Path):
    data = cv.load_ids(ids)
    data["voices"][0]["cartesia"] = "already"
    todo, done = cv.plan_clones(data, clips)
    assert len(todo) == 26 and done == [("aai-audrey", "cartesia", "already")]
    assert todo[0] == cv.Task("aai-audrey", "elevenlabs", "en", clips / "aai-audrey.wav")

    todo, _ = cv.plan_clones(data, clips, ["inworld"], ["aai-magdalena", "aai-malvina"])
    assert [(t.slug, t.provider, t.language) for t in todo] == [
        ("aai-magdalena", "inworld", "de"),
        ("aai-malvina", "inworld", "es"),
    ]
    with pytest.raises(SystemExit, match="unknown --voice"):
        cv.plan_clones(data, clips, None, ["nobody"])


def test_plan_verify_only_filled(ids: Path):
    data = cv.load_ids(ids)
    data["voices"][1]["inworld"] = "ws__v"
    assert cv.plan_verify(data) == [("aai-ewald", "inworld", "ws__v")]
    assert cv.plan_verify(data, ["cartesia"]) == []


def test_clone_name():
    assert cv.clone_name("aai-audrey") == "blindtest-aai-audrey"


# --- keys -----------------------------------------------------------------


def test_load_keys_env_wins_and_blank_falls_back(tmp_path: Path):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\nCARTESIA_API_KEY=from_file\nexport ELEVENLABS_API_KEY=\"quoted\"\n"
        "INWORLD_API_KEY=  # nothing\nOTHER=x\n"
    )
    keys = cv.load_keys(env, {"CARTESIA_API_KEY": "from_env", "ELEVENLABS_API_KEY": ""})
    assert keys == {"CARTESIA_API_KEY": "from_env", "ELEVENLABS_API_KEY": "quoted"}
    assert cv.load_keys(tmp_path / "missing.env", {}) == {}


def test_redactor():
    r = cv.Redactor(["sk_car_secret123", "abc"])
    assert r("bad key sk_car_secret123 abc") == "bad key *** abc"


# --- dry run --------------------------------------------------------------


def test_dry_run_without_keys_makes_no_calls(ids: Path, clips: Path, capsys):
    rc = cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent", "--dry-run"],
                 environ=NO_KEYS, http_factory=no_network)
    out = capsys.readouterr().out
    assert rc == 0
    assert "27 clone(s) planned" in out
    assert "CARTESIA_API_KEY not set" in out
    assert "blindtest-aai-antonioluis (language=es)" in out
    assert ids.read_text() == REAL_IDS.read_text()


def test_dry_run_filters_and_flags_missing_clip(ids: Path, clips: Path, capsys):
    (clips / "aai-kyla.wav").unlink()
    cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent", "--dry-run",
             "--only", "elevenlabs", "--voice", "aai-kyla", "--voice", "aai-steven"],
            environ=ALL_KEYS, http_factory=no_network)
    out = capsys.readouterr().out
    assert "2 clone(s) planned" in out
    assert "MISSING CLIP" in out and out.count("would") == 2
    assert "sk_car_secret123" not in out


def test_verify_dry_run(ids: Path, capsys):
    data = cv.load_ids(ids)
    data["voices"][0]["cartesia"] = "c1"
    cv.save_ids(ids, data)
    cv.main(["--verify", "--dry-run", "--ids", str(ids), "--env-file", "/nonexistent", "--out", "chk"],
            environ=NO_KEYS, http_factory=no_network)
    out = capsys.readouterr().out
    assert "chk/cartesia-aai-audrey.wav" in out and "sonic-3.6-2026-08-27" in out


def test_clips_required_unless_verify():
    with pytest.raises(SystemExit):
        cv.parse_args([])


# --- live path against mocked APIs ---------------------------------------


def fake_apis(req: httpx.Request) -> httpx.Response:
    url = req.url
    if url.host == "api.cartesia.ai":
        assert req.headers["authorization"] == "Bearer sk_car_secret123"
        assert req.headers["cartesia-version"] == cv.CARTESIA_VERSION
        if req.method == "GET" and url.path == "/voices":
            name = url.params["q"]
            if name == "blindtest-aai-audrey":  # an earlier run already made this one
                return httpx.Response(200, json={"data": [{"id": "cart-existing", "name": name},
                                                          {"id": "x", "name": name + "-old"}],
                                                 "has_more": False, "next_page": None})
            return httpx.Response(200, json={"data": [], "has_more": False, "next_page": None})
        if req.method == "POST" and url.path == "/voices/clone":
            f = multipart_fields(req)
            assert f["language"] in (b"en", b"de", b"es") and f["clip"].startswith(b"RIFF")
            return httpx.Response(200, json={"id": "cart-" + f["name"].decode(), "name": f["name"].decode()})
    if url.host == "api.elevenlabs.io":
        assert req.headers["xi-api-key"] == "el_secret456"
        if req.method == "GET" and url.path == "/v2/voices":
            return httpx.Response(200, json={"voices": [], "has_more": False, "total_count": 0})
        if req.method == "POST" and url.path == "/v1/voices/add":
            f = multipart_fields(req)
            assert json.loads(f["labels"])["language"] in ("en", "de", "es")
            assert f["remove_background_noise"] == b"false"
            assert f["files"].startswith(b"RIFF")
            return httpx.Response(200, json={"voice_id": "el-" + f["name"].decode(), "requires_verification": False})
    if url.host == "api.inworld.ai":
        assert req.headers["authorization"] == "Basic aW53b3JsZDpzZWNyZXQ="
        if req.method == "GET" and url.path == "/voices/v1/voices":
            assert url.params["filter"] == 'owned = "true"'
            return httpx.Response(200, json={"voices": [], "nextPageToken": ""})
        if req.method == "POST" and url.path == "/voices/v1/voices:clone":
            body = json.loads(req.content)
            if body["displayName"] == "blindtest-aai-carrie":
                return httpx.Response(400, json={"code": 3, "message": "audio too short (key aW53b3JsZDpzZWNyZXQ=)"})
            assert body["languageCode"] in ("en", "de", "es")
            assert base64.b64decode(body["voiceSamples"][0]["audioData"]).startswith(b"RIFF")
            assert "transcription" not in body["voiceSamples"][0]
            assert "audioProcessingConfig" not in body
            return httpx.Response(200, json={
                "voice": {"voiceId": "ws__" + body["displayName"], "displayName": body["displayName"], "source": "IVC"},
                "audioSamplesValidated": [{"warnings": [], "errors": []}],
            })
    return httpx.Response(404, json={"message": f"unexpected {req.method} {url}"})


def test_full_run_writes_back_reuses_and_reports_failures(ids: Path, clips: Path, capsys):
    factory, calls = mock_factory(fake_apis)
    rc = cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent"],
                 environ=ALL_KEYS, http_factory=factory)
    captured = capsys.readouterr()
    assert rc == 1  # one inworld clone failed
    data = cv.load_ids(ids)
    audrey = data["voices"][0]
    assert audrey["cartesia"] == "cart-existing"  # reused, not duplicated
    assert audrey["elevenlabs"] == "el-blindtest-aai-audrey"
    assert audrey["inworld"] == "ws__blindtest-aai-audrey"
    carrie = next(v for v in data["voices"] if v["slug"] == "aai-carrie")
    assert carrie["inworld"] == "" and carrie["cartesia"] == "cart-blindtest-aai-carrie"
    assert not any(r.method == "POST" and r.url.path == "/voices/clone" and b"blindtest-aai-audrey" in r.content
                   for r in calls)
    assert "inworld clone: HTTP 400: audio too short" in captured.err
    assert "aW53b3JsZDpzZWNyZXQ=" not in captured.out + captured.err  # key redacted
    assert "created         25" in captured.out and "reused          1" in captured.out
    # The file keeps its one-voice-per-line layout.
    assert ids.read_text().count("\n") == REAL_IDS.read_text().count("\n")

    # Rerun: only the failed cell is attempted.
    factory2, calls2 = mock_factory(fake_apis)
    cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent"],
            environ=ALL_KEYS, http_factory=factory2)
    assert {(r.method, r.url.host) for r in calls2} == {("GET", "api.inworld.ai"), ("POST", "api.inworld.ai")}
    assert "already filled  26" in capsys.readouterr().out


def test_missing_key_fails_only_that_provider(ids: Path, clips: Path, capsys):
    factory, calls = mock_factory(fake_apis)
    keys = {k: v for k, v in ALL_KEYS.items() if k != "ELEVENLABS_API_KEY"}
    rc = cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent", "--voice", "aai-kyla"],
                 environ=keys, http_factory=factory)
    assert rc == 1
    kyla = next(v for v in cv.load_ids(ids)["voices"] if v["slug"] == "aai-kyla")
    assert kyla["elevenlabs"] == "" and kyla["cartesia"] and kyla["inworld"]
    assert "ELEVENLABS_API_KEY is not set" in capsys.readouterr().out
    assert all(r.url.host != "api.elevenlabs.io" for r in calls)


def test_inworld_workspace_path_and_noise_flag(ids: Path, clips: Path):
    seen = []

    def handler(req):
        seen.append(req)
        if req.method == "GET":
            return httpx.Response(200, json={"voices": [], "nextPageToken": ""})
        body = json.loads(req.content)
        assert body["audioProcessingConfig"] == {"removeBackgroundNoise": True}
        return httpx.Response(200, json={"voice": {"voiceId": "myws__v"}})

    factory, _ = mock_factory(handler)
    cv.main(["--clips", str(clips), "--ids", str(ids), "--env-file", "/nonexistent", "--only", "inworld",
             "--voice", "aai-audrey", "--remove-background-noise"],
            environ={**ALL_KEYS, "INWORLD_WORKSPACE": "myws"}, http_factory=factory)
    assert seen[-1].url.path == "/voices/v1/workspaces/myws/voices:clone"


def test_pagination_finds_existing_on_later_page():
    pages = iter([
        {"voices": [{"voice_id": "a", "name": "other"}], "has_more": True, "next_page_token": "t2"},
        {"voices": [{"voice_id": "b", "name": "blindtest-aai-kyla"}], "has_more": False, "next_page_token": None},
    ])
    tokens = []

    def handler(req):
        tokens.append(req.url.params.get("next_page_token"))
        return httpx.Response(200, json=next(pages))

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        p = cv.make_provider("elevenlabs", ALL_KEYS, http)
        assert p.find_existing("blindtest-aai-kyla") == ["b"]
    assert tokens == [None, "t2"]


# --- verify ---------------------------------------------------------------


def test_verify_writes_wavs(ids: Path, tmp_path: Path):
    data = cv.load_ids(ids)
    data["voices"][0].update(cartesia="c1", elevenlabs="e1", inworld="ws__i1")
    cv.save_ids(ids, data)
    wav = cv.pcm16_to_wav(b"\x01\x00" * 10)

    def handler(req):
        if req.url.host == "api.cartesia.ai":
            body = json.loads(req.content)
            assert body["model_id"] == "sonic-3.6-2026-08-27" and body["voice"] == {"id": "c1"}
            assert body["transcript"] == cv.VERIFY_TEXT
            return httpx.Response(200, content=wav)
        if req.url.host == "api.elevenlabs.io":
            assert req.url.path == "/v1/text-to-speech/e1" and req.url.params["output_format"] == "pcm_24000"
            assert json.loads(req.content)["model_id"] == "eleven_v4_turbo"
            return httpx.Response(200, content=b"\x02\x00" * 10)  # raw PCM
        body = json.loads(req.content)
        assert body["modelId"] == "inworld-tts-2-flash" and body["voiceId"] == "ws__i1"
        return httpx.Response(200, json={"audioContent": base64.b64encode(wav).decode()})

    factory, _ = mock_factory(handler)
    out = tmp_path / "checks"
    rc = cv.main(["--verify", "--ids", str(ids), "--env-file", "/nonexistent", "--out", str(out)],
                 environ=ALL_KEYS, http_factory=factory)
    assert rc == 0
    files = sorted(p.name for p in out.iterdir())
    assert files == ["cartesia-aai-audrey.wav", "elevenlabs-aai-audrey.wav", "inworld-aai-audrey.wav"]
    el = (out / "elevenlabs-aai-audrey.wav").read_bytes()
    assert el[:4] == b"RIFF" and el.endswith(b"\x02\x00" * 10)


# --- error messages -------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"detail": {"status": "voice_limit_reached", "message": "You have reached your voice limit"}},
         "You have reached your voice limit"),
        ({"detail": [{"loc": ["body", "name"], "msg": "field required"}]}, "body.name: field required"),
        ({"code": 7, "message": "Required access level: write (rw)"}, "Required access level: write (rw)"),
        ({"error": "Invalid language"}, "Invalid language"),
    ],
)
def test_api_message(body, expected):
    assert cv.api_message(httpx.Response(400, json=body)) == expected


def test_api_message_plain_text():
    assert cv.api_message(httpx.Response(502, text="Bad Gateway")) == "Bad Gateway"


def test_pcm16_to_wav_header():
    w = cv.pcm16_to_wav(b"\x00\x00" * 24000)
    assert w[:4] == b"RIFF" and w[8:12] == b"WAVE" and len(w) == 44 + 48000
    assert int.from_bytes(w[24:28], "little") == 24000
