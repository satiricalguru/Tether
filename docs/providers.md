# Model servers

Tether talks to model servers running on your own machine (or, with your
permission, on your local network). It never contacts anything else. This
page covers setup for each supported backend and how to fix the problems the
**Setup Doctor** reports.

Open the Doctor from the stethoscope button in the side panel, or under
_Settings → Models_. It probes every known port in parallel (1.2 s timeout)
and labels each backend **Connected**, **Not running**, **Blocked by origin
check**, **Not responding**, **Needs permission**, **API key required** or
**Unexpected server**, with the exact fix.

| Backend                          | Default URL              | Detected by                                        |
| -------------------------------- | ------------------------ | -------------------------------------------------- |
| Ollama                           | `http://127.0.0.1:11434` | `GET /api/version` + a POST probe (see below)      |
| LM Studio                        | `http://127.0.0.1:1234`  | `GET /api/v0/models`, falling back to `/v1/models` |
| llama.cpp server                 | `http://127.0.0.1:8080`  | `GET /props`                                       |
| vLLM                             | `http://127.0.0.1:8000`  | `GET /v1/models`                                   |
| Jan                              | `http://127.0.0.1:1337`  | `GET /v1/models`                                   |
| KoboldCpp                        | `http://127.0.0.1:5001`  | `GET /v1/models`                                   |
| text-generation-webui / TabbyAPI | `http://127.0.0.1:5000`  | `GET /v1/models`                                   |

Ports overlap (LocalAI also uses `:8080`), so Tether fingerprints what
answers instead of assuming. A server on `:8080` without `/props` is added as
a generic OpenAI-compatible endpoint, not as llama.cpp.

---

## Ollama

```sh
ollama serve            # or just open the Ollama app
ollama pull llama3.2    # any model; qwen3:8b is a good agent default
```

### "Blocked by origin check" (the CORS problem)

Ollama rejects requests from origins it doesn't know with **HTTP 403 and an
empty body**. Browser extensions are not in its default allowlist, so out of
the box Ollama answers Tether's health check and then refuses every chat.

Tether's requests come from the background service worker, which has host
permissions for `localhost`, `127.0.0.1` and `[::1]`, so the _browser_ never
blocks them. It is Ollama itself checking the `Origin` header.

**A subtlety the Doctor handles for you:** Chrome only sends the extension's
`Origin` header on **POST** requests from the service worker, not on GET. A
naive GET health check therefore succeeds while every `/api/chat` POST fails.
Tether's health check follows the GET with a cheap POST probe
(`/api/show` for a model that doesn't exist, where 404 means allowed and 403
means blocked).

Fix it by setting `OLLAMA_ORIGINS`. The Doctor shows these with **your
extension's real ID** filled in. `chrome-extension://*` allows every
extension; the exact ID allows only Tether.

**macOS** (Ollama app):

```sh
launchctl setenv OLLAMA_ORIGINS "chrome-extension://<your-extension-id>"
```

Then quit Ollama from the menu bar and open it again. `launchctl setenv` does
not survive a reboot, so run it again after logging in (for example from a
login item).

**Linux** (systemd):

```sh
sudo systemctl edit ollama.service
```

Add:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://<your-extension-id>"
```

Then:

```sh
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

**Windows**:

```bat
setx OLLAMA_ORIGINS "chrome-extension://<your-extension-id>"
```

Quit Ollama from the system tray and start it again. `setx` affects new
processes only.

**Running `ollama serve` yourself:**

```sh
OLLAMA_ORIGINS="chrome-extension://<your-extension-id>" ollama serve
```

Firefox uses `moz-extension://<uuid>`; the Doctor shows the right one.

### Native API vs OpenAI-compatible

Tether uses Ollama's native `/api/chat` (NDJSON streaming, `think`, `format`
with JSON Schema, accurate load/eval timings). Each Ollama endpoint has a
toggle to use `/v1/chat/completions` instead, for debugging or proxies that
only speak OpenAI.

### Models shown as "hot"

Models in `GET /api/ps` are already in memory and answer immediately. Others
need a cold load first (seconds to a minute). Tether shows **"Loading model
into memory…"** instead of a spinner that looks hung, and reports the load
time Ollama measured. Settings → Models can unload a hot model
(`keep_alive: 0`).

---

## LM Studio

Start the server from the **Developer** tab (switch _Status_ to Running), or:

```sh
lms server start --port 1234
```

Tether uses LM Studio's richer `/api/v0/models` listing for model type
(LLM / VLM / embeddings), loaded state, quantization and maximum context. On
builds without it, it falls back to `/v1/models`.

LM Studio loads models just in time: asking for a model that isn't loaded
starts a load that can take 10–60 s. Tether knows the model wasn't loaded and
shows the loading state.

LM Studio doesn't check the `Origin` header, so no CORS setup is needed. If
you've put it behind something that does, the Doctor reports the 403.

Structured output uses `response_format: json_schema`; LM Studio has no GBNF
grammar parameter on its OpenAI endpoint.

---

## llama.cpp server

```sh
llama-server -m ./model.gguf --port 8080 --jinja
```

- `--jinja` uses the model's own chat template and is **required for native
  tool calling**. Without it the server answers requests that include `tools`
  with HTTP 500 "tools param requires --jinja flag". Tether recognizes this,
  remembers that the model can't take native tools, and falls back to
  constrained decoding.
- `/props` gives the context size the server actually allocated (`n_ctx`),
  which is the real limit, plus vision support and the build number.
- llama.cpp supports GBNF `grammar` and `json_schema`. This is Tether's
  strongest constrained-decoding path, and it's preferred for agent mode
  when available.
- While the model is still loading, `/props` returns 503 and the Doctor
  shows "llama.cpp is still loading the model".
- Add `--embeddings` to use the same server for local RAG.

---

## vLLM and other OpenAI-compatible servers

```sh
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000 \
  --enable-auto-tool-choice --tool-call-parser hermes
```

Any server that implements `/v1/models` and `/v1/chat/completions` works:
LocalAI, Jan, KoboldCpp, text-generation-webui, TabbyAPI or your own. Add it
under _Settings → Models → Add endpoint_.

- **Base URL**: `http://host:port` or `http://host:port/v1`; both work.
- **API key**: optional. It's sent as `Authorization: Bearer …`, stored only
  in this browser profile (`chrome.storage.local`), never logged, and never
  sent back to the UI.
- **Capabilities can't be probed**, so Tether starts optimistic and learns:
  - A 400/422 on a request with `tools` marks that model as having no native
    tools. This is remembered, and the agent uses a text protocol for it
    from then on. Context-length errors don't trigger this.
  - A 400 mentioning `stream_options` makes Tether stop asking for usage
    stats from that model and retry once without them.

  If you upgrade the server, reset these from the endpoint's edit panel
  (**Forget learned limits**).

### Servers on another machine

A base URL that isn't `localhost` / `127.0.0.1` / `[::1]` needs your
permission. Tether asks for access to that one origin when you add it (or from
the Doctor's **Allow** button). It never requests access to all sites for
this. Without the permission the Doctor reports **Needs permission** and no
request is made.

---

## What leaves your machine

Nothing. Every request goes through a single HTTP client in the background
worker that refuses any origin not in your configured endpoint list (plus the
fixed discovery ports on 127.0.0.1). The built bundle is scanned in CI for
URL literals, and any host that isn't local fails the build.

## Troubleshooting

| Doctor says             | Meaning                             | Fix                                                                           |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Not running             | Connection refused                  | Start the server. The Doctor shows the command.                               |
| Not responding          | Connected, no answer within 1.2 s   | The server is busy (loading a model) or a firewall is holding the connection. |
| Blocked by origin check | HTTP 403 with an empty body         | `OLLAMA_ORIGINS`, see above.                                                  |
| Needs permission        | Non-local host without a grant      | Click **Allow**.                                                              |
| API key required        | HTTP 401                            | Edit the endpoint and set the key.                                            |
| Unexpected server       | Port answers, but not with that API | Wrong port or wrong type. Edit the endpoint.                                  |
| Server error            | Any other HTTP error                | The server's own message is shown.                                            |
